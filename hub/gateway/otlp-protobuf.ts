// Minimal OTLP JSON → OTLP protobuf encoder.
//
// Cloudflare's Workers-observability OTLP exporter emits OTLP/HTTP **JSON**
// (`resourceLogs` / `resourceSpans`, hex-string trace/span ids, decimal-string
// nanosecond timestamps). Azure Monitor's managed OTLP/DCR ingestion endpoint
// only accepts **protobuf** (`application/json` → HTTP 415; `application/x-protobuf`
// → 202/204). This module transcodes the JSON we receive into the wire-format
// protobuf the DCR endpoint wants — no external protobuf dependency.
//
// Field numbers/wire types follow opentelemetry-proto v1
// (common.proto / resource.proto / logs.proto / trace.proto). `ExportLogsServiceRequest`
// and `LogsData` are wire-identical (both `repeated ResourceLogs = 1`), likewise
// `ExportTraceServiceRequest` / `TracesData`, so the same bytes satisfy the
// `/v1/{logs,traces}` collector endpoints.
//
// Ported from youtube-mirror's worker/otlp-protobuf.ts — logic is load-bearing
// and intentionally unchanged.

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LEN = 2;
const WIRE_FIXED32 = 5;

const encoder = new TextEncoder();

function pushTag(out: number[], field: number, wire: number): void {
  pushVarint(out, (field << 3) | wire);
}

function pushVarint(out: number[], value: number): void {
  let v = value >>> 0;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
}

// int64/uint64 varint (AnyValue.int_value). JSON carries these as decimal strings.
function pushVarintBig(out: number[], value: bigint): void {
  let v = value < 0n ? value + (1n << 64n) : value;
  while (v > 0x7fn) {
    out.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  out.push(Number(v));
}

function pushFixed64(out: number[], value: bigint): void {
  let v = value < 0n ? value + (1n << 64n) : value;
  for (let i = 0; i < 8; i++) {
    out.push(Number(v & 0xffn));
    v >>= 8n;
  }
}

function pushFixed32(out: number[], value: number): void {
  let v = value >>> 0;
  for (let i = 0; i < 4; i++) {
    out.push(v & 0xff);
    v >>>= 8;
  }
}

function pushDouble(out: number[], value: number): void {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setFloat64(0, value, true);
  for (const b of buf) out.push(b);
}

function pushLenField(out: number[], field: number, bytes: ArrayLike<number>): void {
  pushTag(out, field, WIRE_LEN);
  pushVarint(out, bytes.length);
  for (let i = 0; i < bytes.length; i++) out.push(bytes[i]!);
}

function pushStringField(out: number[], field: number, value: string): void {
  pushLenField(out, field, encoder.encode(value));
}

function pushMessageField(out: number[], field: number, msg: number[]): void {
  pushLenField(out, field, msg);
}

function pushVarintField(out: number[], field: number, value: number): void {
  pushTag(out, field, WIRE_VARINT);
  pushVarint(out, value);
}

function pushFixed64Field(out: number[], field: number, value: bigint): void {
  pushTag(out, field, WIRE_FIXED64);
  pushFixed64(out, value);
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.length % 2 === 1 ? "0" + hex : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

type Json = Record<string, unknown>;

const SEVERITY_NUMBER: Record<string, number> = {
  SEVERITY_NUMBER_UNSPECIFIED: 0, SEVERITY_NUMBER_TRACE: 1, SEVERITY_NUMBER_TRACE2: 2,
  SEVERITY_NUMBER_TRACE3: 3, SEVERITY_NUMBER_TRACE4: 4, SEVERITY_NUMBER_DEBUG: 5,
  SEVERITY_NUMBER_DEBUG2: 6, SEVERITY_NUMBER_DEBUG3: 7, SEVERITY_NUMBER_DEBUG4: 8,
  SEVERITY_NUMBER_INFO: 9, SEVERITY_NUMBER_INFO2: 10, SEVERITY_NUMBER_INFO3: 11,
  SEVERITY_NUMBER_INFO4: 12, SEVERITY_NUMBER_WARN: 13, SEVERITY_NUMBER_WARN2: 14,
  SEVERITY_NUMBER_WARN3: 15, SEVERITY_NUMBER_WARN4: 16, SEVERITY_NUMBER_ERROR: 17,
  SEVERITY_NUMBER_ERROR2: 18, SEVERITY_NUMBER_ERROR3: 19, SEVERITY_NUMBER_ERROR4: 20,
  SEVERITY_NUMBER_FATAL: 21, SEVERITY_NUMBER_FATAL2: 22, SEVERITY_NUMBER_FATAL3: 23,
  SEVERITY_NUMBER_FATAL4: 24,
};

const SPAN_KIND: Record<string, number> = {
  SPAN_KIND_UNSPECIFIED: 0, SPAN_KIND_INTERNAL: 1, SPAN_KIND_SERVER: 2,
  SPAN_KIND_CLIENT: 3, SPAN_KIND_PRODUCER: 4, SPAN_KIND_CONSUMER: 5,
};

const STATUS_CODE: Record<string, number> = {
  STATUS_CODE_UNSET: 0, STATUS_CODE_OK: 1, STATUS_CODE_ERROR: 2,
};

// OTLP JSON enums may arrive as the integer or the proto enum name.
function enumInt(value: unknown, names: Record<string, number>): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    if (value in names) return names[value]!;
    const n = Number(value);
    if (!Number.isNaN(n)) return n;
  }
  return 0;
}

function encodeAnyValue(v: Json): number[] {
  const out: number[] = [];
  if (v.stringValue !== undefined) pushStringField(out, 1, String(v.stringValue));
  else if (v.boolValue !== undefined) pushVarintField(out, 2, v.boolValue ? 1 : 0);
  else if (v.intValue !== undefined) {
    pushTag(out, 3, WIRE_VARINT);
    pushVarintBig(out, BigInt(v.intValue as string | number));
  } else if (v.doubleValue !== undefined) {
    pushTag(out, 4, WIRE_FIXED64);
    pushDouble(out, Number(v.doubleValue));
  } else if (v.arrayValue !== undefined) {
    pushMessageField(out, 5, encodeArrayValue(v.arrayValue as Json));
  } else if (v.kvlistValue !== undefined) {
    pushMessageField(out, 6, encodeKvList(v.kvlistValue as Json));
  } else if (v.bytesValue !== undefined) {
    pushLenField(out, 7, base64ToBytes(String(v.bytesValue)));
  }
  return out;
}

function encodeArrayValue(a: Json): number[] {
  const out: number[] = [];
  for (const item of (a.values as Json[]) ?? []) pushMessageField(out, 1, encodeAnyValue(item));
  return out;
}

function encodeKvList(k: Json): number[] {
  const out: number[] = [];
  for (const kv of (k.values as Json[]) ?? []) pushMessageField(out, 1, encodeKeyValue(kv));
  return out;
}

function encodeKeyValue(kv: Json): number[] {
  const out: number[] = [];
  if (kv.key !== undefined) pushStringField(out, 1, String(kv.key));
  if (kv.value !== undefined) pushMessageField(out, 2, encodeAnyValue(kv.value as Json));
  return out;
}

function encodeAttributes(out: number[], field: number, attrs: unknown): void {
  for (const a of (attrs as Json[]) ?? []) pushMessageField(out, field, encodeKeyValue(a));
}

function encodeResource(r: Json): number[] {
  const out: number[] = [];
  encodeAttributes(out, 1, r.attributes);
  if (r.droppedAttributesCount) pushVarintField(out, 2, Number(r.droppedAttributesCount));
  return out;
}

function encodeScope(s: Json): number[] {
  const out: number[] = [];
  if (s.name) pushStringField(out, 1, String(s.name));
  if (s.version) pushStringField(out, 2, String(s.version));
  encodeAttributes(out, 3, s.attributes);
  if (s.droppedAttributesCount) pushVarintField(out, 4, Number(s.droppedAttributesCount));
  return out;
}

function encodeLogRecord(lr: Json): number[] {
  const out: number[] = [];
  if (lr.timeUnixNano) pushFixed64Field(out, 1, BigInt(lr.timeUnixNano as string));
  if (lr.severityNumber !== undefined) pushVarintField(out, 2, enumInt(lr.severityNumber, SEVERITY_NUMBER));
  if (lr.severityText) pushStringField(out, 3, String(lr.severityText));
  if (lr.body !== undefined) pushMessageField(out, 5, encodeAnyValue(lr.body as Json));
  encodeAttributes(out, 6, lr.attributes);
  if (lr.droppedAttributesCount) pushVarintField(out, 7, Number(lr.droppedAttributesCount));
  if (lr.flags) {
    pushTag(out, 8, WIRE_FIXED32);
    pushFixed32(out, Number(lr.flags));
  }
  if (lr.traceId) pushLenField(out, 9, hexToBytes(String(lr.traceId)));
  if (lr.spanId) pushLenField(out, 10, hexToBytes(String(lr.spanId)));
  if (lr.observedTimeUnixNano) pushFixed64Field(out, 11, BigInt(lr.observedTimeUnixNano as string));
  return out;
}

function encodeScopeLogs(sl: Json): number[] {
  const out: number[] = [];
  if (sl.scope) pushMessageField(out, 1, encodeScope(sl.scope as Json));
  for (const lr of (sl.logRecords as Json[]) ?? []) pushMessageField(out, 2, encodeLogRecord(lr));
  if (sl.schemaUrl) pushStringField(out, 3, String(sl.schemaUrl));
  return out;
}

function encodeResourceLogs(rl: Json): number[] {
  const out: number[] = [];
  if (rl.resource) pushMessageField(out, 1, encodeResource(rl.resource as Json));
  for (const sl of (rl.scopeLogs as Json[]) ?? []) pushMessageField(out, 2, encodeScopeLogs(sl));
  if (rl.schemaUrl) pushStringField(out, 3, String(rl.schemaUrl));
  return out;
}

export function encodeLogsRequest(json: Json): Uint8Array {
  const out: number[] = [];
  for (const rl of (json.resourceLogs as Json[]) ?? []) pushMessageField(out, 1, encodeResourceLogs(rl));
  return Uint8Array.from(out);
}

function encodeStatus(s: Json): number[] {
  const out: number[] = [];
  if (s.message) pushStringField(out, 2, String(s.message));
  if (s.code !== undefined) pushVarintField(out, 3, enumInt(s.code, STATUS_CODE));
  return out;
}

function encodeEvent(e: Json): number[] {
  const out: number[] = [];
  if (e.timeUnixNano) pushFixed64Field(out, 1, BigInt(e.timeUnixNano as string));
  if (e.name) pushStringField(out, 2, String(e.name));
  encodeAttributes(out, 3, e.attributes);
  if (e.droppedAttributesCount) pushVarintField(out, 4, Number(e.droppedAttributesCount));
  return out;
}

function encodeLink(l: Json): number[] {
  const out: number[] = [];
  if (l.traceId) pushLenField(out, 1, hexToBytes(String(l.traceId)));
  if (l.spanId) pushLenField(out, 2, hexToBytes(String(l.spanId)));
  if (l.traceState) pushStringField(out, 3, String(l.traceState));
  encodeAttributes(out, 4, l.attributes);
  if (l.droppedAttributesCount) pushVarintField(out, 5, Number(l.droppedAttributesCount));
  if (l.flags) {
    pushTag(out, 6, WIRE_FIXED32);
    pushFixed32(out, Number(l.flags));
  }
  return out;
}

function encodeSpan(sp: Json): number[] {
  const out: number[] = [];
  if (sp.traceId) pushLenField(out, 1, hexToBytes(String(sp.traceId)));
  if (sp.spanId) pushLenField(out, 2, hexToBytes(String(sp.spanId)));
  if (sp.traceState) pushStringField(out, 3, String(sp.traceState));
  if (sp.parentSpanId) pushLenField(out, 4, hexToBytes(String(sp.parentSpanId)));
  if (sp.name) pushStringField(out, 5, String(sp.name));
  if (sp.kind !== undefined) pushVarintField(out, 6, enumInt(sp.kind, SPAN_KIND));
  if (sp.startTimeUnixNano) pushFixed64Field(out, 7, BigInt(sp.startTimeUnixNano as string));
  if (sp.endTimeUnixNano) pushFixed64Field(out, 8, BigInt(sp.endTimeUnixNano as string));
  encodeAttributes(out, 9, sp.attributes);
  if (sp.droppedAttributesCount) pushVarintField(out, 10, Number(sp.droppedAttributesCount));
  for (const e of (sp.events as Json[]) ?? []) pushMessageField(out, 11, encodeEvent(e));
  if (sp.droppedEventsCount) pushVarintField(out, 12, Number(sp.droppedEventsCount));
  for (const l of (sp.links as Json[]) ?? []) pushMessageField(out, 13, encodeLink(l));
  if (sp.droppedLinksCount) pushVarintField(out, 14, Number(sp.droppedLinksCount));
  if (sp.status) pushMessageField(out, 15, encodeStatus(sp.status as Json));
  if (sp.flags) {
    pushTag(out, 16, WIRE_FIXED32);
    pushFixed32(out, Number(sp.flags));
  }
  return out;
}

function encodeScopeSpans(ss: Json): number[] {
  const out: number[] = [];
  if (ss.scope) pushMessageField(out, 1, encodeScope(ss.scope as Json));
  for (const sp of (ss.spans as Json[]) ?? []) pushMessageField(out, 2, encodeSpan(sp));
  if (ss.schemaUrl) pushStringField(out, 3, String(ss.schemaUrl));
  return out;
}

function encodeResourceSpans(rs: Json): number[] {
  const out: number[] = [];
  if (rs.resource) pushMessageField(out, 1, encodeResource(rs.resource as Json));
  for (const ss of (rs.scopeSpans as Json[]) ?? []) pushMessageField(out, 2, encodeScopeSpans(ss));
  if (rs.schemaUrl) pushStringField(out, 3, String(rs.schemaUrl));
  return out;
}

export function encodeTraceRequest(json: Json): Uint8Array {
  const out: number[] = [];
  for (const rs of (json.resourceSpans as Json[]) ?? []) pushMessageField(out, 1, encodeResourceSpans(rs));
  return Uint8Array.from(out);
}

// ---------------------------------------------------------------------------
// Size-bounded chunking.
//
// Azure Monitor's Logs Ingestion API caps a single POST at ~1 MB uncompressed;
// an oversized OTLP batch gets HTTP 413. Because Cloudflare Workers observability
// head-of-line retries a failed export batch forever, ONE 413 wedges the entire
// pipeline (this happened during the 6 GB backfill's access-log burst). So the
// gateway splits a batch into chunks whose protobuf stays under the cap and posts
// them one at a time. These encoders return that list of ready-to-POST chunks,
// each a valid `ExportLogsServiceRequest` / `ExportTraceServiceRequest`.
//
// Splitting is at record granularity (logRecords / spans), re-emitting the
// enclosing resource + scope framing per chunk. `dropped` counts records that
// couldn't be made to fit even alone (the degenerate case); logs truncate their
// body string first, spans are dropped — either way one poison record can never
// permanently wedge a chunk.

const RECORD_FIELD = 2; // ScopeLogs.log_records / ScopeSpans.spans

function varintSize(value: number): number {
  let v = value >>> 0;
  let size = 1;
  while (v > 0x7f) {
    size++;
    v >>>= 7;
  }
  return size;
}

// Bytes a record adds to its scope container: tag (1 byte for field 2) + length
// varint + the record's own bytes.
function recordFieldSize(contentLength: number): number {
  return 1 + varintSize(contentLength) + contentLength;
}

// Builds one request (single ResourceX → single ScopeX → the given records),
// wire-identical to encodeResourceLogs/encodeScopeLogs (field numbers 1/2/3).
function buildRequest(
  encRes: number[] | null,
  encScope: number[] | null,
  resSchemaUrl: string | null,
  scopeSchemaUrl: string | null,
  records: number[][],
): Uint8Array {
  const scope: number[] = [];
  if (encScope) pushMessageField(scope, 1, encScope);
  for (const r of records) pushMessageField(scope, RECORD_FIELD, r);
  if (scopeSchemaUrl) pushStringField(scope, 3, scopeSchemaUrl);

  const resource: number[] = [];
  if (encRes) pushMessageField(resource, 1, encRes);
  pushMessageField(resource, 2, scope);
  if (resSchemaUrl) pushStringField(resource, 3, resSchemaUrl);

  const req: number[] = [];
  pushMessageField(req, 1, resource);
  return Uint8Array.from(req);
}

interface SignalSpec {
  scopeKey: string; // 'scopeLogs' | 'scopeSpans'
  recordKey: string; // 'logRecords' | 'spans'
  encodeRecord: (r: Json) => number[];
  // Shrink an over-cap record to fit `budget` protobuf bytes, or return null to drop it.
  degrade: (r: Json, budget: number) => Json | null;
}

export interface ChunkResult {
  chunks: Uint8Array[];
  dropped: number;
}

function chunkSignal(resourceItems: Json[], spec: SignalSpec, maxBytes: number): ChunkResult {
  const chunks: Uint8Array[] = [];
  let dropped = 0;

  for (const ri of resourceItems ?? []) {
    const encRes = ri.resource ? encodeResource(ri.resource as Json) : null;
    const resSchema = ri.schemaUrl ? String(ri.schemaUrl) : null;

    for (const sc of (ri[spec.scopeKey] as Json[]) ?? []) {
      const encScope = sc.scope ? encodeScope(sc.scope as Json) : null;
      const scopeSchema = sc.schemaUrl ? String(sc.schemaUrl) : null;
      // Framing cost of an empty chunk for this resource+scope. The outer length
      // prefixes grow a few bytes as records are added; maxBytes sits ~100 KB
      // below Azure's ~1 MB ceiling, which absorbs that slack.
      const base = buildRequest(encRes, encScope, resSchema, scopeSchema, []).length;

      let recs: number[][] = [];
      let size = base;
      const flush = () => {
        if (recs.length === 0) return;
        chunks.push(buildRequest(encRes, encScope, resSchema, scopeSchema, recs));
        recs = [];
        size = base;
      };

      for (const rec of (sc[spec.recordKey] as Json[]) ?? []) {
        let enc = spec.encodeRecord(rec);
        let field = recordFieldSize(enc.length);
        if (base + field > maxBytes) {
          // Degenerate: this record can't fit even in a chunk of its own.
          const degraded = spec.degrade(rec, maxBytes - base - 64);
          if (degraded) {
            enc = spec.encodeRecord(degraded);
            field = recordFieldSize(enc.length);
          }
          if (!degraded || base + field > maxBytes) {
            dropped++;
            continue;
          }
        }
        if (recs.length > 0 && size + field > maxBytes) flush();
        recs.push(enc);
        size += field;
      }
      flush();
    }
  }

  return { chunks, dropped };
}

// Truncate a string to at most `maxBytes` of UTF-8, ending on a code-point
// boundary. The DCR cap is a byte budget but String.slice cuts UTF-16 code units,
// so a mostly-non-ASCII body (CJK, emoji — 3-4 bytes each) sliced by code-unit
// count can still encode far past the cap and fall through to the drop path. We
// encode, cut the byte array, then back off any trailing UTF-8 continuation byte
// (0b10xxxxxx) so the result decodes cleanly with no replacement char.
function truncateUtf8(str: string, maxBytes: number): string {
  const enc = new TextEncoder().encode(str);
  if (enc.length <= maxBytes) return str;
  let end = maxBytes;
  while (end > 0 && (enc[end]! & 0xc0) === 0x80) end--;
  return new TextDecoder().decode(enc.subarray(0, end));
}

// Logs: truncate the body string (the usual giant field) so the record fits.
function degradeLogRecord(lr: Json, budget: number): Json | null {
  const body = lr.body as Json | undefined;
  if (!body || typeof body !== "object" || body.stringValue === undefined) return null;
  const marker = "…[gateway-truncated]";
  const original = String(body.stringValue);
  const markerBytes = new TextEncoder().encode(marker).length;
  const keep = Math.max(0, budget - markerBytes - 256); // budget/marker in BYTES; leave room for other fields
  return {
    ...lr,
    body: { stringValue: truncateUtf8(original, keep) + marker },
    attributes: [
      ...((lr.attributes as Json[]) ?? []),
      { key: "gateway.truncated", value: { boolValue: true } },
    ],
  };
}

export function encodeLogsChunks(json: Json, maxBytes: number): ChunkResult {
  return chunkSignal(
    (json.resourceLogs as Json[]) ?? [],
    { scopeKey: "scopeLogs", recordKey: "logRecords", encodeRecord: encodeLogRecord, degrade: degradeLogRecord },
    maxBytes,
  );
}

export function encodeTraceChunks(json: Json, maxBytes: number): ChunkResult {
  // A single span rarely approaches the cap and has no one dominant string to
  // truncate, so an unfittable span is dropped (with a self-log upstream).
  return chunkSignal(
    (json.resourceSpans as Json[]) ?? [],
    { scopeKey: "scopeSpans", recordKey: "spans", encodeRecord: encodeSpan, degrade: () => null },
    maxBytes,
  );
}
