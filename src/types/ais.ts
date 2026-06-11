// AIS payload contracts shared with planetar-ais. These mirror the shapes that
// planetar-ais publishes; the UI never invents fields. If a producer omits an
// optional field, the map renders the vessel with sensible defaults.

/**
 * `vessel.ais.Position.v1` — high-frequency kinematic + identity snapshot.
 * Published on topic `vessel.ais.position`. The payload IS the vessel snapshot
 * directly (no nesting). Every position update can carry the full identity
 * fields; downstream stores fold them into a single per-MMSI record.
 */
export interface AisPosition {
  mmsi: number;
  name?: string;
  type?: string;
  flag?: string | null;
  length?: number;
  callsign?: string;
  lat: number;
  lon: number;
  sog: number;          // speed over ground, knots
  cog: number;          // course over ground, degrees true
  heading?: number;     // gyrocompass heading, degrees true (often equals cog for slow vessels)
  destination?: string | null;
  lastSeenNs: string;   // BigInt-as-string (JSON can't carry ns precision as Number)
  firstSeenNs?: string;
  inBBox?: boolean;     // producer-side AOI flag; UI uses for "left BBox" handling
  serverId?: string;    // Operation (planetar-ui server id) this vessel belongs to
}

/**
 * `vessel.ais.Fleet.v1` — control-plane event for channel-list bookkeeping.
 * Published on topic `vessel.ais.fleet`. The map foundation listens too, but
 * only for lifecycle: 'appeared'/'lost' to add/remove markers from stale
 * vessels that haven't sent a Position recently.
 */
export interface AisFleetEvent {
  event: 'appeared' | 'update' | 'static-update' | 'anomaly' | 'lost';
  mmsi: number;
  channelId: string;
  channelName: string;
  serverId: string;
  topic: string;
  vessel: Partial<AisPosition> & { mmsi: number };
}

export type VesselStatus = 'live' | 'dark' | 'lost';

/**
 * Tracked MMSIs get distinct styling on the map (highlighted symbol, label
 * always visible, automatic camera-follow on first sighting). Edit this list
 * to add new tracked vessels.
 */
export const TRACKED_MMSI: ReadonlySet<number> = new Set<number>([
  311001249, // user-tracked vessel
]);

export function isTracked(mmsi: number): boolean {
  return TRACKED_MMSI.has(mmsi);
}
