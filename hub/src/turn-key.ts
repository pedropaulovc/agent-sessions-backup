import type { NormalizedTurn } from './ingest/normalize';

/** Stable source ID when available; otherwise a content-and-source-position fingerprint. */
export function turnKeyOf(turn: NormalizedTurn): string {
  if (turn.id) return `id:${turn.id}`;
  return turnFallbackKeyOf(turn);
}

/** Content/position identity used for id-less turns and to migrate a live turn when its source ID arrives. */
export function turnFallbackKeyOf(turn: NormalizedTurn): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const mix = (value: string | number | boolean | null | undefined) => {
    const text = value === null || value === undefined ? '\u0000' : String(value);
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ code, 0x85ebca6b) >>> 0;
    }
    h1 = Math.imul(h1 ^ 0x1f, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ 0x1f, 0x85ebca6b) >>> 0;
  };

  mix(turn.role);
  // Parser context such as model, parent lineage, and pre-block timestamps may sit outside a viewer
  // byte range. Only hash fields intrinsic to rendered records so full-ingest and ranged keys agree.
  mix(turn.blocks[0]?.byteStart ?? turn.byteStart);
  for (const block of turn.blocks) {
    mix(block.type);
    mix(block.toolUseId);
    mix(block.toolName);
    mix(block.isError);
    mix(block.mediaType);
    mix(block.truncated);
    mix(block.text);
  }
  return `content:${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}
