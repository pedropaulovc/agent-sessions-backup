import { canonicalJson, sha256 } from './migration-manifest.mjs';

function normalizeSql(sql) {
  // Preserve token text exactly: collapsing whitespace inside a quoted default or CHECK literal
  // would make distinct schemas share a digest. Row/key ordering provides the normalization.
  return sql == null ? null : sql.trim();
}

function compareText(left, right) {
  const leftText = String(left);
  const rightText = String(right);
  return leftText === rightText ? 0 : leftText < rightText ? -1 : 1;
}

function sortRows(rows, keys) {
  return rows.map((row) => {
    const sorted = {};
    for (const key of Object.keys(row).sort()) sorted[key] = row[key];
    return sorted;
  }).sort((left, right) => {
    for (const key of keys) {
      const comparison = compareText(left[key] ?? '', right[key] ?? '');
      if (comparison !== 0) return comparison;
    }
    return compareText(canonicalJson(left), canonicalJson(right));
  });
}

export function normalizeSchemaSnapshot(snapshot) {
  const objects = (snapshot.objects ?? [])
    .filter((row) => row.name !== 'd1_migrations' && !row.name.startsWith('sqlite_'))
    .map((row) => ({ ...row, sql: normalizeSql(row.sql) }));
  return {
    formatVersion: 1,
    objects: sortRows(objects, ['type', 'name']),
    tableColumns: sortRows(snapshot.tableColumns ?? [], ['table_name', 'cid']),
    indexes: sortRows(snapshot.indexes ?? [], ['table_name', 'index_name', 'seqno', 'cid']),
    foreignKeys: sortRows(snapshot.foreignKeys ?? [], ['table_name', 'id', 'seq']),
    pragmas: Object.fromEntries(Object.entries(snapshot.pragmas ?? {})
      .sort(([left], [right]) => compareText(left, right))
      .map(([name, value]) => [name, String(value)])),
  };
}

export function schemaDigest(snapshot) {
  return sha256(`${canonicalJson(normalizeSchemaSnapshot(snapshot))}\n`);
}

export function schemaSnapshotFromDatabase(database) {
  const objects = database.prepare(`
    SELECT type, name, tbl_name, sql
      FROM sqlite_master
     WHERE sql IS NOT NULL
       AND name NOT LIKE 'sqlite_%'
       AND name NOT GLOB '_cf_*'
       AND name <> 'd1_migrations'
     ORDER BY type, name
  `).all();
  const tables = database.prepare(`
    SELECT name FROM pragma_table_list()
     WHERE schema = 'main' AND type <> 'shadow'
       AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '_cf_*'
       AND name <> 'd1_migrations'
     ORDER BY name
  `).all().map((row) => row.name);
  const tableColumns = [];
  const indexes = [];
  const foreignKeys = [];
  for (const table of tables) {
    const quoted = `'${table.replaceAll("'", "''")}'`;
    for (const row of database.prepare(`PRAGMA table_xinfo(${quoted})`).all()) {
      tableColumns.push({ table_name: table, ...row });
    }
    for (const index of database.prepare(`PRAGMA index_list(${quoted})`).all()) {
      const indexName = `'${String(index.name).replaceAll("'", "''")}'`;
      const details = database.prepare(`PRAGMA index_xinfo(${indexName})`).all();
      for (const detail of details) {
        indexes.push({
          table_name: table,
          index_sequence: index.seq,
          index_name: index.name,
          unique: index.unique,
          origin: index.origin,
          partial: index.partial,
          seqno: detail.seqno,
          cid: detail.cid,
          column_name: detail.name,
          desc: detail.desc,
          coll: detail.coll,
          key: detail.key,
        });
      }
    }
    for (const row of database.prepare(`PRAGMA foreign_key_list(${quoted})`).all()) {
      foreignKeys.push({ table_name: table, ...row });
    }
  }
  return normalizeSchemaSnapshot({
    objects,
    tableColumns,
    indexes,
    foreignKeys,
    // Cloudflare D1 rejects application_id/user_version reads with SQLITE_AUTH. Keep the digest
    // portable by excluding connection-level pragmas and binding it to schema objects instead.
    pragmas: {},
  });
}
