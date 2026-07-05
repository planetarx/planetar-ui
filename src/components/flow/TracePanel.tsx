// Trace panel — the distributed-tracing read of one selected envelope
// (ARCH-planetar-flow-trace.md §5.4): per-hop nanosecond timings straight off
// the zmesg timestamps, the causal chain up and tree down, correlated
// siblings, and the entity fields the message ultimately set.

import { useLayoutStore } from '@/store/layoutStore';
import { MODALITY_COLORS } from '@/lib/flow/engine';
import type { TraceResult, TraceRow } from '@/lib/flow/trace';

const shortId = (id: string): string => id.slice(0, 8);

function fmtClock(ns: string): string {
  try {
    const ms = Number(BigInt(ns) / 1_000_000n);
    const d = new Date(ms);
    const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  } catch {
    return '—';
  }
}

/** Format a nanosecond delta at the precision the bus actually delivers. */
function fmtDeltaNs(delta: bigint): string {
  const abs = delta < 0n ? -delta : delta;
  const sign = delta < 0n ? '−' : '';
  if (abs < 1_000n) return `${sign}${abs} ns`;
  if (abs < 1_000_000n) return `${sign}${(Number(abs) / 1_000).toFixed(1)} µs`;
  if (abs < 1_000_000_000n) return `${sign}${(Number(abs) / 1_000_000).toFixed(1)} ms`;
  return `${sign}${(Number(abs) / 1_000_000_000).toFixed(2)} s`;
}

/** A clock of '0' means "never stamped" (publisher left it for the broker,
 *  broker didn't rewrite) — skip the hop rather than render 1970. */
const stamped = (ns: string | null): ns is string => ns != null && ns !== '0';

function hops(row: TraceRow): { label: string; at: string; delta: string | null; approx?: boolean }[] {
  const out: { label: string; at: string; delta: string | null; approx?: boolean }[] = [];
  out.push({ label: 'created at source', at: fmtClock(row.createdNs), delta: null });
  if (stamped(row.storedNs)) {
    out.push({
      label: 'stored (broker WAL)',
      at: fmtClock(row.storedNs),
      delta: fmtDeltaNs(BigInt(row.storedNs) - BigInt(row.createdNs)),
    });
  }
  if (stamped(row.publishedNs)) {
    const prev = stamped(row.storedNs) ? row.storedNs : row.createdNs;
    out.push({
      label: 'published (fan-out)',
      at: fmtClock(row.publishedNs),
      delta: fmtDeltaNs(BigInt(row.publishedNs) - BigInt(prev)),
    });
  }
  if (row.receivedMs != null && stamped(row.publishedNs)) {
    const receivedNs = BigInt(row.receivedMs) * 1_000_000n;
    out.push({
      label: 'received (this shell)',
      at: fmtClock(receivedNs.toString()),
      delta: fmtDeltaNs(receivedNs - BigInt(row.publishedNs)),
      approx: true, // browser clock vs broker clock — indicative only
    });
  }
  return out;
}

function RowLine({
  row, depth = 0, marker, onSelect,
}: {
  row: TraceRow;
  depth?: number;
  marker?: string;
  onSelect: (id: string) => void;
}) {
  return (
    <button
      className="trace-row"
      style={{ paddingLeft: 8 + depth * 14 }}
      onClick={() => onSelect(row.id)}
      title={row.id}
    >
      {marker && <span className="trace-row-marker">{marker}</span>}
      <span className="flow-dot" style={{ background: MODALITY_COLORS[row.modality] }} />
      <span className="trace-row-topic">{row.topic}</span>
      <span className="trace-row-meta">
        {row.source} · {shortId(row.id)}
        {!row.inBuffer && ' · indexed'}
      </span>
    </button>
  );
}

export function TracePanel({
  pending, result, onSelect, onClose,
}: {
  pending: boolean;
  result: TraceResult | null;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const currentChannelId = useLayoutStore((s) => s.currentChannelId);
  const setActiveTab = useLayoutStore((s) => s.setActiveTab);

  return (
    <aside className="trace-panel">
      <div className="trace-head">
        <span className="trace-title">⇶ Message trace</span>
        <button className="trace-close" onClick={onClose} title="Close (Esc)">✕</button>
      </div>

      {pending && <div className="trace-note">assembling trace…</div>}

      {!pending && result && (
        <div className="trace-body">
          {result.row ? (
            <>
              <div className="trace-subject">
                <span className="flow-dot" style={{ background: MODALITY_COLORS[result.row.modality] }} />
                <span className="trace-subject-topic">{result.row.topic}</span>
                <span className="trace-subject-id">{shortId(result.id)}</span>
              </div>
              <div className="trace-kv">
                <span>source</span><span>{result.row.source}</span>
                {result.row.schemaName && (<><span>schema</span><span>{result.row.schemaName}</span></>)}
                {result.row.correlationId && (<><span>correlation</span><span>{result.row.correlationId}</span></>)}
              </div>

              <div className="trace-section">hop timeline</div>
              <div className="trace-hops">
                {hops(result.row).map((h) => (
                  <div className="trace-hop" key={h.label}>
                    <span className="trace-hop-tick" />
                    <span className="trace-hop-label">{h.label}</span>
                    <span className="trace-hop-at">{h.at}</span>
                    <span className="trace-hop-delta">
                      {h.delta ? `${h.approx ? '≈' : '+'}${h.delta}` : ''}
                    </span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="trace-note">
              Not in the live buffer or the ontology index — beyond retention.
            </div>
          )}

          <div className="trace-section">lineage</div>
          {result.missingAncestorId && (
            <div className="trace-note">
              ⋯ chain continues beyond retention ({shortId(result.missingAncestorId)})
            </div>
          )}
          {[...result.ancestors].reverse().map((a) => (
            <RowLine key={a.id} row={a} marker="↑" onSelect={onSelect} />
          ))}
          {result.row && (
            <div className="trace-row trace-row-self">
              <span className="trace-row-marker">●</span>
              <span className="flow-dot" style={{ background: MODALITY_COLORS[result.row.modality] }} />
              <span className="trace-row-topic">{result.row.topic}</span>
              <span className="trace-row-meta">this message</span>
            </div>
          )}
          {result.descendants.map((d) => (
            <RowLine key={d.row.id} row={d.row} depth={d.depth} marker="↳" onSelect={onSelect} />
          ))}
          {result.ancestors.length === 0 && result.descendants.length === 0 && !result.missingAncestorId && (
            <div className="trace-note">
              No causal links — this message is a root (or its publisher doesn't set causationId yet).
            </div>
          )}

          {result.correlated.length > 0 && (
            <>
              <div className="trace-section">
                correlated — same {result.row?.correlationId ? `"${result.row.correlationId}"` : 'correlation id'}
              </div>
              {result.correlated.slice(0, 10).map((c) => (
                <RowLine key={c.id} row={c} onSelect={onSelect} />
              ))}
            </>
          )}

          {result.entity && (
            <>
              <div className="trace-section">entity graph</div>
              <div className="trace-entity">
                <div>
                  wrote <b>{result.entity.fields.join(', ') || '(no fields)'}</b> on{' '}
                  {result.entity.type}
                  {result.entity.name ? ` · ${result.entity.name}` : ''}
                </div>
                <button
                  className="entity-action"
                  onClick={() => setActiveTab(currentChannelId, 'graph')}
                >
                  Open in Entities →
                </button>
              </div>
            </>
          )}

          <div className="trace-footer">
            buffer: {result.row?.inBuffer ? 'live' : 'not held'} · ontology trace: {result.remote}
          </div>
        </div>
      )}
    </aside>
  );
}
