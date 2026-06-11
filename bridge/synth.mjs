// Synthetic chatter publisher. Connects to planetar-broker producer port and
// emits realistic zmesg envelopes per channel topic, so the demo has live
// traffic without a human typing in the UI. Just another producer — the
// broker is content-agnostic; bridge sees these via its SUB ** and fans out.

import net from 'node:net';
import { v7 as uuidv7 } from 'uuid';
import { encodeEnvelope, frameTCP } from './zmesg.mjs';

const BROKER_HOST = process.env.BROKER_HOST ?? '127.0.0.1';
const BROKER_PUB_PORT = Number(process.env.BROKER_PUB_PORT ?? 12001);

const TOPICS = [
  'chat.pac.ais-anomalies',
  'chat.pac.sar-detections',
  'chat.pac.eo-chips',
  'chat.pac.hydrophone-alerts',
  'chat.pac.rf-emitters',
  'chat.pac.general',
];

const PERSONAS = [
  { id: 'op-aleph',   name: 'aleph',   role: 'analyst' },
  { id: 'op-beth',    name: 'beth',    role: 'analyst' },
  { id: 'op-gimel',   name: 'gimel',   role: 'watch'   },
  { id: 'agent-asr',  name: 'asr',     role: 'agent'   },
  { id: 'agent-fuse', name: 'fuse',    role: 'agent'   },
];

// Channels owned by a dedicated autonomous producer rather than human
// operators. #sar-detections is fed by the planetar-sat microservice — its
// envelopes carry the agent-sat persona, matching the real service
// (planetar-sat/src/planetar_sat/bus/chat.py).
const CHANNEL_AGENT = {
  'sar-detections': { id: 'agent-sat', name: 'sat', role: 'agent' },
};

const PHRASES = {
  'ais-anomalies': [
    'AIS gap on ⟦MMSI 477123400⟧ — 41 min, last seen 48.42N 123.18W',
    'speed drop on ⟦MMSI 538009876⟧, sliding under 2 kn near Active Pass',
    'fresh dark zone west of Pachena Pt, 3 vessels lost in last hour',
    'class A pings from ⟦MMSI 311045221⟧ in the SAR-only window — odd',
    'consolidating yesterday into a thread, see ⟦CASE-PNW-0512⟧',
  ],
  // Lines mirror planetar-sat's detection_line / track_line formatting so the
  // synthetic feed reads identically to real planetar-sat output.
  'sar-detections': [
    'Sentinel-1 GRD ⟦S1A_IW_20260513T1402_juan-de-fuca_vv⟧ — 7 CFAR detections, 2 unmatched',
    'Sentinel-1 GRD ⟦S1A_IW_20260513T0231_la-perouse_vv⟧ — 4 CFAR detections, 1 unmatched',
    'track ⟦0c79d9c1⟧ updated — 48.4982°N 123.9218°W, 6.2 kn, 3 hits',
    'track ⟦ec83adc2⟧ updated — 49.0140°N 125.7100°W, 0.0 kn, 1 hit',
    'track ⟦7b1f04a3⟧ updated — 48.4350°N 123.9650°W, 11.4 kn, 8 hits',
  ],
  'eo-chips': [
    'Planet SkySat chips queued for the 3 dark candidates',
    'cloud at 70% over the western box, waiting on next pass',
    '⟦MMSI 477123400⟧ candidate chip looks like a 200m bulker — flag class mismatch',
  ],
  'hydrophone-alerts': [
    'ONC node Folger Pt: tonal at 110 Hz, 12 min, drifting south',
    'low-freq thrum at Barkley node — engine, not whale',
    'no correlated AIS, hand-flagging',
  ],
  'rf-emitters': [
    'X-band burst detected at 48.91N 124.55W, ~3.2 GHz',
    'AIS-class B transmitter active without registered MMSI',
  ],
  'general': [
    'morning all, watch starts at 14Z',
    'standing up the dark-vessel board for the week',
    '⟦ONC⟧ node feed is back up',
  ],
};

let sock = null;
let connected = false;

function connect() {
  sock = net.connect({ host: BROKER_HOST, port: BROKER_PUB_PORT });
  sock.setNoDelay(true);
  sock.once('connect', () => {
    connected = true;
    console.log(`[synth] connected to broker ${BROKER_HOST}:${BROKER_PUB_PORT}`);
  });
  sock.once('close', () => {
    if (connected) console.log('[synth] disconnected; retrying in 2s');
    connected = false;
    sock = null;
    setTimeout(connect, 2000);
  });
  sock.once('error', (e) => {
    if (connected) console.log(`[synth] error: ${e.message}`);
    try { sock?.destroy(); } catch { /* ignore */ }
  });
}

function publish(topic) {
  if (!sock || !connected || !sock.writable) return;
  const tail = topic.split('.').pop();
  const persona = CHANNEL_AGENT[tail] ?? PERSONAS[Math.floor(Math.random() * PERSONAS.length)];
  const list = PHRASES[tail] ?? PHRASES.general;
  const text = list[Math.floor(Math.random() * list.length)];
  const now = String(BigInt(Date.now()) * 1_000_000n);
  try {
    const buf = encodeEnvelope({
      id: uuidv7(),
      topic,
      source: persona.id,
      schemaName: 'chat.v1.Message',
      schemaVersion: 1,
      createdAtNs: now,
      storedAtNs: now,
      publishedAtNs: now,
      payload: { text, author: { id: persona.id, name: persona.name, role: persona.role } },
    });
    sock.write(frameTCP(buf));
  } catch (e) {
    console.log(`[synth] publish failed: ${e.message}`);
  }
}

connect();

for (const t of TOPICS) {
  const tick = () => {
    publish(t);
    setTimeout(tick, 4000 + Math.floor(Math.random() * 11000));
  };
  setTimeout(tick, 500 + Math.floor(Math.random() * 1500));
}

process.on('SIGINT', () => process.exit(0));
