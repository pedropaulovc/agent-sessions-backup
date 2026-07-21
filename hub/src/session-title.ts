/** Title shown for a session in search results: its first human/agent text exchange.
 * System/developer instructions, hook metadata, thinking, and tool traffic are not conversation text. */
export function firstInteractionTitleSql(sessionAlias: string): string {
  return `(SELECT substr(trim(title_block.text), 1, 120)
           FROM blocks title_block
           WHERE title_block.session_id = ${sessionAlias}.session_id
             AND title_block.role IN ('user', 'assistant')
             AND title_block.btype IN ('text', 'prompt')
             AND trim(COALESCE(title_block.text, '')) <> ''
           ORDER BY title_block.turn_index, title_block.block_index
           LIMIT 1)`;
}
