// Detection state for the map's non-AIS layers: SAR chips, cross-pass tracks,
// and hydrophone sites. Fed by useDetectionStreams.

import { create } from 'zustand';
import type { AcousticDetect, SarChip, TrackUpdate } from '@/types/detections';

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
  /** latest clip result for this site */
  latest: AcousticDetect;
  /** clips where `detected` was true, last hour-ish (best-effort count) */
  detections: number;
  /** total clips seen */
  clips: number;
}

interface State {
  sarChips: SarChip[];
  tracks: Record<string, TrackRecord>;
  acousticSites: Record<string, AcousticSiteRecord>;
  ingestSarChip: (c: SarChip) => void;
  ingestTrackUpdate: (t: TrackUpdate) => void;
  ingestAcousticDetect: (d: AcousticDetect) => void;
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
        latest: d,
        detections: (prev?.detections ?? 0) + (d.detected ? 1 : 0),
        clips: (prev?.clips ?? 0) + 1,
      };
      return { acousticSites: { ...s.acousticSites, [d.site_code]: rec } };
    }),
}));
