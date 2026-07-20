/**
 * Byte-offset-exact JSONL line reader.
 *
 * Splits on \n at the byte level (never through TextDecoderStream, which loses
 * byte positions), decodes each line individually, and reports [byteStart, byteLen)
 * of every line within the source object. byteLen includes the trailing newline
 * when present so consecutive lines tile the file exactly.
 */
interface JsonlLineOffset {
  byteStart: number;
  /** Byte length including the trailing \n if present. */
  byteLen: number;
}

export interface DecodedJsonlLine extends JsonlLineOffset {
  kind: 'decoded';
  /** Raw decoded text of the line (without trailing \n). */
  text: string;
}

export interface OversizedJsonlLine extends JsonlLineOffset {
  kind: 'oversized';
}

export type JsonlLine = DecodedJsonlLine | OversizedJsonlLine;

/** Maximum decoded JSON record size. The delimiter is not part of the content limit. */
export const MAX_JSONL_LINE_BYTES = 2 * 1024 * 1024;

const NEWLINE = 0x0a;

export async function* readJsonlLines(
  stream: ReadableStream<Uint8Array>,
  baseOffset = 0,
): AsyncGenerator<JsonlLine> {
  const decoder = new TextDecoder('utf-8');
  const reader = stream.getReader();
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let oversized = false;
  let offset = baseOffset;

  const append = (chunk: Uint8Array): void => {
    pendingBytes += chunk.length;
    if (oversized) return;
    if (pendingBytes > MAX_JSONL_LINE_BYTES) {
      oversized = true;
      pending = [];
      return;
    }
    if (chunk.length > 0) pending.push(chunk);
  };

  const flush = (hasNewline: boolean): JsonlLine => {
    const byteLen = pendingBytes + (hasNewline ? 1 : 0);
    let line: JsonlLine;
    if (oversized) {
      line = { kind: 'oversized', byteStart: offset, byteLen };
    } else if (pending.length === 1) {
      line = { kind: 'decoded', text: decoder.decode(pending[0]!), byteStart: offset, byteLen };
    } else {
      const buf = new Uint8Array(pendingBytes);
      let pos = 0;
      for (const chunk of pending) {
        buf.set(chunk, pos);
        pos += chunk.length;
      }
      line = { kind: 'decoded', text: decoder.decode(buf), byteStart: offset, byteLen };
    }
    offset += byteLen;
    pending = [];
    pendingBytes = 0;
    oversized = false;
    return line;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      let chunk = value;
      for (;;) {
        const nl = chunk.indexOf(NEWLINE);
        if (nl === -1) {
          append(chunk);
          break;
        }
        append(chunk.subarray(0, nl));
        yield flush(true);
        chunk = chunk.subarray(nl + 1);
      }
    }
    if (pendingBytes > 0) {
      yield flush(false);
    }
  } finally {
    reader.releaseLock();
  }
}
