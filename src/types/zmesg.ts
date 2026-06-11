// Mirrors zmesg.h envelope as JSON.
// Nanosecond timestamps are strings to preserve precision (JSON numbers
// lose precision above 2^53 — nanosecond-since-epoch overflows that).

export interface ZmesgEnvelope<TPayload = unknown> {
  magic: 'ZMSG';
  version: number;
  flags: number;
  headerLen: number;
  id: string;
  createdAtNs: string;
  storedAtNs: string;
  publishedAtNs: string;
  schemaVersion: number;
  topic: string;
  source: string;
  schemaName: string;
  correlationId: string;
  causationId: string;
  payloadLen: number;
  payload: TPayload;
}

export interface ChatPayload {
  text: string;
  author: {
    id: string;
    name: string;
    role?: string;
  };
}

export type ChatEnvelope = ZmesgEnvelope<ChatPayload>;

export function isChatEnvelope(env: ZmesgEnvelope): env is ChatEnvelope {
  return env.schemaName === 'chat.v1.Message';
}
