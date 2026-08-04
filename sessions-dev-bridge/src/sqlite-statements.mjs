// SQLite's own sqlite3_complete() state machine, adapted to return statement slices.
// Keeping comments and quoted text in the slices lets D1 prepare the original SQL verbatim.
const SEMI = 0;
const WHITESPACE = 1;
const OTHER = 2;
const EXPLAIN = 3;
const CREATE = 4;
const TEMP = 5;
const TRIGGER = 6;
const END = 7;

const INVALID_STATE = 0;
const START_STATE = 1;
const TRANSITIONS = Object.freeze([
  Object.freeze([1, 0, 2, 3, 4, 2, 2, 2]),
  Object.freeze([1, 1, 2, 3, 4, 2, 2, 2]),
  Object.freeze([1, 2, 2, 2, 2, 2, 2, 2]),
  Object.freeze([1, 3, 3, 2, 4, 2, 2, 2]),
  Object.freeze([1, 4, 2, 2, 2, 4, 5, 2]),
  Object.freeze([6, 5, 5, 5, 5, 5, 5, 5]),
  Object.freeze([6, 6, 5, 5, 5, 5, 5, 7]),
  Object.freeze([1, 7, 5, 5, 5, 5, 5, 5]),
]);

export function splitSqliteStatements(sql) {
  if (typeof sql !== 'string') throw new TypeError('SQL must be a string');
  const statements = [];
  let statementStart = 0;
  let state = INVALID_STATE;

  for (let index = 0; index < sql.length; index++) {
    const character = sql[index];
    let token = OTHER;

    if (character === ';') {
      token = SEMI;
    } else if (isWhitespace(character)) {
      token = WHITESPACE;
    } else if (character === '-' && sql[index + 1] === '-') {
      index += 2;
      while (index < sql.length && sql[index] !== '\n') index++;
      token = WHITESPACE;
    } else if (character === '/' && sql[index + 1] === '*') {
      index += 2;
      while (index < sql.length && (sql[index] !== '*' || sql[index + 1] !== '/')) index++;
      if (index < sql.length) index++;
      token = WHITESPACE;
    } else if (character === '[') {
      index++;
      while (index < sql.length && sql[index] !== ']') index++;
    } else if (character === "'" || character === '"' || character === '`') {
      index = quotedEnd(sql, index, character);
    } else if (isIdentifierCharacter(character)) {
      const tokenStart = index;
      while (index + 1 < sql.length && isIdentifierCharacter(sql[index + 1])) index++;
      token = keywordToken(sql.slice(tokenStart, index + 1));
    }

    const priorState = state;
    state = TRANSITIONS[state][token];
    if (token === SEMI && state === START_STATE) {
      if (priorState !== INVALID_STATE && priorState !== START_STATE) statements.push(sql.slice(statementStart, index + 1));
      statementStart = index + 1;
    }
  }

  if (state !== INVALID_STATE && state !== START_STATE) statements.push(sql.slice(statementStart));
  return statements;
}

export async function executeD1Migrations(database, migrations) {
  for (const migration of migrations) {
    const statements = splitSqliteStatements(migration.sql);
    if (statements.length === 0) continue;
    await database.batch(statements.map((statement) => database.prepare(statement)));
  }
}

function quotedEnd(sql, openingIndex, delimiter) {
  let index = openingIndex + 1;
  while (index < sql.length) {
    if (sql[index] !== delimiter) {
      index++;
      continue;
    }
    if (sql[index + 1] === delimiter) {
      index += 2;
      continue;
    }
    return index;
  }
  return sql.length - 1;
}

function keywordToken(value) {
  switch (value.toLowerCase()) {
    case 'explain': return EXPLAIN;
    case 'create': return CREATE;
    case 'temp':
    case 'temporary': return TEMP;
    case 'trigger': return TRIGGER;
    case 'end': return END;
    default: return OTHER;
  }
}

function isWhitespace(character) {
  return character === ' ' || character === '\r' || character === '\t' || character === '\n' || character === '\f';
}

function isIdentifierCharacter(character) {
  if (character === undefined) return false;
  const code = character.charCodeAt(0);
  return code >= 0x80
    || (code >= 48 && code <= 57)
    || (code >= 65 && code <= 90)
    || (code >= 97 && code <= 122)
    || character === '_'
    || character === '$';
}
