// Binary zmesg envelope codec for Node. Mirrors ~/github/sness23/zmesg/zmesg.h.
//
// On-wire layout (TCP):
//   [4-byte uint32 length, big-endian (network byte order)]
//   [envelope bytes ...]
//
// Envelope (66-byte fixed header + variable fields, all little-endian, packed):
//   off  size  field
//     0     4  magic        uint32 = 0x5A4D5347 ("ZMSG" when read LE-as-ASCII)
//     4     1  version      uint8  = 1
//     5     1  flags        uint8  = 0
//     6     2  header_len   uint16 = 66 + sum(variable field lengths)
//     8    16  id           bytes  (UUIDv7)
//    24     8  created_at_ns  uint64
//    32     8  stored_at_ns   uint64
//    40     8  published_at_ns uint64
//    48     2  topic_len      uint16
//    50     2  source_len     uint16
//    52     2  schema_name_len uint16
//    54     2  correlation_id_len uint16
//    56     2  causation_id_len uint16
//    58     4  schema_version uint32
//    62     4  payload_len    uint32
//   then: topic | source | schema_name | correlation_id | causation_id | payload

import { Buffer } from 'node:buffer';

export const ZMESG_MAGIC = 0x5a4d5347; // "ZMSG" read little-endian
export const ZMESG_FIXED_HDR = 66;
export const ZMESG_VERSION = 1;

function uuidToBytes(id) {
  const hex = String(id).replace(/-/g, '');
  if (hex.length !== 32) throw new Error(`bad uuid: ${id}`);
  return Buffer.from(hex, 'hex');
}

function bytesToUuid(buf) {
  const hex = buf.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function toBuf(v) {
  if (Buffer.isBuffer(v)) return v;
  if (v == null) return Buffer.alloc(0);
  if (typeof v === 'string') return Buffer.from(v, 'utf8');
  return Buffer.from(JSON.stringify(v), 'utf8');
}

/**
 * @param {{ id: string, topic: string, source: string, schemaName: string,
 *           schemaVersion?: number, correlationId?: string, causationId?: string,
 *           createdAtNs: string|bigint, storedAtNs?: string|bigint,
 *           publishedAtNs?: string|bigint, payload: unknown }} env
 * @returns {Buffer}
 */
export function encodeEnvelope(env) {
  const topicBuf = toBuf(env.topic);
  const sourceBuf = toBuf(env.source);
  const schemaBuf = toBuf(env.schemaName);
  const corrBuf = toBuf(env.correlationId ?? '');
  const causBuf = toBuf(env.causationId ?? '');
  const payloadBuf = toBuf(env.payload);

  if (topicBuf.length > 256) throw new Error('topic exceeds 256 bytes');

  const headerLen =
    ZMESG_FIXED_HDR + topicBuf.length + sourceBuf.length + schemaBuf.length + corrBuf.length + causBuf.length;
  const total = headerLen + payloadBuf.length;

  const buf = Buffer.alloc(total);
  buf.writeUInt32LE(ZMESG_MAGIC, 0);
  buf.writeUInt8(ZMESG_VERSION, 4);
  buf.writeUInt8(env.flags ?? 0, 5);
  buf.writeUInt16LE(headerLen, 6);
  uuidToBytes(env.id).copy(buf, 8);
  buf.writeBigUInt64LE(BigInt(env.createdAtNs), 24);
  buf.writeBigUInt64LE(BigInt(env.storedAtNs ?? env.createdAtNs), 32);
  buf.writeBigUInt64LE(BigInt(env.publishedAtNs ?? env.createdAtNs), 40);
  buf.writeUInt16LE(topicBuf.length, 48);
  buf.writeUInt16LE(sourceBuf.length, 50);
  buf.writeUInt16LE(schemaBuf.length, 52);
  buf.writeUInt16LE(corrBuf.length, 54);
  buf.writeUInt16LE(causBuf.length, 56);
  buf.writeUInt32LE(env.schemaVersion ?? 1, 58);
  buf.writeUInt32LE(payloadBuf.length, 62);

  let o = ZMESG_FIXED_HDR;
  topicBuf.copy(buf, o);
  o += topicBuf.length;
  sourceBuf.copy(buf, o);
  o += sourceBuf.length;
  schemaBuf.copy(buf, o);
  o += schemaBuf.length;
  corrBuf.copy(buf, o);
  o += corrBuf.length;
  causBuf.copy(buf, o);
  o += causBuf.length;
  payloadBuf.copy(buf, o);

  return buf;
}

/**
 * Decode an envelope. Payload is returned as JSON if parseable, else as a Buffer.
 * @param {Buffer} buf
 */
export function decodeEnvelope(buf) {
  if (buf.length < ZMESG_FIXED_HDR) throw new Error('envelope shorter than fixed header');
  const magic = buf.readUInt32LE(0);
  if (magic !== ZMESG_MAGIC) {
    throw new Error(`bad magic 0x${magic.toString(16)} (expected 0x${ZMESG_MAGIC.toString(16)})`);
  }
  const version = buf.readUInt8(4);
  const flags = buf.readUInt8(5);
  const headerLen = buf.readUInt16LE(6);
  const id = bytesToUuid(buf.subarray(8, 24));
  const createdAtNs = buf.readBigUInt64LE(24);
  const storedAtNs = buf.readBigUInt64LE(32);
  const publishedAtNs = buf.readBigUInt64LE(40);
  const topicLen = buf.readUInt16LE(48);
  const sourceLen = buf.readUInt16LE(50);
  const schemaLen = buf.readUInt16LE(52);
  const corrLen = buf.readUInt16LE(54);
  const causLen = buf.readUInt16LE(56);
  const schemaVersion = buf.readUInt32LE(58);
  const payloadLen = buf.readUInt32LE(62);

  let o = ZMESG_FIXED_HDR;
  const topic = buf.subarray(o, o + topicLen).toString('utf8');
  o += topicLen;
  const source = buf.subarray(o, o + sourceLen).toString('utf8');
  o += sourceLen;
  const schemaName = buf.subarray(o, o + schemaLen).toString('utf8');
  o += schemaLen;
  const correlationId = buf.subarray(o, o + corrLen).toString('utf8');
  o += corrLen;
  const causationId = buf.subarray(o, o + causLen).toString('utf8');
  o += causLen;
  const payloadBuf = buf.subarray(o, o + payloadLen);

  let payload;
  try {
    payload = JSON.parse(payloadBuf.toString('utf8'));
  } catch {
    payload = payloadBuf.toString('utf8'); // fallback to string; binary payloads are unexpected here
  }

  return {
    magic: 'ZMSG',
    version,
    flags,
    headerLen,
    id,
    createdAtNs: createdAtNs.toString(),
    storedAtNs: storedAtNs.toString(),
    publishedAtNs: publishedAtNs.toString(),
    schemaVersion,
    topic,
    source,
    schemaName,
    correlationId,
    causationId,
    payloadLen,
    payload,
  };
}

/** TCP frame: prepend 4-byte big-endian length. */
export function frameTCP(envelopeBuf) {
  const len = Buffer.allocUnsafe(4);
  len.writeUInt32BE(envelopeBuf.length, 0);
  return Buffer.concat([len, envelopeBuf]);
}

/** Streaming parser for length-prefixed TCP frames. */
export class TCPFrameParser {
  constructor() {
    this.buf = Buffer.alloc(0);
  }
  push(chunk, onFrame) {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0);
      if (len === 0 || len > 16 * 1024 * 1024) {
        // bogus length — reset stream
        this.buf = Buffer.alloc(0);
        return;
      }
      if (this.buf.length < 4 + len) break;
      const frame = Buffer.from(this.buf.subarray(4, 4 + len));
      this.buf = this.buf.subarray(4 + len);
      onFrame(frame);
    }
  }
}
