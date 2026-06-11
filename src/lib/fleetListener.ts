// Wires the broker's vessel.ais.fleet control plane to the channels and
// messages stores. Each fleet "appeared" event spawns a Slack-style
// channel for that vessel; subsequent updates refresh the vessel sidecar.
// Also forwards status transitions into aisStore so the map's per-status
// color expression has data to react to (dark/lost dots). Lost vessels
// stay on the map painted grey — for dark-vessel detection work the
// last-known position is the most useful signal there is.

import { broker } from './broker';
import { useAisStore } from '@/store/aisStore';
import { useChannelsStore } from '@/store/channelsStore';
import type { ZmesgEnvelope } from '@/types/zmesg';
import type { VesselSummary } from '@/types';

const FLEET_TOPIC = 'vessel.ais.fleet';

interface FleetPayload {
  event: 'appeared' | 'update' | 'static-update' | 'anomaly' | 'lost';
  mmsi: number;
  channelId: string;
  channelName: string;
  serverId: string;
  topic: string;
  vessel: {
    mmsi: number;
    name?: string;
    type?: string;
    flag?: string | null;
    lat?: number;
    lon?: number;
    sog?: number;
    cog?: number;
    destination?: string | null;
    lastSeenNs?: string;
  };
}

function asVesselSummary(p: FleetPayload, status?: VesselSummary['status']): VesselSummary {
  const v = p.vessel ?? ({ mmsi: p.mmsi } as FleetPayload['vessel']);
  return {
    mmsi: v.mmsi ?? p.mmsi,
    name: (v.name ?? `MMSI ${p.mmsi}`).toString(),
    type: v.type,
    flag: v.flag ?? null,
    lat: v.lat,
    lon: v.lon,
    sog: v.sog,
    cog: v.cog,
    destination: v.destination ?? null,
    lastSeenNs: v.lastSeenNs,
    status,
  };
}

function handle(env: ZmesgEnvelope) {
  if (env.topic !== FLEET_TOPIC) return;
  const p = env.payload as FleetPayload | undefined;
  if (!p?.channelId || !p?.serverId) return;

  const store = useChannelsStore.getState();

  if (p.event === 'appeared') {
    store.upsert({
      id: p.channelId,
      serverId: p.serverId,
      name: p.channelName,
      section: 'vessels',
      vessel: asVesselSummary(p, 'live'),
    });
    return;
  }

  if (p.event === 'lost') {
    // Keep the map record in place — for dark-vessel work the operator
    // *wants* the last-known position to persist, painted grey via the
    // map's per-status circle-color match. Channel also greys.
    useAisStore.getState().markStatus(p.mmsi, 'lost');
    if (!store.channels[p.channelId]) return;
    store.markVesselStatus(p.channelId, 'lost');
    return;
  }

  if (p.event === 'anomaly') {
    // Anomaly stream — paint the map dot orange even if we never saw a
    // channel for this MMSI (e.g. dark-on-first-contact edge case).
    useAisStore.getState().markStatus(p.mmsi, 'dark');
    if (!store.channels[p.channelId]) {
      store.upsert({
        id: p.channelId,
        serverId: p.serverId,
        name: p.channelName,
        section: 'vessels',
        vessel: asVesselSummary(p, 'dark'),
      });
      return;
    }
    store.attachVessel(p.channelId, asVesselSummary(p, 'dark'));
    return;
  }

  // update / static-update — a 'live' signal clears any prior dark.
  useAisStore.getState().markStatus(p.mmsi, 'live');
  if (!store.channels[p.channelId]) {
    store.upsert({
      id: p.channelId,
      serverId: p.serverId,
      name: p.channelName,
      section: 'vessels',
      vessel: asVesselSummary(p, 'live'),
    });
    return;
  }
  store.attachVessel(p.channelId, asVesselSummary(p, 'live'));
}

let started = false;
export function startFleetListener() {
  if (started) return;
  started = true;
  broker.subscribe(FLEET_TOPIC);
  broker.onEnvelope(handle);
}
