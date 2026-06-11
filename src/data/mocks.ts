import type { Channel, Server } from '@/types';

export const servers: Server[] = [
  { id: 'pac', name: 'Pacific Patrol', short: 'PP', center: { lon: -123.38, lat: 48.42, zoom: 10 } },
  { id: 'hormuz', name: 'Strait of Hormuz', short: 'SH', center: { lon: 56.35, lat: 26.85, zoom: 9 } },
  { id: 'arc', name: 'Arctic Watch', short: 'AW' },
  { id: 'trn', name: 'Training', short: 'TR' },
];

export const channels: Channel[] = [
  { id: 'pac-ais', serverId: 'pac', name: 'ais-anomalies', section: 'channels', unread: 3 },
  { id: 'pac-sar', serverId: 'pac', name: 'sar-detections', section: 'channels' },
  { id: 'pac-eo', serverId: 'pac', name: 'eo-chips', section: 'channels' },
  { id: 'pac-hyd', serverId: 'pac', name: 'hydrophone-alerts', section: 'channels', unread: 1 },
  { id: 'pac-rf', serverId: 'pac', name: 'rf-emitters', section: 'channels' },
  { id: 'pac-gen', serverId: 'pac', name: 'general', section: 'channels' },
  // Real per-vessel channels are populated dynamically by the AIS fleet
  // listener; keep one example thread + one alert for sidebar variety.
  { id: 'pac-t2', serverId: 'pac', name: 'sar-2026-05-13-08', section: 'threads' },
  { id: 'pac-a1', serverId: 'pac', name: 'dark-vessel-pacnw', section: 'alerts', unread: 2 },

  // Strait of Hormuz operation. Run planetar-ais with OP=hormuz to fill the
  // Vessels section with the live tanker fleet; these static entries seed
  // the sidebar so the operation reads as populated before the feed lands.
  { id: 'hz-ais', serverId: 'hormuz', name: 'ais-anomalies', section: 'channels', unread: 5 },
  { id: 'hz-tankers', serverId: 'hormuz', name: 'tanker-watch', section: 'channels', unread: 2 },
  { id: 'hz-sar', serverId: 'hormuz', name: 'sar-detections', section: 'channels' },
  { id: 'hz-naval', serverId: 'hormuz', name: 'naval-traffic', section: 'channels' },
  { id: 'hz-rf', serverId: 'hormuz', name: 'rf-emitters', section: 'channels' },
  { id: 'hz-gen', serverId: 'hormuz', name: 'general', section: 'channels' },
  { id: 'hz-a1', serverId: 'hormuz', name: 'strait-blockage', section: 'alerts', unread: 4 },
  { id: 'hz-a2', serverId: 'hormuz', name: 'dark-tanker-watch', section: 'alerts', unread: 2 },
];

export const defaultChannelByServer: Record<string, string> = {
  pac: 'pac-ais',
  hormuz: 'hz-ais',
  arc: 'pac-gen',
  trn: 'pac-gen',
};
