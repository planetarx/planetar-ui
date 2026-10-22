// Seeds the map with every vessel's last-known position from the ontology, so
// a fresh page shows the whole fleet at once instead of waiting minutes for
// each vessel's next AIS report (moored vessels report only every few
// minutes). Live AIS then takes over record by record. Also runs the ageing
// sweep: no report for 1 h → grey, for 24 h → off the map.

import { ontology } from './ontology';
import { useAisStore, EXPIRE_AFTER_MS } from '@/store/aisStore';
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

async function seed() {
  const cutoffNs = BigInt(Date.now() - EXPIRE_AFTER_MS) * 1_000_000n;
  // Newest-updated first: stop at the first page that reaches past the cutoff.
  for (let page = 0; page < MAX_PAGES; page++) {
    const entities = await ontology.listObjects(VESSEL_TYPE, { limit: PAGE, offset: page * PAGE });
    useAisStore.getState().seed(
      entities.map((e) => toPosition(e.body)).filter((p): p is AisPosition => p !== null),
    );
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
  setInterval(() => useAisStore.getState().age(), AGE_SWEEP_MS);
}
