// Flow tab — the live data-flow graph (ARCH-planetar-flow-trace.md §5).
//
// Topology is OBSERVED, not configured: producers appear because their
// envelopes do, lanes are topic families seen on the bus, and every particle
// on the canvas is one real message. Click a particle or a ticker row to
// open the trace panel; click a node or lane for its stats. The DOM renders
// the cards, the canvas (pointer-events:none, on top) renders edges and
// particles; both read the same computed layout so geometry agrees.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useFlow } from '@/hooks/useFlow';
import { useFlowStore } from '@/store/flowStore';
import type { FlowSelection } from '@/store/flowStore';
import { useBrokerStatus } from '@/hooks/useBroker';
import { MODALITY_COLORS } from '@/lib/flow/engine';
import type { ConsumerSnap, FlowSnapshot, LaneSnap, NodeSnap, TickerEntry } from '@/lib/flow/engine';
import { flowEngine } from '@/lib/flow/engine';
import { computeLayout } from '@/lib/flow/layout';
import type { Rect } from '@/lib/flow/layout';
import { FlowRenderer } from '@/lib/flow/renderer';
import { assembleTrace } from '@/lib/flow/trace';
import type { TraceResult } from '@/lib/flow/trace';
import { TracePanel } from '../flow/TracePanel';

const TICKER_H = 112;
const QUIET_MS = 30_000;

const rectStyle = (r: Rect): React.CSSProperties => ({
  left: r.x, top: r.y, width: r.w, height: r.h,
});

const fmtRate = (rate: number): string => (rate < 0.05 ? '—' : `${rate.toFixed(1)}/s`);

function fmtTickerTime(ns: string): string {
  try {
    const d = new Date(Number(BigInt(ns) / 1_000_000n));
    const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  } catch {
    return '—';
  }
}

const CONSUMER_META: Record<ConsumerSnap['key'], { label: string; sub: string; stat: (c: ConsumerSnap) => string }> = {
  shell: { label: 'planetar-ui', sub: 'this shell · live feed', stat: (c) => `${c.total} received` },
  ontology: { label: 'planetar-ontology', sub: 'entity graph · :4000', stat: (c) => `${c.total} entity events` },
  wal: { label: 'WAL', sub: 'append-only · CRC32', stat: (c) => `${c.total} appended` },
};

function NodeInfoPanel({
  selection, snapshot, onClose,
}: {
  selection: Exclude<FlowSelection, null>;
  snapshot: FlowSnapshot;
  onClose: () => void;
}) {
  let title = '';
  let body: React.ReactNode = null;
  if (selection.kind === 'lane') {
    const lane = snapshot.lanes.find((l) => l.key === selection.key);
    title = `lane · ${selection.key}`;
    body = lane && (
      <>
        <div className="trace-kv">
          <span>rate</span><span>{fmtRate(lane.rate)}</span>
          <span>total</span><span>{lane.total}</span>
        </div>
        <div className="trace-section">topics</div>
        {lane.topics.slice(0, 8).map((t) => (
          <div className="flow-info-topic" key={t.topic}>
            <span>{t.topic}</span><span>{t.total}</span>
          </div>
        ))}
        {lane.topics.length > 8 && (
          <div className="trace-note">+{lane.topics.length - 8} more topics</div>
        )}
      </>
    );
  } else if (selection.kind === 'producer') {
    const p = snapshot.producers.find((x) => x.key === selection.key);
    title = `source · ${selection.key}`;
    body = p && (
      <div className="trace-kv">
        <span>rate</span><span>{fmtRate(p.rate)}</span>
        <span>total</span><span>{p.total}</span>
        <span>last seen</span><span>{Math.round((snapshot.atMs - p.lastMs) / 1000)}s ago</span>
      </div>
    );
  } else if (selection.kind === 'consumer') {
    const c = snapshot.consumers.find((x) => x.key === selection.key);
    title = `sink · ${CONSUMER_META[selection.key].label}`;
    body = c && (
      <div className="trace-kv">
        <span>role</span><span>{CONSUMER_META[selection.key].sub}</span>
        <span>status</span><span>{c.status}</span>
        <span>total</span><span>{CONSUMER_META[selection.key].stat(c)}</span>
      </div>
    );
  }
  return (
    <aside className="trace-panel">
      <div className="trace-head">
        <span className="trace-title">{title}</span>
        <button className="trace-close" onClick={onClose}>✕</button>
      </div>
      <div className="trace-body">{body}</div>
    </aside>
  );
}

function Ticker({
  entries, laneFilter, selectedId, onSelect,
}: {
  entries: TickerEntry[];
  laneFilter: string | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const shown = laneFilter ? entries.filter((e) => e.lane === laneFilter) : entries;
  return (
    <div className="flow-ticker">
      <div className="flow-ticker-head">
        live messages{laneFilter ? ` · ${laneFilter}` : ''}
      </div>
      <div className="flow-ticker-body">
        {shown.length === 0 && <div className="flow-ticker-empty">no traffic yet</div>}
        {shown.slice(0, 30).map((e) => (
          <button
            key={e.id}
            className={`flow-ticker-row ${e.id === selectedId ? 'active' : ''}`}
            onClick={() => onSelect(e.id)}
            title={e.id}
          >
            <span className="flow-ticker-time">{fmtTickerTime(e.createdNs)}</span>
            <span className="flow-dot" style={{ background: MODALITY_COLORS[e.modality] }} />
            <span className="flow-ticker-topic">{e.topic}</span>
            <span className="flow-ticker-source">{e.source}</span>
            {e.hasCausation && <span className="flow-ticker-cause" title="has causation chain">⤷</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

export function FlowTab() {
  useFlow();
  const brokerStatus = useBrokerStatus();
  const snapshot = useFlowStore((s) => s.snapshot);
  const selection = useFlowStore((s) => s.selection);
  const select = useFlowStore((s) => s.select);

  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<FlowRenderer | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [live, setLive] = useState(0);
  // pending is derived: a message is selected but its trace hasn't landed yet
  const [traceState, setTraceState] = useState<{ forId: string; result: TraceResult } | null>(null);

  // renderer lifecycle — one per mount, fed spawns straight from the engine
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = new FlowRenderer(canvas);
    rendererRef.current = renderer;
    renderer.start();
    const unsub = flowEngine.onSpawn((s) => renderer.spawn(s));
    const counter = window.setInterval(() => setLive(renderer.liveParticles()), 500);
    return () => {
      unsub();
      window.clearInterval(counter);
      renderer.stop();
      rendererRef.current = null;
    };
  }, []);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      setSize({ w: Math.floor(r.width), h: Math.floor(r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const topoKey = snapshot
    ? `${snapshot.producers.map((p) => p.key).join('|')}«${snapshot.lanes.map((l) => l.key).join('|')}`
    : '';
  const layout = useMemo(() => {
    if (!size.w || !size.h || !snapshot) return null;
    return computeLayout(
      size.w,
      size.h - TICKER_H,
      snapshot.producers.map((p) => p.key),
      snapshot.lanes.map((l) => l.key),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.w, size.h, topoKey]);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || !size.w) return;
    renderer.resize(size.w, size.h, window.devicePixelRatio || 1);
    if (layout) renderer.setLayout(layout);
  }, [layout, size]);

  useEffect(() => {
    if (!snapshot) return;
    const shell = snapshot.consumers.find((c) => c.key === 'shell');
    rendererRef.current?.setEdges(snapshot.edges, shell?.rate ?? 0);
  }, [snapshot]);

  // selection → trace assembly + canvas highlight
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!selection || selection.kind !== 'message') {
      renderer?.setHighlight(null);
      return;
    }
    let stale = false;
    void assembleTrace(selection.id).then((result) => {
      if (stale) return;
      setTraceState({ forId: selection.id, result });
      const rows = [result.row, ...result.ancestors, ...result.descendants.map((d) => d.row)];
      const ids = new Set<string>([result.id]);
      const producers = new Set<string>();
      const lanes = new Set<string>();
      for (const r of rows) {
        if (!r) continue;
        ids.add(r.id);
        producers.add(r.source);
        lanes.add(r.lane);
      }
      renderer?.setHighlight({ ids, producers, lanes });
    });
    return () => {
      stale = true;
    };
  }, [selection]);

  useEffect(() => {
    if (!selection) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') select(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selection, select]);

  const onStageClick = (e: React.MouseEvent): void => {
    const stage = stageRef.current;
    const renderer = rendererRef.current;
    if (!stage || !renderer) return;
    const rect = stage.getBoundingClientRect();
    const hit = renderer.hitTest(e.clientX - rect.left, e.clientY - rect.top);
    select(hit ? { kind: 'message', id: hit } : null);
  };

  const now = snapshot?.atMs ?? 0;
  const selectedMsgId = selection?.kind === 'message' ? selection.id : null;
  const laneFilter = selection?.kind === 'lane' ? selection.key : null;
  const totalRate = snapshot ? snapshot.lanes.reduce((a, l) => a + l.rate, 0) : 0;
  const trace = selectedMsgId && traceState?.forId === selectedMsgId ? traceState.result : null;
  const tracePending = selectedMsgId != null && trace == null;

  return (
    <div
      className="flow-tab"
      data-node-count={(snapshot?.producers.length ?? 0) + 3}
      data-lane-count={snapshot?.lanes.length ?? 0}
      data-msg-total={snapshot?.total ?? 0}
      data-live-particles={live}
      data-selected-trace={selectedMsgId ?? ''}
    >
      <div className="flow-stage" ref={stageRef} onClick={onStageClick}>
        {layout && snapshot && (
          <>
            {snapshot.producers.map((p: NodeSnap) => {
              const r = layout.producers.get(p.key);
              if (!r) return null;
              const quiet = now - p.lastMs > QUIET_MS;
              const active = selection?.kind === 'producer' && selection.key === p.key;
              return (
                <button
                  key={p.key}
                  className={`flow-node flow-producer ${quiet ? 'quiet' : ''} ${active ? 'selected' : ''}`}
                  style={rectStyle(r)}
                  onClick={(e) => {
                    e.stopPropagation();
                    select({ kind: 'producer', key: p.key });
                  }}
                >
                  <span className="flow-node-name">
                    <span className="flow-dot" style={{ background: MODALITY_COLORS[p.modality] }} />
                    {p.key}
                  </span>
                  <span className="flow-node-stat">{fmtRate(p.rate)} · {p.total}</span>
                </button>
              );
            })}
            {layout.producerOverflow && (
              <div className="flow-node flow-more" style={rectStyle(layout.producerOverflow.rect)}>
                · {layout.producerOverflow.keys.length} more sources
              </div>
            )}

            <div className="flow-bus" style={rectStyle(layout.bus)}>
              <div className="flow-bus-head">
                <span>planetar-broker</span>
                <span className="flow-bus-rate">{fmtRate(totalRate)}</span>
              </div>
            </div>
            {snapshot.lanes.map((l: LaneSnap) => {
              const r = layout.lanes.get(l.key);
              if (!r) return null;
              const quiet = now - l.lastMs > QUIET_MS;
              const active = selection?.kind === 'lane' && selection.key === l.key;
              return (
                <button
                  key={l.key}
                  className={`flow-lane ${quiet ? 'quiet' : ''} ${active ? 'selected' : ''}`}
                  style={{ ...rectStyle(r), borderLeftColor: MODALITY_COLORS[l.modality] }}
                  onClick={(e) => {
                    e.stopPropagation();
                    select({ kind: 'lane', key: l.key });
                  }}
                >
                  <span className="flow-lane-name">{l.key}</span>
                  <span className="flow-lane-stat">
                    {l.topics.length} topic{l.topics.length === 1 ? '' : 's'} · {fmtRate(l.rate)} · {l.total}
                  </span>
                </button>
              );
            })}
            {layout.laneOverflow && (
              <div className="flow-lane flow-more" style={rectStyle(layout.laneOverflow.rect)}>
                · {layout.laneOverflow.keys.length} more lanes
              </div>
            )}

            {snapshot.consumers.map((c: ConsumerSnap) => {
              const r = layout.consumers.get(c.key);
              if (!r) return null;
              const meta = CONSUMER_META[c.key];
              const active = selection?.kind === 'consumer' && selection.key === c.key;
              return (
                <button
                  key={c.key}
                  className={`flow-node flow-consumer ${c.status === 'off' ? 'off' : ''} ${active ? 'selected' : ''}`}
                  style={rectStyle(r)}
                  onClick={(e) => {
                    e.stopPropagation();
                    select({ kind: 'consumer', key: c.key });
                  }}
                >
                  <span className="flow-node-name">
                    <span className={`status-dot ${c.status === 'off' ? 'offline' : ''}`} />
                    {meta.label}
                  </span>
                  <span className="flow-node-sub">{meta.sub}</span>
                  <span className="flow-node-stat">{meta.stat(c)}</span>
                </button>
              );
            })}
          </>
        )}

        <canvas ref={canvasRef} className="flow-canvas" />

        {(!snapshot || snapshot.total === 0) && (
          <div className="flow-empty">
            <div className="tab-stub-title">⇶ Data flow</div>
            <div className="tab-stub-meta">
              Listening on <span className="k">**</span> — the graph draws itself from live traffic.
            </div>
          </div>
        )}

        <div className="flow-hud">
          <span className={`entity-conn ${brokerStatus === 'open' ? 'open' : 'closed'}`}>
            bridge · {brokerStatus}
          </span>
          {snapshot && snapshot.coalesced > 0 && (
            <span className="flow-hud-note">coalesced ×{snapshot.coalesced}</span>
          )}
        </div>
      </div>

      <Ticker
        entries={snapshot?.recent ?? []}
        laneFilter={laneFilter}
        selectedId={selectedMsgId}
        onSelect={(id) => select({ kind: 'message', id })}
      />

      {selection?.kind === 'message' && (
        <TracePanel
          pending={tracePending}
          result={trace}
          onSelect={(id) => select({ kind: 'message', id })}
          onClose={() => select(null)}
        />
      )}
      {selection && selection.kind !== 'message' && snapshot && (
        <NodeInfoPanel selection={selection} snapshot={snapshot} onClose={() => select(null)} />
      )}
    </div>
  );
}
