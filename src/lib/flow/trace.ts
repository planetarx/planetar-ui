/*
 * Trace assembly — merge the browser's ring buffer with the ontology's
 * /trace index into one causal picture (ARCH-planetar-flow-trace.md §5.4).
 *
 * The buffer knows the last ~3000 envelopes with payloads and local receipt
 * times; the ontology knows metadata further back. Rows found locally win
 * (they carry receivedMs); the union is re-walked here so ancestors and
 * descendants are consistent regardless of which side knew which hop.
 */

import type { TraceEnvelope } from '@/lib/ontology';
import { ontology } from '@/lib/ontology';
import { flowEngine, laneOf, modalityOf } from './engine';
import type { Modality } from './engine';

export interface TraceRow {
  id: string;
  topic: string;
  source: string;
  schemaName: string | null;
  correlationId: string | null;
  causationId: string | null;
  createdNs: string;
  storedNs: string | null;
  publishedNs: string | null;
  receivedMs: number | null; // local receipt (approximate cross-clock hop)
  inBuffer: boolean;
  lane: string;
  modality: Modality;
}

export interface TraceResult {
  id: string;
  row: TraceRow | null;
  ancestors: TraceRow[]; // nearest parent first
  descendants: { row: TraceRow; depth: number }[]; // BFS order
  correlated: TraceRow[];
  missingAncestorId: string | null;
  entity: { id: string; type: string; name: string | null; fields: string[] } | null;
  remote: 'ok' | 'unavailable';
}

function localRow(id: string): TraceRow | null {
  const m = flowEngine.get(id);
  if (!m) return null;
  const e = m.env;
  return {
    id: e.id,
    topic: e.topic,
    source: e.source,
    schemaName: e.schemaName || null,
    correlationId: e.correlationId || null,
    causationId: e.causationId || null,
    createdNs: e.createdAtNs,
    storedNs: e.storedAtNs,
    publishedNs: e.publishedAtNs,
    receivedMs: m.receivedMs,
    inBuffer: true,
    lane: m.lane,
    modality: m.modality,
  };
}

function remoteRow(e: TraceEnvelope): TraceRow {
  const lane = laneOf(e.topic);
  return {
    ...e,
    schemaName: e.schemaName || null,
    correlationId: e.correlationId || null,
    causationId: e.causationId || null,
    receivedMs: null,
    inBuffer: false,
    lane,
    modality: modalityOf(lane),
  };
}

export async function assembleTrace(id: string): Promise<TraceResult> {
  const known = new Map<string, TraceRow>();
  const childIndex = new Map<string, Set<string>>();
  const addChild = (parent: string, child: string): void => {
    const s = childIndex.get(parent) ?? new Set();
    s.add(child);
    childIndex.set(parent, s);
  };
  const learn = (row: TraceRow | null): void => {
    if (!row) return;
    if (!known.has(row.id) || row.inBuffer) known.set(row.id, row);
    if (row.causationId) addChild(row.causationId, row.id);
  };

  learn(localRow(id));

  let remote: TraceResult['remote'] = 'unavailable';
  let entity: TraceResult['entity'] = null;
  let remoteCorrelated: TraceEnvelope[] = [];
  try {
    const t = await ontology.getTrace(id);
    remote = 'ok';
    entity = t.entity;
    remoteCorrelated = t.correlated;
    if (t.envelope) learn(remoteRow(t.envelope));
    for (const e of [...t.ancestors, ...t.descendants, ...t.correlated]) learn(remoteRow(e));
  } catch {
    // ontology down or unreachable — the buffer-only trace still stands
  }

  // Pull buffer-known relatives into the map so the walk sees both sides.
  const row = known.get(id) ?? null;
  let cursor = row?.causationId ?? null;
  for (let i = 0; cursor && i < 32; i++) {
    const parent = known.get(cursor) ?? localRow(cursor);
    if (!parent) break;
    learn(parent);
    cursor = parent.causationId;
  }
  const localQueue = [id];
  while (localQueue.length) {
    const cur = localQueue.shift()!;
    for (const childId of flowEngine.childrenOf(cur)) {
      if (known.has(childId)) continue;
      const child = localRow(childId);
      if (!child) continue;
      learn(child);
      localQueue.push(childId);
    }
  }

  // Re-walk the merged map — one consistent chain and tree.
  const ancestors: TraceRow[] = [];
  let missingAncestorId: string | null = null;
  const seen = new Set<string>([id]);
  cursor = row?.causationId ?? null;
  while (cursor && ancestors.length < 32) {
    if (seen.has(cursor)) break; // cycle guard
    const parent = known.get(cursor);
    if (!parent) {
      missingAncestorId = cursor; // beyond both buffer and retention
      break;
    }
    seen.add(cursor);
    ancestors.push(parent);
    cursor = parent.causationId;
  }

  const descendants: { row: TraceRow; depth: number }[] = [];
  const queue: { id: string; depth: number }[] = [{ id, depth: 0 }];
  while (queue.length && descendants.length < 100) {
    const cur = queue.shift()!;
    for (const childId of childIndex.get(cur.id) ?? []) {
      if (seen.has(childId)) continue;
      const child = known.get(childId);
      if (!child) continue;
      seen.add(childId);
      descendants.push({ row: child, depth: cur.depth + 1 });
      queue.push({ id: childId, depth: cur.depth + 1 });
    }
  }

  const correlated: TraceRow[] = [];
  const corrIds = new Set<string>(remoteCorrelated.map((e) => e.id));
  if (row?.correlationId) {
    for (const cid of flowEngine.correlatedWith(row.correlationId)) corrIds.add(cid);
  }
  for (const cid of corrIds) {
    if (seen.has(cid) || correlated.length >= 50) continue;
    const r = known.get(cid);
    if (r) correlated.push(r);
  }
  correlated.sort((a, b) => (BigInt(a.createdNs) < BigInt(b.createdNs) ? -1 : 1));

  return { id, row, ancestors, descendants, correlated, missingAncestorId, entity, remote };
}
