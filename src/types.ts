export type DataTab = 'map' | 'timeline' | 'graph' | 'imagery' | 'signal';

export type PaneKey = 'rail' | 'channels' | 'conversation' | 'data';

export interface Server {
  id: string;
  name: string;
  short: string;
  /** Map home — where the Map tab centres when this Operation is selected. */
  center?: { lon: number; lat: number; zoom?: number };
}

export type ChannelSection = 'channels' | 'vessels' | 'threads' | 'alerts';

export interface VesselSummary {
  mmsi: number;
  name: string;
  type?: string;
  flag?: string | null;
  lat?: number;
  lon?: number;
  sog?: number;
  cog?: number;
  destination?: string | null;
  lastSeenNs?: string;
  status?: 'live' | 'dark' | 'lost';
}

export interface Channel {
  id: string;
  serverId: string;
  name: string;
  unread?: number;
  section: ChannelSection;
  vessel?: VesselSummary;
}

export interface ChannelLayout {
  channelsWidth: number;
  dataWidth: number;
  activeDataTab: DataTab;
}
