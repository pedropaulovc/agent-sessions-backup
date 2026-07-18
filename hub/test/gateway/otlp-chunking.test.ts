import { describe, it, expect } from 'vitest';
import { encodeLogsChunks, encodeTraceChunks, encodeLogsRequest } from '../../gateway/otlp-protobuf';

// A minimal protobuf length-delimited walker, just enough to (a) count the records
// in an encoded ExportLogs/TraceServiceRequest and (b) confirm each chunk is a
// valid request. Records sit at field 2 of the scope container (field 2) of the
// resource container (field 1) — identical nesting for logs and spans.
function readVarint(bytes: Uint8Array, pos: number): [number, number] {
  let shift = 0;
  let result = 0;
  let p = pos;
  for (;;) {
    const b = bytes[p++]!;
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  return [result >>> 0, p];
}

function* lenFields(bytes: Uint8Array): Generator<{ field: number; val: Uint8Array }> {
  let p = 0;
  while (p < bytes.length) {
    let tag: number;
    [tag, p] = readVarint(bytes, p);
    const field = tag >>> 3;
    const wire = tag & 7;
    if (wire === 2) {
      let len: number;
      [len, p] = readVarint(bytes, p);
      yield { field, val: bytes.subarray(p, p + len) };
      p += len;
    } else if (wire === 0) {
      [, p] = readVarint(bytes, p);
    } else if (wire === 1) {
      p += 8;
    } else if (wire === 5) {
      p += 4;
    } else {
      throw new Error(`unexpected wire type ${wire}`);
    }
  }
}

function countRecords(req: Uint8Array): number {
  let n = 0;
  for (const rl of lenFields(req)) {
    if (rl.field !== 1) continue; // ResourceLogs / ResourceSpans
    for (const sl of lenFields(rl.val)) {
      if (sl.field !== 2) continue; // ScopeLogs / ScopeSpans
      for (const rec of lenFields(sl.val)) {
        if (rec.field === 2) n++; // log_records / spans
      }
    }
  }
  return n;
}

// Extract every log record's body string from an encoded ExportLogsServiceRequest.
// Path: req → field1 ResourceLogs → field2 ScopeLogs → field2 LogRecord → field5
// body (AnyValue) → field1 string_value. Decodes with fatal:true so a body cut
// mid-UTF-8-sequence (the bug) would throw instead of silently passing.
function logBodies(req: Uint8Array): string[] {
  const out: string[] = [];
  const decode = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  for (const rl of lenFields(req)) {
    if (rl.field !== 1) continue;
    for (const sl of lenFields(rl.val)) {
      if (sl.field !== 2) continue;
      for (const rec of lenFields(sl.val)) {
        if (rec.field !== 2) continue;
        for (const f of lenFields(rec.val)) {
          if (f.field !== 5) continue; // LogRecord.body
          for (const v of lenFields(f.val)) {
            if (v.field === 1) out.push(decode.decode(v.val)); // AnyValue.string_value
          }
        }
      }
    }
  }
  return out;
}

function bodyString(bytes: number): string {
  // A JSON-ish body so it looks like a real access-log line.
  return `{"event":"http.access","path":"/x","note":"${'a'.repeat(Math.max(0, bytes - 40))}"}`;
}

function logsBatch(recordCount: number, bodyBytesEach: number): Record<string, unknown> {
  return {
    resourceLogs: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'sessions-hub' } }] },
        scopeLogs: [
          {
            scope: { name: 'access' },
            logRecords: Array.from({ length: recordCount }, (_, i) => ({
              timeUnixNano: String(1782964800000000000n + BigInt(i)),
              severityNumber: 9,
              body: { stringValue: bodyString(bodyBytesEach) },
            })),
          },
        ],
      },
    ],
  };
}

const CAP = 900_000;
const AZURE_LIMIT = 1_000_000;

describe('otlp chunking', () => {
  it('keeps a small batch in a single chunk, byte-identical to the unchunked encoder', () => {
    const batch = logsBatch(3, 100);
    const { chunks, dropped } = encodeLogsChunks(batch, CAP);
    expect(dropped).toBe(0);
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.byteLength).toBeLessThanOrEqual(CAP);
    expect(countRecords(chunks[0]!)).toBe(3);
    // Same resource/scope/record framing as the pre-chunking path.
    expect(Array.from(chunks[0]!)).toEqual(Array.from(encodeLogsRequest(batch)));
  });

  it('splits an oversized batch into multiple chunks, each under the cap, preserving every record', () => {
    // 6 records × ~300 KB ≈ 1.8 MB > 900 KB cap.
    const batch = logsBatch(6, 300_000);
    const { chunks, dropped } = encodeLogsChunks(batch, CAP);
    expect(dropped).toBe(0);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.byteLength).toBeLessThanOrEqual(CAP);
    const total = chunks.reduce((sum, c) => sum + countRecords(c), 0);
    expect(total).toBe(6);
  });

  it('truncates a single record larger than the cap instead of dropping it', () => {
    // One 2 MB record — bigger than the whole cap on its own.
    const batch = logsBatch(1, 2_000_000);
    const { chunks, dropped } = encodeLogsChunks(batch, CAP);
    expect(dropped).toBe(0);
    expect(chunks.length).toBe(1);
    // Truncation happened: the emitted chunk is far under the cap despite a 2 MB input.
    expect(chunks[0]!.byteLength).toBeLessThanOrEqual(AZURE_LIMIT);
    expect(chunks[0]!.byteLength).toBeLessThan(2_000_000);
    expect(countRecords(chunks[0]!)).toBe(1);
  });

  it('truncates a multi-byte (emoji/CJK) oversized body by BYTE budget, keeping the record and valid UTF-8', () => {
    // 🦀 is 2 UTF-16 code units but 4 UTF-8 bytes. A ~2 MB emoji body sliced by
    // code-UNIT count (the bug) still encodes to ~2× the cap → falls through to the
    // drop path. Byte-budgeted truncation keeps the record and stays under the cap.
    const emojiBody = '🦀'.repeat(500_000); // ~2 MB encoded, ~1 M UTF-16 units
    const batch = {
      resourceLogs: [
        {
          resource: { attributes: [{ key: 'service.name', value: { stringValue: 'sessions-hub' } }] },
          scopeLogs: [{ scope: { name: 'access' }, logRecords: [{ timeUnixNano: '1782964800000000000', body: { stringValue: emojiBody } }] }],
        },
      ],
    };
    const { chunks, dropped } = encodeLogsChunks(batch, CAP);
    expect(dropped).toBe(0); // survived — NOT dropped
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.byteLength).toBeLessThanOrEqual(AZURE_LIMIT);
    expect(chunks[0]!.byteLength).toBeLessThan(2_000_000); // actually truncated
    expect(countRecords(chunks[0]!)).toBe(1);
    // The body must decode as valid UTF-8 (fatal decoder throws on a split sequence),
    // end on the truncation marker, and contain no replacement char.
    const bodies = logBodies(chunks[0]!);
    expect(bodies.length).toBe(1);
    expect(bodies[0]).toContain('🦀'); // real emoji preserved, not mangled
    expect(bodies[0]!.endsWith('…[gateway-truncated]')).toBe(true);
    expect(bodies[0]).not.toContain('�'); // no mid-sequence corruption
  });

  it('chunks spans the same way and drops a single span too big to fit', () => {
    const spans = (count: number, bytes: number) => ({
      resourceSpans: [
        {
          resource: { attributes: [{ key: 'service.name', value: { stringValue: 'sessions-hub' } }] },
          scopeSpans: [
            {
              scope: { name: 't' },
              spans: Array.from({ length: count }, (_, i) => ({
                traceId: 'abcd'.repeat(8),
                spanId: 'abcd'.repeat(4),
                name: 'n'.repeat(bytes),
                startTimeUnixNano: String(1782964800000000000n + BigInt(i)),
                endTimeUnixNano: String(1782964800000000001n + BigInt(i)),
              })),
            },
          ],
        },
      ],
    });
    const split = encodeTraceChunks(spans(5, 300_000), CAP);
    expect(split.dropped).toBe(0);
    expect(split.chunks.length).toBeGreaterThan(1);
    for (const c of split.chunks) expect(c.byteLength).toBeLessThanOrEqual(CAP);
    expect(split.chunks.reduce((s, c) => s + countRecords(c), 0)).toBe(5);

    // A single span bigger than the cap can't be truncated (no dominant body) → dropped.
    const huge = encodeTraceChunks(spans(1, 2_000_000), CAP);
    expect(huge.dropped).toBe(1);
    expect(huge.chunks.length).toBe(0);
  });

  it('returns no chunks for an empty batch', () => {
    expect(encodeLogsChunks({ resourceLogs: [] }, CAP)).toEqual({ chunks: [], dropped: 0 });
    expect(encodeLogsChunks({}, CAP)).toEqual({ chunks: [], dropped: 0 });
  });
});
