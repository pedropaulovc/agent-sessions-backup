const INJECTED_TURN_PREFIXES = [
  '# AGENTS.md instructions',
  '<local-command-',
  '<recommended_plugins>',
  '<command-name>',
  '<local-command-stdout>',
  '<codex_internal_context',
  '<system-reminder',
  '<environment_context',
  '<hook_prompt',
] as const;

const NON_CONVERSATION_BLOCK_PREFIXES = [
  // Claude Code preserves unsupported server tool metadata as a text block containing raw JSON.
  // Match the known metadata type exactly; ordinary user prompts that happen to be JSON stay eligible.
  '{"type":"server_tool_use"',
] as const;

const IMAGE_PREFIX = '<image name=[Image #';
const IMAGE_CLOSE = '</image>';
const SPECIAL_TITLE_LIMIT = 2048;

/** Select the first human/agent text exchange as a compact JSON candidate.
 * System/developer instructions, hook metadata, thinking, tool traffic, and known injected
 * user/assistant wrappers are ineligible. The correlated lookup uses blocks_session. */
export function firstInteractionTitleCandidateSql(sessionAlias: string): string {
  const text = interactionTextSql('title_block.text');
  const specialTitles = [
    teammateSummaryTitleSql(text),
    teammateAssignmentTitleSql(text),
    xmlAttributeTitleSql(text, '<scheduled-task name="'),
    nestedElementTitleSql(text, '<task-notification>', '<summary>', '</summary>'),
    nestedElementTitleSql(text, '<command-message>', '<command-message>', '</command-message>'),
    nestedElementTitleSql(text, '<task>', '<task>', '</task>'),
  ];
  const isSpecialTitle = specialTitles.map(({ condition }) => condition).join(' OR ');
  const isEncodedSpecialTitle = specialTitles
    .filter(({ kind }) => kind === 'encoded-special')
    .map(({ condition }) => condition)
    .join(' OR ');
  const specialTitle = specialTitles
    .map(({ condition, value }) => `WHEN ${condition} THEN substr(${value}, 1, ${SPECIAL_TITLE_LIMIT})`)
    .join('\n                      ');
  const turnIsEligible = excludesPrefixesSql(text, INJECTED_TURN_PREFIXES);
  const blockIsEligible = excludesPrefixesSql(text, NON_CONVERSATION_BLOCK_PREFIXES);
  const earlierText = interactionTextSql('earlier_title_block.text');
  const earlierBlockIsEligible = excludesPrefixesSql(earlierText, NON_CONVERSATION_BLOCK_PREFIXES);

  return `(SELECT json_object(
                    'kind', CASE
                      WHEN ${isEncodedSpecialTitle} THEN 'encoded-special'
                      WHEN ${isSpecialTitle} THEN 'plain-special'
                      ELSE 'text'
                    END,
                    'text', CASE
                      ${specialTitle}
                      ELSE substr(trim(${text}), 1, 120)
                    END)
           FROM blocks title_block
           WHERE title_block.session_id = ${sessionAlias}.session_id
             AND title_block.role IN ('user', 'assistant')
             AND title_block.btype IN ('text', 'prompt')
             AND title_block.on_main_path = 1
             AND COALESCE(${text}, '') <> ''
             AND ${blockIsEligible}
             AND NOT EXISTS (
               SELECT 1
               FROM blocks earlier_title_block
               WHERE earlier_title_block.session_id = title_block.session_id
                 AND earlier_title_block.turn_index = title_block.turn_index
                 AND earlier_title_block.block_index < title_block.block_index
                 AND earlier_title_block.role IN ('user', 'assistant')
                 AND earlier_title_block.btype IN ('text', 'prompt')
                 AND earlier_title_block.on_main_path = 1
                 AND COALESCE(${earlierText}, '') <> ''
                 AND ${earlierBlockIsEligible}
             )
             AND ${turnIsEligible}
           ORDER BY title_block.turn_index, title_block.block_index
           LIMIT 1)`;
}

interface SqlTitleExtractor {
  condition: string;
  value: string;
  kind: 'encoded-special' | 'plain-special';
}

function xmlAttributeTitleSql(
  textSql: string,
  prefix: string,
): SqlTitleExtractor {
  const rest = `substr(${textSql}, ${prefix.length + 1})`;
  const condition = `substr(${textSql}, 1, ${prefix.length}) = ${sqlString(prefix)} ` +
    `AND instr(${rest}, '"') > 0`;
  return {
    condition: `(${condition})`,
    value: `substr(${rest}, 1, instr(${rest}, '"') - 1)`,
    kind: 'encoded-special',
  };
}

function teammateSummaryTitleSql(textSql: string): SqlTitleExtractor {
  const teammatePrefix = '<teammate-message';
  const summaryPrefix = 'summary="';
  const openingTag = `substr(${textSql}, 1, instr(${textSql}, '>'))`;
  const summaryStart = `instr(${openingTag}, ${sqlString(summaryPrefix)})`;
  const rest = `substr(${openingTag}, ${summaryStart} + ${summaryPrefix.length})`;
  const beforeSummary = `substr(${openingTag}, ${summaryStart} - 1, 1)`;
  const condition = startsElementSql(textSql, teammatePrefix) +
    ` AND instr(${textSql}, '>') > 0 AND ${summaryStart} > 0 ` +
    `AND ${beforeSummary} IN (' ', char(9), char(10), char(13)) AND instr(${rest}, '"') > 0`;
  return {
    condition: `(${condition})`,
    value: `substr(${rest}, 1, instr(${rest}, '"') - 1)`,
    kind: 'encoded-special',
  };
}

function teammateAssignmentTitleSql(textSql: string): SqlTitleExtractor {
  const teammatePrefix = '<teammate-message';
  const close = '</teammate-message>';
  const openEnd = `instr(${textSql}, '>')`;
  const closeStart = `instr(${textSql}, ${sqlString(close)})`;
  const body = `trim(substr(${textSql}, ${openEnd} + 1, ${closeStart} - ${openEnd} - 1), ` +
    `char(9) || char(10) || char(13) || ' ')`;
  const jsonType = jsonTextSql(body, '$.type');
  const subject = jsonTextSql(body, '$.subject');
  const condition = startsElementSql(textSql, teammatePrefix) +
    ` AND ${openEnd} > 0 AND ${closeStart} > ${openEnd} ` +
    `AND ${jsonType} = 'task_assignment' AND typeof(${subject}) = 'text'`;
  return { condition: `(${condition})`, value: subject, kind: 'plain-special' };
}

function nestedElementTitleSql(
  textSql: string,
  wrapperPrefix: string,
  openTag: string,
  closeTag: string,
): SqlTitleExtractor {
  const openStart = `instr(${textSql}, ${sqlString(openTag)})`;
  const rest = `substr(${textSql}, ${openStart} + ${openTag.length})`;
  const condition = startsWithSql(textSql, wrapperPrefix) +
    ` AND ${openStart} > 0 AND instr(${rest}, ${sqlString(closeTag)}) > 0`;
  return {
    condition: `(${condition})`,
    value: `trim(substr(${rest}, 1, instr(${rest}, ${sqlString(closeTag)}) - 1), ` +
      `char(9) || char(10) || char(13) || ' ')`,
    kind: 'encoded-special',
  };
}

function jsonTextSql(jsonSql: string, path: string): string {
  return `(CASE WHEN json_valid(${jsonSql}) THEN json_extract(${jsonSql}, ${sqlString(path)}) END)`;
}

function startsWithSql(textSql: string, prefix: string): string {
  return `substr(${textSql}, 1, ${prefix.length}) = ${sqlString(prefix)}`;
}

function startsElementSql(textSql: string, prefix: string): string {
  const next = `substr(${textSql}, ${prefix.length + 1}, 1)`;
  return `(${startsWithSql(textSql, prefix)} AND ${next} IN (' ', '>', char(9), char(10), char(13)))`;
}

function interactionTextSql(textSql: string): string {
  const text = leadingTrimSql(textSql);
  const remainder = `substr(remaining, instr(remaining, ${sqlString(IMAGE_CLOSE)}) + ${IMAGE_CLOSE.length})`;
  const hasImage = `substr(remaining, 1, ${IMAGE_PREFIX.length}) = ${sqlString(IMAGE_PREFIX)} ` +
    `AND instr(remaining, ${sqlString(IMAGE_CLOSE)}) > 0`;
  return `(WITH RECURSIVE image_prefixes(remaining, depth) AS (
            SELECT ${text}, 0
            UNION ALL
            SELECT ${leadingTrimSql(remainder)}, depth + 1
            FROM image_prefixes
            WHERE ${hasImage}
          )
          SELECT remaining
          FROM image_prefixes
          ORDER BY depth DESC
          LIMIT 1)`;
}

function leadingTrimSql(textSql: string): string {
  return `ltrim(${textSql}, char(9) || char(10) || char(13) || ' ')`;
}

function excludesPrefixesSql(textSql: string, prefixes: readonly string[]): string {
  return prefixes
    .map((prefix) => `substr(${textSql}, 1, ${prefix.length}) <> ${sqlString(prefix)}`)
    .join('\n                 AND ');
}

export function resolveFirstInteractionTitle(candidate: string | null): string | null {
  if (!candidate) return null;
  try {
    const parsed = JSON.parse(candidate) as { kind?: unknown; text?: unknown };
    if (typeof parsed.text !== 'string') return null;
    if (parsed.kind === 'encoded-special') return decodeXmlEntities(parsed.text).trim().slice(0, 120);
    if (parsed.kind === 'plain-special') return parsed.text.trim().slice(0, 120);
    return parsed.text;
  } catch {
    return null;
  }
}

function decodeXmlEntities(value: string): string {
  return value.replace(/&(#(?:x[\da-f]+|\d+)|amp|apos|gt|lt|quot);/gi, (encoded, entity: string) => {
    const named: Record<string, string> = { amp: '&', apos: "'", gt: '>', lt: '<', quot: '"' };
    const replacement = named[entity.toLowerCase()];
    if (replacement !== undefined) return replacement;

    const hex = entity[1]?.toLowerCase() === 'x';
    const codePoint = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    if (!Number.isSafeInteger(codePoint) || codePoint > 0x10ffff) return encoded;
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) return encoded;
    return String.fromCodePoint(codePoint);
  });
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
