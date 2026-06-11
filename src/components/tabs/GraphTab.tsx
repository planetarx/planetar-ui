// Graph tab — resolved canonical entities from planetar-ontology's Object API.
// Each card is one core:CanonicalEntity (a vessel): its live status, the
// provenance the ontology resolved it from, and a Kinetic-layer action.
// Live-updated via the /subscribe WebSocket feed (see useOntology).

import { useMemo, useState } from 'react';
import { useOntology } from '@/hooks/useOntology';
import { useEntitiesStore } from '@/store/entitiesStore';
import { ontology } from '@/lib/ontology';
import type { OntologyEntity } from '@/lib/ontology';

function ageFromNs(ns: string): string {
  try {
    const ms = Number(BigInt(ns) / 1_000_000n);
    const d = Math.max(0, Date.now() - ms);
    if (d < 60_000) return `${Math.round(d / 1000)}s ago`;
    if (d < 3_600_000) return `${Math.round(d / 60_000)} min ago`;
    return `${Math.round(d / 3_600_000)} h ago`;
  } catch {
    return '—';
  }
}

function statusKind(status: unknown): 'alert' | 'info' | 'ok' {
  const s = String(status ?? '');
  if (s.startsWith('dark')) return 'alert';
  if (s === 'reacquired') return 'info';
  return 'ok';
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

function EntityCard({ e }: { e: OntologyEntity }) {
  const b = e.body;
  const lat = num(b.lat);
  const lon = num(b.lon);
  const sog = num(b.sog);
  const sources = new Set(Object.values(e.provenance).map((p) => p.src));

  const [busy, setBusy] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const confirmed = b.status === 'dark-confirmed';

  async function confirmDark() {
    setBusy(true);
    setActionMsg(null);
    try {
      // The Kinetic layer: a validated, audited write. On success the
      // ontology pushes the mutated entity back over the WS feed, so the
      // card re-renders itself — no manual refetch.
      const { status, body } = await ontology.executeAction('planetar:ConfirmDarkVessel', {
        candidate_id: e.id,
        analyst_id: 'analyst-ui',
        rationale: 'Flagged dark from planetar-ui',
      });
      setActionMsg(status === 200 ? '✓ confirmed' : (body.error ?? `HTTP ${status}`));
    } catch (err) {
      setActionMsg(err instanceof Error ? err.message : 'action failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="entity-card">
      <div className="entity-card-head">
        <span className="entity-name">{e.name ?? e.id.slice(0, 8)}</span>
        {b.status != null && (
          <span className={`entity-badge ${statusKind(b.status)}`}>{String(b.status)}</span>
        )}
      </div>
      <div className="entity-type">{e.type}</div>
      <dl className="entity-fields">
        {num(b.mmsi) != null && (
          <>
            <dt>MMSI</dt>
            <dd>{String(b.mmsi)}</dd>
          </>
        )}
        {lat != null && lon != null && (
          <>
            <dt>Position</dt>
            <dd>
              {lat.toFixed(3)}, {lon.toFixed(3)}
            </dd>
          </>
        )}
        {sog != null && (
          <>
            <dt>SOG / COG</dt>
            <dd>
              {sog} kn / {num(b.cog) ?? '—'}°
            </dd>
          </>
        )}
        <dt>Updated</dt>
        <dd>{ageFromNs(e.updatedNs)}</dd>
        <dt>Provenance</dt>
        <dd>
          {Object.keys(e.provenance).length} fields · {sources.size} source
          {sources.size === 1 ? '' : 's'}
        </dd>
      </dl>
      {!confirmed && (
        <div className="entity-actions">
          <button className="entity-action" disabled={busy} onClick={confirmDark}>
            {busy ? '…' : 'Confirm dark'}
          </button>
          {actionMsg && <span className="entity-msg">{actionMsg}</span>}
        </div>
      )}
    </div>
  );
}

export function GraphTab() {
  const status = useOntology();
  const byId = useEntitiesStore((s) => s.byId);

  const entities = useMemo(
    () => Object.values(byId).sort((a, b) => (a.updatedNs < b.updatedNs ? 1 : -1)),
    [byId],
  );

  return (
    <div className="entity-graph">
      <div className="entity-graph-head">
        <span className="entity-graph-title">⌘ Entity graph</span>
        <span className={`entity-conn ${status}`}>planetar-ontology · {status}</span>
      </div>
      {entities.length === 0 ? (
        <div className="tab-stub-meta">
          {status === 'open'
            ? 'Connected — no resolved entities yet. Publish observations to the bus.'
            : 'Waiting for the planetar-ontology Object API on :4000…'}
        </div>
      ) : (
        <div className="entity-list">
          {entities.map((e) => (
            <EntityCard key={e.id} e={e} />
          ))}
        </div>
      )}
    </div>
  );
}
