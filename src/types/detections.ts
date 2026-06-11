// Detection payload contracts for the non-AIS producer services. Field names
// mirror the wire exactly (snake_case — these producers are Python services),
// so the UI never silently disagrees with the bus.
//
// Captured 2026-05-19 from live envelopes (acoustic) and producer source
// (sar/track — planetar-sat/src/planetar_sat).

/** `sar.chip` — schema `planetar.sar.chip`. One CFAR ship detection. */
export interface SarChip {
  scene_id: string;
  lat: number;
  lon: number;
  snr: number;
  bbox_px: [number, number, number, number];
  acquired_at_ns: number;
}

/** `track.update` — schema `planetar.track.update`. One position of a
 *  cross-pass vessel track; the envelope's correlation_id is the track_id. */
export interface TrackUpdate {
  track_id: string;
  lat: number;
  lon: number;
  speed_kn: number;
  course_deg: number;
  last_seen_ns: number;
  n_hits: number;
}

/** `acoustic.detect` — schema `planetar.acoustic.detect`. One hydrophone
 *  clip's detection result. lat/lon are the fixed hydrophone-site location. */
export interface AcousticDetect {
  clip_id: string;
  site_code: string;
  site_name: string;
  lat: number;
  lon: number;
  network: string;
  source: string;
  start_ns: number;
  dur_s: number;
  snr_db: number;
  band_hz: [number, number];
  peak_freq_hz: number;
  detected: boolean;
}

/**
 * `eo.detection` — schema `planetar.eo.detection.v1`. NOTE: a frame-relative
 * bounding box, NOT georeferenced — it cannot go on the map. Kept here for the
 * Imagery tab integration.
 */
export interface EoDetection {
  source_id: string;
  ts_ns: number;
  frame_seq: number;
  cls: number;
  cls_name: string;
  conf: number;
  bbox_xyxy: [number, number, number, number];
}

export const DETECTION_TOPICS = {
  sarChip: 'sar.chip',
  trackUpdate: 'track.update',
  acousticDetect: 'acoustic.detect',
} as const;
