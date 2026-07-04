/*
 * Flow engine — the non-reactive core of the Flow tab
 * (ARCH-planetar-flow-trace.md §5.2).
 *
 * Subscribes to the whole bus (`**`) and derives the topology from observed
 * traffic: producers from envelope `source`, lanes from topic families.
 * Nothing here is configured — a service exists on screen because its
 * messages do. Keeps a ring buffer of recent envelopes indexed by id /
 * causation / correlation so a message can be traced without leaving the
 * browser; the ontology's /trace API extends the walk beyond the buffer.
 *
 * React reads this through flowStore (4 Hz snapshots); the canvas renderer
 * reads it directly at frame rate. Deliberately mirrors the module-singleton
 * + ref-count pattern of useDetectionStreams.
 */

import type { ZmesgEnvelope } from '@/types/zmesg';
import { broker } from '@/lib/broker';
import { ontology } from '@/lib/ontology';

export type Modality = 'ais' | 'sar' | 'eo' | 'acoustic' | 'chat' | 'entity' | 'other';

/**
 * Categorical modality palette, validated (dataviz six-checks) against the
 * app's dark surfaces #0b101c/#131929: L 0.48–0.67, chroma ≥ 0.1, ≥3:1
 * contrast. Worst adjacent CVD pair is ΔE 10.3 — floor band, carried by the
 * ever-present text labels on lanes and nodes. --accent-hot red stays
 * reserved for alerts.
 */
export const MODALITY_COLORS: Record<Modality, string> = {
  ais: '#3987e5',
  acoustic: '#199e70',
  sar: '#c98500',
  entity: '#008300',
  eo: '#9085e9',
  chat: '#d55181',
  other: '#d95926',
};

/** Topic family = lane key: `vessel.*`/`chat.*` keep two segments, rest one. */
export function laneOf(topic: string): string {
  const seg = topic.split('.');
  if ((seg[0] === 'vessel' || seg[0] === 'chat') && seg.length > 1) {
    return `${seg[0]}.${seg[1]}`;
  }
  return seg[0] || '(none)';
}

export function modalityOf(lane: string): Modality {
  if (lane.startsWith('vessel.')) return 'ais';
  if (lane === 'sar' || lane === 'track') return 'sar';
  if (lane === 'eo') return 'eo';
  if (lane === 'acoustic') return 'acoustic';
  if (lane.startsWith('chat.') || lane === 'chat') return 'chat';
  if (lane.startsWith('entity')) return 'entity';
  return 'other';
}

export interface BufferedMsg {
  env: ZmesgEnvelope;
  receivedMs: number;
  lane: string;
  modality: Modality;
}

export interface NodeSnap {
  key: string;
  modality: Modality;
  total: number;
  rate: number; // msg/s, exponentially decayed (τ 5 s)
  lastMs: number;
  firstMs: number;
}

export interface LaneSnap extends NodeSnap {
  topics: { topic: string; total: number }[];
}

export interface EdgeSnap {
  producer: string;
  lane: string;
  modality: Modality;
  total: number;
  lastMs: number;
}

export interface ConsumerSnap {
  key: 'shell' | 'ontology' | 'wal';
  total: number;
  rate: number;
  status: 'live' | 'off';
}

export interface TickerEntry {
  id: string;
  topic: string;
  source: string;
  lane: string;
  modality: Modality;
  createdNs: string;
  receivedMs: number;
  hasCausation: boolean;
}

export interface FlowSnapshot {
  /** Wall-clock the snapshot was taken — age math stays out of React renders. */
  atMs: number;
  producers: NodeSnap[];
  lanes: LaneSnap[];
  edges: EdgeSnap[];
  consumers: ConsumerSnap[];
  recent: TickerEntry[];
  total: number;
  coalesced: number;
  entityEvents: number;
}

export type Spawn =
  | { kind: 'msg'; id: string; producer: string; lane: string; modality: Modality }
  | { kind: 'entity'; entityId: string };

const BUFFER_MAX = 3000;
const TICKER_MAX = 60;
const RATE_TAU_MS = 5000;

interface MutStats {
  total: number;
  rate: number;
  rateMs: number;
  lastMs: number;
  firstMs: number;
}

function newStats(now: number): MutStats {
  return { total: 0, rate: 0, rateMs: now, lastMs: now, firstMs: now };
}

/** One arrival on an exponentially-decayed rate meter (Unix-load style). */
function bump(s: MutStats, now: number): void {
  const decay = Math.exp(-(now - s.rateMs) / RATE_TAU_MS);
  s.rate = s.rate * decay + 1000 / RATE_TAU_MS;
  s.rateMs = now;
  s.lastMs = now;
  s.total++;
}

function readRate(s: MutStats, now: number): number {
  return s.rate * Math.exp(-(now - s.rateMs) / RATE_TAU_MS);
}

class FlowEngine {
  #buf = new Map<string, BufferedMsg>(); // insertion order = arrival order
  #children = new Map<string, string[]>(); // causationId → message ids
  #correlated = new Map<string, string[]>(); // correlationId → message ids
  #producers = new Map<string, MutStats & { modality: Modality }>();
  #lanes = new Map<string, MutStats & { modality: Modality; topics: Map<string, number> }>();
  #edges = new Map<string, { producer: string; lane: string; modality: Modality; total: number; lastMs: number }>();
  #shell: MutStats = newStats(0);
  #recent: TickerEntry[] = [];
  #spawnListeners = new Set<(s: Spawn) => void>();
  #total = 0;
  #coalesced = 0;
  #entityEvents = 0;
  #refs = 0;
  #unsubEnv: (() => void) | null = null;
  #unsubTopic: (() => void) | null = null;
  #unsubEntity: (() => void) | null = null;

  /** Ref-counted: first caller subscribes `**`, last caller tears down. */
  start(): void {
    if (++this.#refs > 1) return;
    this.#unsubTopic = broker.subscribe('**');
    this.#unsubEnv = broker.onEnvelope((env) => this.#ingest(env));
    this.#unsubEntity = ontology.onEntity((e) => {
      this.#entityEvents++;
      this.#emit({ kind: 'entity', entityId: e.id });
    });
  }

  stop(): void {
    if (--this.#refs > 0) return;
    this.#unsubEnv?.();
    this.#unsubTopic?.();
    this.#unsubEntity?.();
    this.#unsubEnv = this.#unsubTopic = this.#unsubEntity = null;
    // buffer and topology survive tab switches on purpose — history is cheap
  }

  onSpawn(l: (s: Spawn) => void): () => void {
    this.#spawnListeners.add(l);
    return () => {
      this.#spawnListeners.delete(l);
    };
  }

  #emit(s: Spawn): void {
    for (const l of this.#spawnListeners) l(s);
  }

  #ingest(env: ZmesgEnvelope): void {
    if (this.#buf.has(env.id)) return; // replay/echo guard
    const now = Date.now();
    const lane = laneOf(env.topic);
    const modality = modalityOf(lane);

    this.#buf.set(env.id, { env, receivedMs: now, lane, modality });
    if (env.causationId) {
      const kids = this.#children.get(env.causationId) ?? [];
      kids.push(env.id);
      this.#children.set(env.causationId, kids);
    }
    if (env.correlationId) {
      const sibs = this.#correlated.get(env.correlationId) ?? [];
      sibs.push(env.id);
      this.#correlated.set(env.correlationId, sibs);
    }
    if (this.#buf.size > BUFFER_MAX) this.#evictOldest();

    let p = this.#producers.get(env.source);
    if (!p) {
      p = { ...newStats(now), modality };
      this.#producers.set(env.source, p);
    }
    p.modality = modality; // a producer wears its latest traffic's colour
    bump(p, now);

    let ln = this.#lanes.get(lane);
    if (!ln) {
      ln = { ...newStats(now), modality, topics: new Map() };
      this.#lanes.set(lane, ln);
    }
    bump(ln, now);
    ln.topics.set(env.topic, (ln.topics.get(env.topic) ?? 0) + 1);

    const edgeKey = `${env.source}→${lane}`;
    const edge = this.#edges.get(edgeKey) ?? { producer: env.source, lane, modality, total: 0, lastMs: now };
    edge.total++;
    edge.lastMs = now;
    this.#edges.set(edgeKey, edge);

    bump(this.#shell, now);
    this.#total++;

    this.#recent.unshift({
      id: env.id,
      topic: env.topic,
      source: env.source,
      lane,
      modality,
      createdNs: env.createdAtNs,
      receivedMs: now,
      hasCausation: env.causationId !== '',
    });
    if (this.#recent.length > TICKER_MAX) this.#recent.pop();

    this.#emit({ kind: 'msg', id: env.id, producer: env.source, lane, modality });
  }

  #evictOldest(): void {
    const oldest = this.#buf.keys().next().value as string | undefined;
    if (!oldest) return;
    const m = this.#buf.get(oldest)!;
    this.#buf.delete(oldest);
    const unlink = (index: Map<string, string[]>, key: string): void => {
      const arr = index.get(key);
      if (!arr) return;
      const i = arr.indexOf(oldest);
      if (i >= 0) arr.splice(i, 1);
      if (arr.length === 0) index.delete(key);
    };
    if (m.env.causationId) unlink(this.#children, m.env.causationId);
    if (m.env.correlationId) unlink(this.#correlated, m.env.correlationId);
  }

  /** The renderer degrades honestly past the particle cap — count it. */
  noteCoalesced(): void {
    this.#coalesced++;
  }

  get(id: string): BufferedMsg | undefined {
    return this.#buf.get(id);
  }

  childrenOf(id: string): string[] {
    return this.#children.get(id) ?? [];
  }

  correlatedWith(correlationId: string): string[] {
    return this.#correlated.get(correlationId) ?? [];
  }

  snapshot(): FlowSnapshot {
    const now = Date.now();
    const producers: NodeSnap[] = [...this.#producers.entries()]
      .map(([key, s]) => ({
        key, modality: s.modality, total: s.total,
        rate: readRate(s, now), lastMs: s.lastMs, firstMs: s.firstMs,
      }))
      .sort((a, b) => a.firstMs - b.firstMs);
    const lanes: LaneSnap[] = [...this.#lanes.entries()]
      .map(([key, s]) => ({
        key, modality: s.modality, total: s.total,
        rate: readRate(s, now), lastMs: s.lastMs, firstMs: s.firstMs,
        topics: [...s.topics.entries()]
          .map(([topic, total]) => ({ topic, total }))
          .sort((a, b) => b.total - a.total),
      }))
      .sort((a, b) => a.firstMs - b.firstMs);
    const shellRate = readRate(this.#shell, now);
    const consumers: ConsumerSnap[] = [
      { key: 'shell', total: this.#shell.total, rate: shellRate, status: 'live' },
      {
        key: 'ontology', total: this.#entityEvents, rate: 0,
        status: ontology.getStatus() === 'open' ? 'live' : 'off',
      },
      // The broker WALs every message before fan-out — same totals as ingress.
      { key: 'wal', total: this.#total, rate: shellRate, status: broker.getStatus() === 'open' ? 'live' : 'off' },
    ];
    return {
      atMs: now,
      producers, lanes, consumers,
      edges: [...this.#edges.values()],
      recent: [...this.#recent],
      total: this.#total,
      coalesced: this.#coalesced,
      entityEvents: this.#entityEvents,
    };
  }
}

export const flowEngine = new FlowEngine();
