import { useMemo } from 'react';
import { parseMmsi, useAisStore } from '@/store/aisStore';
import { useChannelsStore } from '@/store/channelsStore';
import { useLayoutStore } from '@/store/layoutStore';
import { isTracked } from '@/types/ais';

function formatNsAge(ns: string | number | undefined): string {
  if (ns == null) return '—';
  try {
    const ms = typeof ns === 'number' ? ns : Number(BigInt(ns) / 1_000_000n);
    const delta = Math.max(0, Date.now() - ms);
    if (delta < 60_000) return `${Math.round(delta / 1000)}s ago`;
    if (delta < 3_600_000) return `${Math.round(delta / 60_000)} min ago`;
    return `${Math.round(delta / 3_600_000)} h ago`;
  } catch {
    return '—';
  }
}

function formatLatLon(lat?: number, lon?: number): string {
  if (typeof lat !== 'number' || typeof lon !== 'number') return '—';
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(3)}°${ns} ${Math.abs(lon).toFixed(3)}°${ew}`;
}

export function Inspector() {
  const selectedEntityId = useLayoutStore((s) => s.selectedEntityId);
  const setCurrentChannel = useLayoutStore((s) => s.setCurrentChannel);
  const currentChannelId = useLayoutStore((s) => s.currentChannelId);

  const mmsi = useMemo(() => parseMmsi(selectedEntityId), [selectedEntityId]);
  const record = useAisStore((s) => (mmsi != null ? s.byMmsi[mmsi] : undefined));

  // Resolve the vessel's channel by MMSI rather than by name convention so
  // the lookup stays correct if the channelId scheme ever changes.
  const vesselChannelId = useChannelsStore((s) => {
    if (mmsi == null) return null;
    for (const c of Object.values(s.channels)) {
      if (c.vessel?.mmsi === mmsi) return c.id;
    }
    return null;
  });

  if (!selectedEntityId) {
    return (
      <div className="inspector">
        <div className="inspector-title">Inspector</div>
        <div className="inspector-empty">No entity selected. Click a token in chat or a marker on the map.</div>
      </div>
    );
  }

  const tracked = mmsi != null && isTracked(mmsi);
  const v = record?.latest;

  return (
    <div className="inspector">
      <div className="inspector-title">
        Inspector
        <span className="type">· vessel{tracked ? ' · tracked' : ''}</span>
      </div>
      <div className="inspector-row">
        <span className="k">MMSI</span>
        <span className="v">{mmsi ?? selectedEntityId}</span>
      </div>
      <div className="inspector-row">
        <span className="k">Name</span>
        <span className="v">{v?.name ?? '—'}</span>
      </div>
      <div className="inspector-row">
        <span className="k">Class</span>
        <span className="v">{v?.type ?? '—'}</span>
      </div>
      <div className="inspector-row">
        <span className="k">Flag</span>
        <span className="v">{v?.flag ?? '—'}</span>
      </div>
      <div className="inspector-row">
        <span className="k">Position</span>
        <span className="v">{formatLatLon(v?.lat, v?.lon)}</span>
      </div>
      <div className="inspector-row">
        <span className="k">Speed · Course</span>
        <span className="v">
          {typeof v?.sog === 'number' ? `${v.sog.toFixed(1)} kn` : '—'}
          {' · '}
          {typeof v?.cog === 'number' ? `${Math.round(v.cog)}°` : '—'}
        </span>
      </div>
      <div className="inspector-row">
        <span className="k">Last AIS</span>
        <span className="v">{formatNsAge(v?.lastSeenNs)}</span>
      </div>
      {!record ? (
        <div className="inspector-empty" style={{ marginTop: 4 }}>
          waiting for <code>vessel.ais.position</code> on this MMSI
        </div>
      ) : null}
      {vesselChannelId ? (
        <div className="inspector-actions">
          <button
            type="button"
            className="inspector-action"
            onClick={() => setCurrentChannel(vesselChannelId)}
            disabled={vesselChannelId === currentChannelId}
            title={
              vesselChannelId === currentChannelId
                ? 'already viewing this channel'
                : `Open #${vesselChannelId.replace(/^.*-v-/, 'vessel-')}`
            }
          >
            {vesselChannelId === currentChannelId
              ? 'viewing this channel'
              : 'Open channel ▸'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
