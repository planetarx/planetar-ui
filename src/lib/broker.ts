import { uuidv7 } from './uuidv7';
import type { ZmesgEnvelope } from '@/types/zmesg';

type Status = 'connecting' | 'open' | 'closed';
type StatusListener = (s: Status) => void;
type EnvelopeListener = (env: ZmesgEnvelope) => void;

// Build-time override (VITE_WS_URL): ws://localhost:7011 locally,
// wss://planetar.ca/ws in prod. Falls back to the legacy bridge port.
const DEFAULT_URL = import.meta.env.VITE_WS_URL ?? 'ws://127.0.0.1:9100';

interface OutboundPublish {
  topic: string;
  source: string;
  schemaName: string;
  schemaVersion?: number;
  correlationId?: string;
  causationId?: string;
  payload: unknown;
}

class BrokerClient {
  private ws: WebSocket | null = null;
  private url: string;
  private subscriptionRefs = new Map<string, number>();
  private statusListeners = new Set<StatusListener>();
  private envelopeListeners = new Set<EnvelopeListener>();
  private status: Status = 'closed';
  private reconnectTimer: number | null = null;

  constructor(url: string = DEFAULT_URL) {
    this.url = url;
  }

  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) return;
    this.setStatus('connecting');
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.setStatus('open');
      // Resubscribe to all known topics on reconnect
      const topics = Array.from(this.subscriptionRefs.keys());
      if (topics.length > 0) this.send({ type: 'subscribe', topics });
    });

    ws.addEventListener('message', (e) => {
      let msg: unknown;
      try {
        msg = JSON.parse(typeof e.data === 'string' ? e.data : '');
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      const m = msg as { type?: string; envelope?: ZmesgEnvelope };
      if (m.type === 'envelope' && m.envelope) {
        for (const l of this.envelopeListeners) l(m.envelope);
      }
    });

    ws.addEventListener('close', () => {
      this.setStatus('closed');
      this.scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      // Will be followed by close
    });
  }

  private scheduleReconnect() {
    if (this.reconnectTimer != null) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 1500);
  }

  private send(payload: unknown) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(payload));
  }

  private setStatus(s: Status) {
    if (this.status === s) return;
    this.status = s;
    for (const l of this.statusListeners) l(s);
  }

  getStatus(): Status {
    return this.status;
  }

  subscribe(topic: string): () => void {
    const prev = this.subscriptionRefs.get(topic) ?? 0;
    this.subscriptionRefs.set(topic, prev + 1);
    if (prev === 0) this.send({ type: 'subscribe', topics: [topic] });
    return () => this.unsubscribe(topic);
  }

  unsubscribe(topic: string): void {
    const cur = this.subscriptionRefs.get(topic) ?? 0;
    if (cur <= 1) {
      this.subscriptionRefs.delete(topic);
      this.send({ type: 'unsubscribe', topics: [topic] });
    } else {
      this.subscriptionRefs.set(topic, cur - 1);
    }
  }

  publish(p: OutboundPublish): string {
    const id = uuidv7();
    const now = String(BigInt(Date.now()) * 1_000_000n);
    const env: ZmesgEnvelope = {
      magic: 'ZMSG',
      version: 1,
      flags: 0,
      headerLen: 66,
      id,
      createdAtNs: now,
      storedAtNs: now,
      publishedAtNs: now,
      schemaVersion: p.schemaVersion ?? 1,
      topic: p.topic,
      source: p.source,
      schemaName: p.schemaName,
      correlationId: p.correlationId ?? '',
      causationId: p.causationId ?? '',
      payloadLen: 0,
      payload: p.payload,
    };
    this.send({ type: 'publish', envelope: env });
    return id;
  }

  onStatus(l: StatusListener): () => void {
    this.statusListeners.add(l);
    l(this.status);
    return () => this.statusListeners.delete(l);
  }

  onEnvelope(l: EnvelopeListener): () => void {
    this.envelopeListeners.add(l);
    return () => this.envelopeListeners.delete(l);
  }
}

export const broker = new BrokerClient();
broker.connect();
