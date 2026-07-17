/**
 * Byte-offset-exact JSONL line reader.
 *
 * Splits on \n at the byte level (never through TextDecoderStream, which loses
 * byte positions), decodes each line individually, and reports [byteStart, byteLen)
 * of every line within the source object. byteLen includes the trailing newline
 * when present so consecutive lines tile the file exactly.
 */
export interface JsonlLine {
  /** Raw decoded text of the line (without trailing \n). */
  text: string;
  byteStart: number;
  /** Byte length including the trailing \n if present. */
  byteLen: number;
}

const NEWLINE = 0x0a;

export async function* readJsonlLines(
  stream: ReadableStream<Uint8Array>,
  baseOffset = 0,
): AsyncGenerator<JsonlLine> {
  const decoder = new TextDecoder('utf-8');
  const reader = stream.getReader();
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let offset = baseOffset;

  const flush = (chunks: Uint8Array[], totalWithNewline: number, hasNewline: boolean): JsonlLine => {
    let text: string;
    if (chunks.length === 1) {
      const c = chunks[0]!;
      text = decoder.decode(hasNewline ? c.subarray(0, c.length - 1) : c);
    } else {
      const contentLen = hasNewline ? totalWithNewline - 1 : totalWithNewline;
      const buf = new Uint8Array(contentLen);
      let pos = 0;
      for (const c of chunks) {
        const take = Math.min(c.length, contentLen - pos);
        if (take > 0) buf.set(c.subarray(0, take), pos);
        pos += take;
      }
      text = decoder.decode(buf);
    }
    const line: JsonlLine = { text, byteStart: offset, byteLen: totalWithNewline };
    offset += totalWithNewline;
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
          if (chunk.length > 0) {
            pending.push(chunk);
            pendingBytes += chunk.length;
          }
          break;
        }
        const head = chunk.subarray(0, nl + 1);
        pending.push(head);
        pendingBytes += head.length;
        yield flush(pending, pendingBytes, true);
        pending = [];
        pendingBytes = 0;
        chunk = chunk.subarray(nl + 1);
      }
    }
    if (pendingBytes > 0) {
      yield flush(pending, pendingBytes, false);
    }
  } finally {
    reader.releaseLock();
  }
}
