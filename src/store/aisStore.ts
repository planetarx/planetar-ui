// AIS state — per-MMSI latest snapshot + a short tail of recent positions for
// the map's track polyline. Fed by useAisPositions (subscribes to
// vessel.ais.position) and useFleet (already-running fleetListener for the
// channel list also forwards lifecycle events here).

import { create } from 'zustand';
import type { AisPosition, VesselStatus } from '@/types/ais';

const MAX_TRACK_POINTS = 256;

/** No report for this long → painted grey ('lost'). */
export const STALE_AFTER_MS = 60 * 60 * 1000;
/** No report for this long → dropped from the map. */
export const EXPIRE_AFTER_MS = 24 * 60 * 60 * 1000;

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
  /** Last-known positions from the ontology, loaded before live AIS arrives. */
  seed: (positions: AisPosition[], nowMs?: number) => void;
  /** Grey out records older than STALE_AFTER_MS, drop those older than EXPIRE_AFTER_MS. */
  age: (nowMs?: number) => void;
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

  seed: (positions, nowMs = Date.now()) =>
    set((s) => {
      const next = { ...s.byMmsi };
      let changed = false;
      for (const p of positions) {
        const lastSeenMs = nsToMs(p.lastSeenNs);
        const age = nowMs - lastSeenMs;
        if (age > EXPIRE_AFTER_MS) continue;
        // Live AIS may already have beaten the fetch; never overwrite it.
        const prev = next[p.mmsi];
        if (prev && prev.lastSeenMs >= lastSeenMs) continue;
        next[p.mmsi] = {
          mmsi: p.mmsi,
          latest: p,
          track: [{ lat: p.lat, lon: p.lon, ts: lastSeenMs }],
          firstSeenMs: nsToMs(p.firstSeenNs ?? p.lastSeenNs),
          lastSeenMs,
          status: age > STALE_AFTER_MS ? 'lost' : 'live',
          serverId: p.serverId,
        };
        changed = true;
      }
      return changed ? { byMmsi: next } : s;
    }),

  age: (nowMs = Date.now()) =>
    set((s) => {
      let next: Record<number, VesselRecord> | null = null;
      for (const r of Object.values(s.byMmsi)) {
        const age = nowMs - r.lastSeenMs;
        if (age > EXPIRE_AFTER_MS) {
          next ??= { ...s.byMmsi };
          delete next[r.mmsi];
        } else if (age > STALE_AFTER_MS && r.status !== 'lost') {
          next ??= { ...s.byMmsi };
          next[r.mmsi] = { ...r, status: 'lost' };
        }
      }
      return next ? { byMmsi: next } : s;
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
