// AIS state — per-MMSI latest snapshot + a short tail of recent positions for
// the map's track polyline. Fed by useAisPositions (subscribes to
// vessel.ais.position) and useFleet (already-running fleetListener for the
// channel list also forwards lifecycle events here).

import { create } from 'zustand';
import type { AisPosition, VesselStatus } from '@/types/ais';

const MAX_TRACK_POINTS = 256;

export interface TrackPoint {
  lat: number;
  lon: number;
  ts: number; // ms (NOT ns) — sufficient for polyline rendering, easy to compare
}

export interface VesselRecord {
  mmsi: number;
  latest: AisPosition;
  track: TrackPoint[]; // newest-last, capped at MAX_TRACK_POINTS
  firstSeenMs: number;
  lastSeenMs: number;
  status: VesselStatus;
  serverId?: string;   // Operation this vessel belongs to; scopes the map
}

interface State {
  byMmsi: Record<number, VesselRecord>;
  ingestPosition: (p: AisPosition) => void;
  markStatus: (mmsi: number, status: VesselStatus) => void;
  remove: (mmsi: number) => void;
  clearTrack: (mmsi: number) => void;
}

function nsToMs(ns?: string | number): number {
  if (typeof ns === 'number') return ns;
  if (typeof ns !== 'string' || !ns) return Date.now();
  try {
    return Number(BigInt(ns) / 1_000_000n);
  } catch {
    return Date.now();
  }
}

export const useAisStore = create<State>()((set) => ({
  byMmsi: {},

  ingestPosition: (p) =>
    set((s) => {
      const prev = s.byMmsi[p.mmsi];
      const lastSeenMs = nsToMs(p.lastSeenNs);
      const point: TrackPoint = { lat: p.lat, lon: p.lon, ts: lastSeenMs };
      const track = prev ? [...prev.track, point] : [point];
      if (track.length > MAX_TRACK_POINTS) track.splice(0, track.length - MAX_TRACK_POINTS);
      const merged: AisPosition = prev ? { ...prev.latest, ...p } : p;
      const record: VesselRecord = {
        mmsi: p.mmsi,
        latest: merged,
        track,
        firstSeenMs: prev?.firstSeenMs ?? nsToMs(p.firstSeenNs ?? p.lastSeenNs),
        lastSeenMs,
        status: prev?.status ?? 'live',
        serverId: p.serverId ?? prev?.serverId,
      };
      return { byMmsi: { ...s.byMmsi, [p.mmsi]: record } };
    }),

  markStatus: (mmsi, status) =>
    set((s) => {
      const r = s.byMmsi[mmsi];
      if (!r || r.status === status) return s;
      return { byMmsi: { ...s.byMmsi, [mmsi]: { ...r, status } } };
    }),

  remove: (mmsi) =>
    set((s) => {
      if (!(mmsi in s.byMmsi)) return s;
      const next = { ...s.byMmsi };
      delete next[mmsi];
      return { byMmsi: next };
    }),

  clearTrack: (mmsi) =>
    set((s) => {
      const r = s.byMmsi[mmsi];
      if (!r) return s;
      return { byMmsi: { ...s.byMmsi, [mmsi]: { ...r, track: [] } } };
    }),
}));

/** Read-only helper for non-React consumers (e.g., the MapLibre symbol layer). */
export function getAllVessels(): VesselRecord[] {
  return Object.values(useAisStore.getState().byMmsi);
}

/** Resolve "MMSI 311001249" / "311001249" / 311001249 to a numeric MMSI, or null. */
export function parseMmsi(entityId: string | number | null | undefined): number | null {
  if (entityId == null) return null;
  if (typeof entityId === 'number') return Number.isFinite(entityId) ? entityId : null;
  const m = /(\d{6,10})/.exec(String(entityId));
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}
