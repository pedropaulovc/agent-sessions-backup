const INJECTED_TURN_PREFIXES = [
  '# AGENTS.md instructions',
  '<local-command-',
  '<recommended_plugins>',
  '<command-name>',
  '<local-command-stdout>',
] as const;

const NON_CONVERSATION_BLOCK_PREFIXES = [
  // Claude Code preserves unsupported server tool metadata as a text block containing raw JSON.
  // Match the known metadata type exactly; ordinary user prompts that happen to be JSON stay eligible.
  '{"type":"server_tool_use"',
] as const;

const IMAGE_PREFIX = '<image name=[Image #';
const IMAGE_CLOSE = '</image>';

const XML_ATTRIBUTE_TITLE_PREFIXES = [
  '<teammate-message teammate_id="team-lead" summary="',
  '<scheduled-task name="',
] as const;

/** Select the first human/agent text exchange as a compact JSON candidate.
 * System/developer instructions, hook metadata, thinking, tool traffic, and known injected
 * user/assistant wrappers are ineligible. The correlated lookup uses blocks_session. */
export function firstInteractionTitleCandidateSql(sessionAlias: string): string {
  const text = interactionTextSql('title_block.text');
  const attributeTitles = XML_ATTRIBUTE_TITLE_PREFIXES.map((prefix) => xmlAttributeTitleSql(text, prefix));
  const isAttributeTitle = attributeTitles.map(({ condition }) => condition).join(' OR ');
  const attributeTitle = attributeTitles
    .map(({ condition, value }) => `WHEN ${condition} THEN ${value}`)
    .join('\n                      ');
  const turnIsEligible = excludesPrefixesSql(text, INJECTED_TURN_PREFIXES);
  const blockIsEligible = excludesPrefixesSql(text, NON_CONVERSATION_BLOCK_PREFIXES);
  const earlierText = interactionTextSql('earlier_title_block.text');
  const earlierBlockIsEligible = excludesPrefixesSql(earlierText, NON_CONVERSATION_BLOCK_PREFIXES);

  return `(SELECT json_object(
                    'kind', CASE WHEN ${isAttributeTitle} THEN 'xml-attribute' ELSE 'text' END,
                    'text', CASE
                      ${attributeTitle}
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

function xmlAttributeTitleSql(
  textSql: string,
  prefix: string,
): { condition: string; value: string } {
  const rest = `substr(${textSql}, ${prefix.length + 1})`;
  const condition = `substr(${textSql}, 1, ${prefix.length}) = ${sqlString(prefix)} ` +
    `AND instr(${rest}, '"') > 0`;
  return {
    condition: `(${condition})`,
    value: `substr(${rest}, 1, instr(${rest}, '"') - 1)`,
  };
}

function interactionTextSql(textSql: string): string {
  const text = leadingTrimSql(textSql);
  const afterImage = `substr(${text}, instr(${text}, ${sqlString(IMAGE_CLOSE)}) + ${IMAGE_CLOSE.length})`;
  const hasImage = `substr(${text}, 1, ${IMAGE_PREFIX.length}) = ${sqlString(IMAGE_PREFIX)} ` +
    `AND instr(${text}, ${sqlString(IMAGE_CLOSE)}) > 0`;
  return `(CASE WHEN ${hasImage} THEN ${leadingTrimSql(afterImage)} ELSE ${text} END)`;
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
    if (parsed.kind !== 'xml-attribute') return parsed.text;
    return decodeXmlEntities(parsed.text).trim().slice(0, 120);
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
