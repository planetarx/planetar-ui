// Detection state for the map's non-AIS layers: SAR chips, cross-pass tracks,
// and hydrophone sites. Fed by useDetectionStreams.

import { create } from 'zustand';
import type { AcousticDetect, OrcaHelloDetection, SarChip, TrackUpdate } from '@/types/detections';

const MAX_SAR_CHIPS = 500;
const MAX_TRACK_POINTS = 256;

export interface TrackRecord {
  track_id: string;
  points: { lat: number; lon: number }[]; // newest-last
  latest: TrackUpdate;
}

export interface AcousticSiteRecord {
  site_code: string;
  site_name: string;
  lat: number;
  lon: number;
  /** 'clips' = planetar-acoustic's own detector; 'orcahello' = OrcaHello detections */
  source: 'clips' | 'orcahello';
  /** latest clip result for this site (clips only) */
  latest?: AcousticDetect;
  /** clips where `detected` was true, last hour-ish (best-effort count) */
  detections: number;
  /** total clips seen */
  clips: number;
  /** OrcaHello: detection id → moderator-confirmed whales (last 24 h) */
  orcaHello?: Record<string, boolean>;
  /** latest detection timestamp (ms), OrcaHello only */
  lastAtMs?: number;
}

// Mirrors planetar-ui-orca's classify(): only the moderator's verdict counts.
const WHALE_TAGS = new Set(['srkw', 'resident', 'transient', 'biggs', 'humpback', 'orca', 'whale']);
const confirmedWhales = (d: OrcaHelloDetection) =>
  d.reviewed &&
  (String(d.found).toLowerCase() === 'yes' || d.tagList.some((t) => WHALE_TAGS.has(t.toLowerCase())));

interface State {
  sarChips: SarChip[];
  tracks: Record<string, TrackRecord>;
  acousticSites: Record<string, AcousticSiteRecord>;
  ingestSarChip: (c: SarChip) => void;
  ingestTrackUpdate: (t: TrackUpdate) => void;
  ingestAcousticDetect: (d: AcousticDetect) => void;
  ingestOrcaHello: (d: OrcaHelloDetection) => void;
}

export const useDetectionsStore = create<State>()((set) => ({
  sarChips: [],
  tracks: {},
  acousticSites: {},

  ingestSarChip: (c) =>
    set((s) => {
      const next = [...s.sarChips, c];
      if (next.length > MAX_SAR_CHIPS) next.splice(0, next.length - MAX_SAR_CHIPS);
      return { sarChips: next };
    }),

  ingestTrackUpdate: (t) =>
    set((s) => {
      const prev = s.tracks[t.track_id];
      const points = prev ? [...prev.points, { lat: t.lat, lon: t.lon }] : [{ lat: t.lat, lon: t.lon }];
      if (points.length > MAX_TRACK_POINTS) points.splice(0, points.length - MAX_TRACK_POINTS);
      return {
        tracks: { ...s.tracks, [t.track_id]: { track_id: t.track_id, points, latest: t } },
      };
    }),

  ingestAcousticDetect: (d) =>
    set((s) => {
      const prev = s.acousticSites[d.site_code];
      const rec: AcousticSiteRecord = {
        site_code: d.site_code,
        site_name: d.site_name,
        lat: d.lat,
        lon: d.lon,
        source: 'clips',
        latest: d,
        detections: (prev?.detections ?? 0) + (d.detected ? 1 : 0),
        clips: (prev?.clips ?? 0) + 1,
      };
      return { acousticSites: { ...s.acousticSites, [d.site_code]: rec } };
    }),

  ingestOrcaHello: (d) =>
    set((s) => {
      const { id: code, name, latitude: lat, longitude: lon } = d.location;
      if (!code || typeof lat !== 'number' || typeof lon !== 'number') return s;
      const prev = s.acousticSites[code];
      const orcaHello = { ...(prev?.orcaHello ?? {}), [d.id]: confirmedWhales(d) };
      const at = d.timestamp ? Date.parse(d.timestamp) : NaN;
      const rec: AcousticSiteRecord = {
        site_code: code,
        site_name: name ?? code,
        lat,
        lon,
        source: 'orcahello',
        detections: Object.values(orcaHello).filter(Boolean).length,
        clips: Object.keys(orcaHello).length,
        orcaHello,
        lastAtMs: Math.max(prev?.lastAtMs ?? 0, Number.isNaN(at) ? 0 : at),
      };
      return { acousticSites: { ...s.acousticSites, [code]: rec } };
    }),
}));
