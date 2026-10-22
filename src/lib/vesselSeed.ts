// Seeds the map with every vessel's last-known position from the ontology, so
// a fresh page shows the whole fleet at once instead of waiting minutes for
// each vessel's next AIS report (moored vessels report only every few
// minutes). The same entities seed the sidebar's vessel channels. Live AIS
// then takes over record by record. Also runs the ageing sweep over map and
// sidebar alike: no report for 1 h → grey, for 24 h → gone.

import { ontology } from './ontology';
import { asVesselSummary, type FleetPayload } from './fleetListener';
import { useAisStore, EXPIRE_AFTER_MS, STALE_AFTER_MS } from '@/store/aisStore';
import { useChannelsStore } from '@/store/channelsStore';
import { useLayoutStore } from '@/store/layoutStore';
import type { AisPosition } from '@/types/ais';

const VESSEL_TYPE = 'planetar:Vessel';
const PAGE = 100;
const MAX_PAGES = 10;
const AGE_SWEEP_MS = 60_000;

/** The entity body is the last vessel.ais.fleet payload the ontology folded in. */
function toPosition(body: Record<string, unknown>): AisPosition | null {
  const v = body.vessel as Partial<AisPosition> | undefined;
  if (!v || typeof v.mmsi !== 'number' || typeof v.lat !== 'number' || typeof v.lon !== 'number') return null;
  if (typeof v.lastSeenNs !== 'string') return null;
  const serverId = typeof body.serverId === 'string' ? body.serverId : v.serverId;
  return { ...v, sog: v.sog ?? 0, cog: v.cog ?? 0, serverId } as AisPosition;
}

function nsToMs(ns: string | undefined): number | null {
  if (!ns) return null;
  try {
    return Number(BigInt(ns) / 1_000_000n);
  } catch {
    return null;
  }
}

/** Add a sidebar channel for a stored vessel; a channel live AIS already made wins. */
function seedChannel(body: Record<string, unknown>, nowMs: number) {
  const p = body as unknown as FleetPayload;
  if (!p.channelId || !p.serverId || !p.vessel) return;
  const store = useChannelsStore.getState();
  if (store.channels[p.channelId]) return;
  const lastSeenMs = nsToMs(p.vessel.lastSeenNs);
  if (lastSeenMs == null || nowMs - lastSeenMs > EXPIRE_AFTER_MS) return;
  store.upsert({
    id: p.channelId,
    serverId: p.serverId,
    name: p.channelName,
    section: 'vessels',
    vessel: asVesselSummary(p, nowMs - lastSeenMs > STALE_AFTER_MS ? 'lost' : 'live'),
  });
}

/** Mirror the map's ageing onto vessel channels, going by the newest report either side has seen. */
function ageChannels(nowMs: number) {
  const store = useChannelsStore.getState();
  const byMmsi = useAisStore.getState().byMmsi;
  const current = useLayoutStore.getState().currentChannelId;
  for (const c of Object.values(store.channels)) {
    if (!c.vessel) continue;
    const seen = Math.max(nsToMs(c.vessel.lastSeenNs) ?? 0, byMmsi[c.vessel.mmsi]?.lastSeenMs ?? 0);
    if (!seen) continue;
    const age = nowMs - seen;
    if (age > EXPIRE_AFTER_MS && c.id !== current) store.remove(c.id);
    else if (age > STALE_AFTER_MS && c.vessel.status !== 'lost') store.markVesselStatus(c.id, 'lost');
  }
}

async function seed() {
  const cutoffNs = BigInt(Date.now() - EXPIRE_AFTER_MS) * 1_000_000n;
  // Newest-updated first: stop at the first page that reaches past the cutoff.
  for (let page = 0; page < MAX_PAGES; page++) {
    const entities = await ontology.listObjects(VESSEL_TYPE, { limit: PAGE, offset: page * PAGE });
    const nowMs = Date.now();
    useAisStore.getState().seed(
      entities.map((e) => toPosition(e.body)).filter((p): p is AisPosition => p !== null),
      nowMs,
    );
    for (const e of entities) seedChannel(e.body, nowMs);
    const last = entities.at(-1);
    if (entities.length < PAGE || !last || BigInt(last.updatedNs) < cutoffNs) return;
  }
}

let started = false;
export function startVesselSeed() {
  if (started) return;
  started = true;
  // Best effort: with no ontology the map just fills from live AIS as before.
  seed().catch((err) => console.warn('[vesselSeed] ontology unavailable:', err));
  setInterval(() => {
    const nowMs = Date.now();
    useAisStore.getState().age(nowMs);
    ageChannels(nowMs);
  }, AGE_SWEEP_MS);
}
