import { describe, it, expect } from 'vitest';
import { encodeLogsRequest, encodeTraceRequest } from '../../gateway/otlp-protobuf';

// A minimal, self-contained protobuf reader — no external dependency — so the
// encoder is validated by decoding its own output back and asserting the OTLP
// structure round-trips (field numbers, wire types, bytes/enum/timestamp coding).
// Ported from youtube-mirror's test/unit/otlp-protobuf.test.ts.

interface Field {
  field: number;
  wire: number;
  value: bigint | Uint8Array;
}

function readVarint(buf: Uint8Array, pos: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  for (;;) {
    const byte = buf[pos++]!;
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7n;
  }
  return [result, pos];
}

function decode(buf: Uint8Array): Field[] {
  const fields: Field[] = [];
  let pos = 0;
  while (pos < buf.length) {
    const [tag, next] = readVarint(buf, pos);
    pos = next;
    const field = Number(tag >> 3n);
    const wire = Number(tag & 0x7n);
    if (wire === 0) {
      const [v, p] = readVarint(buf, pos);
      pos = p;
      fields.push({ field, wire, value: v });
    } else if (wire === 1) {
      fields.push({ field, wire, value: buf.slice(pos, pos + 8) });
      pos += 8;
    } else if (wire === 2) {
      const [len, p] = readVarint(buf, pos);
      pos = p;
      const n = Number(len);
      fields.push({ field, wire, value: buf.slice(pos, pos + n) });
      pos += n;
    } else if (wire === 5) {
      fields.push({ field, wire, value: buf.slice(pos, pos + 4) });
      pos += 4;
    } else {
      throw new Error(`unsupported wire type ${wire}`);
    }
  }
  return fields;
}

const bytes = (f: Field): Uint8Array => f.value as Uint8Array;
const str = (f: Field): string => new TextDecoder().decode(f.value as Uint8Array);
const num = (f: Field): bigint => f.value as bigint;
const fixed64le = (f: Field): bigint => {
  const b = f.value as Uint8Array;
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[i]!);
  return v;
};
const hex = (f: Field): string =>
  Array.from(f.value as Uint8Array).map((b) => b.toString(16).padStart(2, '0')).join('');

const only = (fields: Field[], field: number): Field => {
  const match = fields.filter((f) => f.field === field);
  expect(match.length).toBe(1);
  return match[0]!;
};

describe('encodeLogsRequest', () => {
  it("round-trips a log record's attributes, body, severity, timestamp and ids", () => {
    const json = {
      resourceLogs: [
        {
          resource: {
            attributes: [{ key: 'service.name', value: { stringValue: 'sessions-hub' } }],
          },
          scopeLogs: [
            {
              scope: { name: 'cf' },
              logRecords: [
                {
                  timeUnixNano: '1782964800855000000',
                  severityNumber: 9,
                  severityText: 'INFO',
                  body: { stringValue: '{"event":"hub.heartbeat"}' },
                  attributes: [{ key: 'http.status', value: { intValue: '200' } }],
                  traceId: '0102030405060708090a0b0c0d0e0f10',
                  spanId: '1112131415161718',
                },
              ],
            },
          ],
        },
      ],
    };

    const req = decode(encodeLogsRequest(json));
    const resourceLogs = decode(bytes(only(req, 1)));

    const resource = decode(bytes(only(resourceLogs, 1)));
    const resAttr = decode(bytes(only(resource, 1)));
    expect(str(only(resAttr, 1))).toBe('service.name');
    const resVal = decode(bytes(only(resAttr, 2)));
    expect(str(only(resVal, 1))).toBe('sessions-hub');

    const scopeLogs = decode(bytes(only(resourceLogs, 2)));
    expect(str(only(decode(bytes(only(scopeLogs, 1))), 1))).toBe('cf'); // scope.name

    const lr = decode(bytes(only(scopeLogs, 2)));
    expect(fixed64le(only(lr, 1))).toBe(1782964800855000000n); // timeUnixNano (fixed64)
    expect(num(only(lr, 2))).toBe(9n); // severityNumber (varint)
    expect(str(only(lr, 3))).toBe('INFO');
    expect(str(only(decode(bytes(only(lr, 5))), 1))).toBe('{"event":"hub.heartbeat"}'); // body.stringValue

    const attr = decode(bytes(only(lr, 6)));
    expect(str(only(attr, 1))).toBe('http.status');
    expect(num(only(decode(bytes(only(attr, 2))), 3))).toBe(200n); // intValue (varint, field 3)

    expect(hex(only(lr, 9))).toBe('0102030405060708090a0b0c0d0e0f10'); // traceId bytes
    expect(hex(only(lr, 10))).toBe('1112131415161718'); // spanId bytes
  });

  it('returns empty bytes for an empty request', () => {
    expect(encodeLogsRequest({}).length).toBe(0);
    expect(encodeLogsRequest({ resourceLogs: [] }).length).toBe(0);
  });
});

describe('encodeTraceRequest', () => {
  it("round-trips a span's ids, name, kind, timestamps and status", () => {
    const json = {
      resourceSpans: [
        {
          resource: { attributes: [{ key: 'service.name', value: { stringValue: 'sessions-hub' } }] },
          scopeSpans: [
            {
              scope: { name: 'cf' },
              spans: [
                {
                  traceId: '0102030405060708090a0b0c0d0e0f10',
                  spanId: '1112131415161718',
                  parentSpanId: '2122232425262728',
                  name: 'fetch',
                  kind: 2,
                  startTimeUnixNano: '1782964800000000000',
                  endTimeUnixNano: '1782964800500000000',
                  status: { code: 2, message: 'boom' },
                },
              ],
            },
          ],
        },
      ],
    };

    const req = decode(encodeTraceRequest(json));
    const resourceSpans = decode(bytes(only(req, 1)));
    const scopeSpans = decode(bytes(only(resourceSpans, 2)));
    const span = decode(bytes(only(scopeSpans, 2)));

    expect(hex(only(span, 1))).toBe('0102030405060708090a0b0c0d0e0f10'); // traceId
    expect(hex(only(span, 2))).toBe('1112131415161718'); // spanId
    expect(hex(only(span, 4))).toBe('2122232425262728'); // parentSpanId
    expect(str(only(span, 5))).toBe('fetch'); // name
    expect(num(only(span, 6))).toBe(2n); // kind (SERVER)
    expect(fixed64le(only(span, 7))).toBe(1782964800000000000n); // startTimeUnixNano
    expect(fixed64le(only(span, 8))).toBe(1782964800500000000n); // endTimeUnixNano

    const status = decode(bytes(only(span, 15)));
    expect(str(only(status, 2))).toBe('boom'); // status.message
    expect(num(only(status, 3))).toBe(2n); // status.code (ERROR)
  });

  it('accepts enum names as well as integers', () => {
    const json = {
      resourceSpans: [
        {
          scopeSpans: [
            { spans: [{ name: 's', kind: 'SPAN_KIND_CLIENT', status: { code: 'STATUS_CODE_OK' } }] },
          ],
        },
      ],
    };
    const span = decode(bytes(only(decode(bytes(only(decode(bytes(only(decode(encodeTraceRequest(json)), 1))), 2))), 2)));
    expect(num(only(span, 6))).toBe(3n); // SPAN_KIND_CLIENT
    expect(num(only(decode(bytes(only(span, 15))), 3))).toBe(1n); // STATUS_CODE_OK
  });
});
