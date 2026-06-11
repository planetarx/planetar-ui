// planetar-ui bridge — WebSocket↔planetar-broker proxy.
//
// WebSocket protocol (UI side, unchanged):
//   client → server:
//     { type: "subscribe",   topics: ["chat.pac.ais-anomalies", ...] }
//     { type: "unsubscribe", topics: [...] }
//     { type: "publish",     envelope: ZmesgEnvelope }
//   server → client:
//     { type: "envelope",  envelope: ZmesgEnvelope }
//     { type: "ack",       id: <uuid> }
//
// Broker side: TCP to planetar-broker on 12001 (PUB) and 12002 (SUB). Binary
// zmesg envelopes, 4-byte BE length prefix. Bridge subscribes with `SUB **\n`
// to receive every envelope and fans out to its WS clients by topic.
//
// Modes:
//   real — broker reachable; UI publishes round-trip through the C bus.
//   mock — broker unreachable; bridge self-echoes and emits synthetic chatter.
// The bridge probes for the broker on startup and on a 2s retry timer.

import net from 'node:net';
import { WebSocketServer } from 'ws';
import { v7 as uuidv7 } from 'uuid';
import { encodeEnvelope, decodeEnvelope, frameTCP, TCPFrameParser } from './zmesg.mjs';

const PORT = Number(process.env.BRIDGE_PORT ?? 9100);
const BROKER_HOST = process.env.BROKER_HOST ?? '127.0.0.1';
const BROKER_PUB_PORT = Number(process.env.BROKER_PUB_PORT ?? 12001);
const BROKER_SUB_PORT = Number(process.env.BROKER_SUB_PORT ?? 12002);
const SYNTHETIC = (process.env.BRIDGE_SYNTHETIC ?? '1') !== '0';

// ---------------- synthetic chatter (mock-mode only) ----------------

const PERSONAS = [
  { id: 'op-aleph',   name: 'aleph',   role: 'analyst' },
  { id: 'op-beth',    name: 'beth',    role: 'analyst' },
  { id: 'op-gimel',   name: 'gimel',   role: 'watch'   },
  { id: 'agent-asr',  name: 'asr',     role: 'agent'   },
  { id: 'agent-fuse', name: 'fuse',    role: 'agent'   },
];

const PHRASES = {
  'ais-anomalies': [
    'AIS gap on ⟦MMSI 477123400⟧ — 41 min, last seen 48.42N 123.18W',
    'speed drop on ⟦MMSI 538009876⟧, sliding under 2 kn near Active Pass',
    'fresh dark zone west of Pachena Pt, 3 vessels lost in last hour',
    'class A pings from ⟦MMSI 311045221⟧ in the SAR-only window — odd',
  ],
  'sar-detections': [
    'Sentinel-1 IW pass 14:02Z — 7 detections, 2 unmatched',
    'detection cluster off La Pérouse, footprint ⟦SAR-2026-05-13-08⟧',
    'no AIS within 8 nm of detection at 49.01N 125.71W',
  ],
  'eo-chips': [
    'Planet SkySat chips queued for the 3 dark candidates',
    'cloud at 70% over the western box, waiting on next pass',
  ],
  'hydrophone-alerts': [
    'ONC node Folger Pt: tonal at 110 Hz, 12 min, drifting south',
    'low-freq thrum at Barkley node — engine, not whale',
  ],
  'rf-emitters': [
    'X-band burst detected at 48.91N 124.55W, ~3.2 GHz',
    'AIS-class B transmitter active without registered MMSI',
  ],
  'general': [
    'morning all, watch starts at 14Z',
    'standing up the dark-vessel board for the week',
  ],
  'default': [
    'rolling sync — anything new?',
    'queue is quiet, watching the feeds',
  ],
};

function nowNs() {
  return String(BigInt(Date.now()) * 1_000_000n + BigInt(Math.floor(Math.random() * 1_000_000)));
}

function utf8Bytes(s) {
  return Buffer.byteLength(s, 'utf8');
}

function buildEnvelope({ topic, source, payload, schemaName, schemaVersion = 1, correlationId = '', causationId = '', id }) {
  const created = nowNs();
  const text = JSON.stringify(payload);
  const headerLen = 66 + utf8Bytes(topic) + utf8Bytes(source) + utf8Bytes(schemaName) + utf8Bytes(correlationId) + utf8Bytes(causationId);
  return {
    magic: 'ZMSG',
    version: 1,
    flags: 0,
    headerLen,
    id: id ?? uuidv7(),
    createdAtNs: created,
    storedAtNs: created,
    publishedAtNs: created,
    schemaVersion,
    topic,
    source,
    schemaName,
    correlationId,
    causationId,
    payloadLen: utf8Bytes(text),
    payload,
  };
}

const topicTail = (topic) => {
  const p = topic.split('.');
  return p[p.length - 1] ?? topic;
};
const pickPhrase = (topic) => {
  const list = PHRASES[topicTail(topic)] ?? PHRASES.default;
  return list[Math.floor(Math.random() * list.length)];
};
const pickPersona = () => PERSONAS[Math.floor(Math.random() * PERSONAS.length)];

// ---------------- broker link ----------------

class BrokerLink {
  constructor() {
    this.producer = null;
    this.consumer = null;
    this.parser = new TCPFrameParser();
    this.state = 'idle'; // idle | connecting | open
    this.reconnectTimer = null;
    this.consumerHandshakeOk = false;
    this.consumerBuf = Buffer.alloc(0);
    this.onEnvelope = () => {};
    this.onStateChange = () => {};
  }

  isOpen() {
    return this.state === 'open';
  }

  setState(s) {
    if (this.state === s) return;
    console.log(`[broker] ${this.state} → ${s}`);
    this.state = s;
    this.onStateChange(s);
  }

  start() {
    this.attemptConnect();
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.attemptConnect();
    }, 2000);
  }

  cleanup() {
    if (this.producer) { try { this.producer.destroy(); } catch {} this.producer = null; }
    if (this.consumer) { try { this.consumer.destroy(); } catch {} this.consumer = null; }
    this.parser = new TCPFrameParser();
    this.consumerBuf = Buffer.alloc(0);
    this.consumerHandshakeOk = false;
    this.setState('idle');
  }

  attemptConnect() {
    if (this.state === 'connecting' || this.state === 'open') return;
    this.setState('connecting');

    let producerReady = false;
    let consumerReady = false;
    const tryComplete = () => {
      if (producerReady && consumerReady) this.setState('open');
    };

    const failAll = (which, err) => {
      console.log(`[broker] ${which} failed: ${err?.message ?? 'closed'}`);
      this.cleanup();
      this.scheduleReconnect();
    };

    this.producer = net.connect({ host: BROKER_HOST, port: BROKER_PUB_PORT });
    this.producer.setNoDelay(true);
    this.producer.once('connect', () => { producerReady = true; tryComplete(); });
    this.producer.once('error', (e) => failAll('producer', e));
    this.producer.once('close', () => { if (this.state === 'open') failAll('producer', new Error('close')); });

    this.consumer = net.connect({ host: BROKER_HOST, port: BROKER_SUB_PORT });
    this.consumer.setNoDelay(true);
    this.consumer.once('connect', () => {
      this.consumer.write('SUB **\n');
    });
    this.consumer.once('error', (e) => failAll('consumer', e));
    this.consumer.once('close', () => { if (this.state === 'open') failAll('consumer', new Error('close')); });
    this.consumer.on('data', (chunk) => {
      if (!this.consumerHandshakeOk) {
        this.consumerBuf = Buffer.concat([this.consumerBuf, chunk]);
        const nl = this.consumerBuf.indexOf(0x0a);
        if (nl < 0) return;
        const line = this.consumerBuf.subarray(0, nl).toString('utf8');
        if (!line.startsWith('OK')) {
          console.log(`[broker] SUB rejected: ${line}`);
          failAll('consumer', new Error(line));
          return;
        }
        this.consumerHandshakeOk = true;
        consumerReady = true;
        tryComplete();
        const rest = this.consumerBuf.subarray(nl + 1);
        this.consumerBuf = Buffer.alloc(0);
        if (rest.length > 0) this.feedFrames(rest);
        return;
      }
      this.feedFrames(chunk);
    });
  }

  feedFrames(chunk) {
    this.parser.push(chunk, (frame) => {
      try {
        const env = decodeEnvelope(frame);
        this.onEnvelope(env);
      } catch (e) {
        console.log(`[broker] decode error: ${e.message}`);
      }
    });
  }

  publish(envelopeJson) {
    if (!this.isOpen() || !this.producer) return false;
    try {
      const buf = encodeEnvelope({
        id: envelopeJson.id,
        topic: envelopeJson.topic,
        source: envelopeJson.source,
        schemaName: envelopeJson.schemaName,
        schemaVersion: envelopeJson.schemaVersion ?? 1,
        correlationId: envelopeJson.correlationId ?? '',
        causationId: envelopeJson.causationId ?? '',
        createdAtNs: envelopeJson.createdAtNs,
        storedAtNs: envelopeJson.storedAtNs ?? envelopeJson.createdAtNs,
        publishedAtNs: envelopeJson.publishedAtNs ?? envelopeJson.createdAtNs,
        payload: envelopeJson.payload,
      });
      this.producer.write(frameTCP(buf));
      return true;
    } catch (e) {
      console.log(`[broker] encode/write failed: ${e.message}`);
      return false;
    }
  }
}

const broker = new BrokerLink();

// ---------------- WS server + fan-out ----------------

const wss = new WebSocketServer({ port: PORT, host: '127.0.0.1' });

wss.on('listening', () => {
  console.log(`[bridge] listening on ws://127.0.0.1:${PORT} · synthetic=${SYNTHETIC ? 'on' : 'off'}`);
  broker.start();
});

function dispatchEnvelope(env) {
  for (const ws of wss.clients) {
    if (ws.readyState !== 1) continue;
    const c = ws._planetarClient;
    if (!c?.subscriptions.has(env.topic)) continue;
    ws.send(JSON.stringify({ type: 'envelope', envelope: env }));
  }
}

broker.onEnvelope = dispatchEnvelope;
broker.onStateChange = (s) => {
  console.log(`[bridge] broker state → ${s}; mode=${s === 'open' ? 'real' : 'mock'}`);
};

function emitSynthetic(client, topic) {
  if (broker.isOpen()) return; // real mode handles fan-out via broker
  if (!client.subscriptions.has(topic)) return;
  if (client.socket.readyState !== 1) return;
  const persona = pickPersona();
  const env = buildEnvelope({
    topic,
    source: persona.id,
    schemaName: 'chat.v1.Message',
    payload: {
      text: pickPhrase(topic),
      author: { id: persona.id, name: persona.name, role: persona.role },
    },
  });
  client.socket.send(JSON.stringify({ type: 'envelope', envelope: env }));
}

function scheduleSynthetic(client, topic) {
  if (!SYNTHETIC) return;
  const delay = 4000 + Math.floor(Math.random() * 11000);
  const t = setTimeout(() => {
    emitSynthetic(client, topic);
    if (client.subscriptions.has(topic)) scheduleSynthetic(client, topic);
  }, delay);
  client.timers.push(t);
}

wss.on('connection', (socket, req) => {
  const client = {
    id: uuidv7(),
    socket,
    subscriptions: new Set(),
    timers: [],
  };
  socket._planetarClient = client;
  console.log(`[bridge] client ${client.id.slice(0, 8)} connected from ${req.socket.remoteAddress}`);

  socket.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      socket.send(JSON.stringify({ type: 'error', message: 'invalid JSON' }));
      return;
    }

    if (msg.type === 'subscribe' && Array.isArray(msg.topics)) {
      for (const t of msg.topics) {
        if (typeof t !== 'string' || client.subscriptions.has(t)) continue;
        client.subscriptions.add(t);
        if (broker.isOpen()) {
          // Real mode: broker is already piping us everything via the
          // bridge-wide SUB **. Nothing to do here; dispatch will filter.
        } else {
          scheduleSynthetic(client, t);
          setTimeout(() => emitSynthetic(client, t), 250 + Math.floor(Math.random() * 750));
        }
      }
      return;
    }

    if (msg.type === 'unsubscribe' && Array.isArray(msg.topics)) {
      for (const t of msg.topics) client.subscriptions.delete(t);
      return;
    }

    if (msg.type === 'publish' && msg.envelope) {
      const e = msg.envelope;
      const stamped = buildEnvelope({
        id: e.id,
        topic: e.topic,
        source: e.source ?? 'ui',
        schemaName: e.schemaName ?? 'chat.v1.Message',
        schemaVersion: e.schemaVersion ?? 1,
        correlationId: e.correlationId ?? '',
        causationId: e.causationId ?? '',
        payload: e.payload,
      });

      if (broker.isOpen()) {
        // Route through the real bus; echo comes back via consumer dispatch.
        broker.publish(stamped);
      } else {
        // Mock-mode self-echo to all local subscribers.
        dispatchEnvelope(stamped);
      }
      socket.send(JSON.stringify({ type: 'ack', id: stamped.id }));
      return;
    }
  });

  socket.on('close', () => {
    for (const t of client.timers) clearTimeout(t);
    client.timers = [];
    console.log(`[bridge] client ${client.id.slice(0, 8)} disconnected`);
  });
});

process.on('SIGINT', () => {
  console.log('\n[bridge] shutting down');
  wss.close(() => process.exit(0));
});
