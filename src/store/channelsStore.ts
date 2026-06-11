import { create } from 'zustand';
import {
  channels as seedChannels,
  servers as seedServers,
  defaultChannelByServer as seedDefaults,
} from '@/data/mocks';
import type { Channel, Server, VesselSummary } from '@/types';

interface State {
  channels: Record<string, Channel>;
  order: string[];
  servers: Server[];
  defaults: Record<string, string>;
  upsert: (channel: Channel) => void;
  attachVessel: (channelId: string, vessel: VesselSummary) => void;
  markVesselStatus: (channelId: string, status: NonNullable<VesselSummary['status']>) => void;
  bumpUnread: (channelId: string) => void;
  clearUnread: (channelId: string) => void;
}

const initialOrder = seedChannels.map((c) => c.id);
const initialMap: Record<string, Channel> = {};
for (const c of seedChannels) initialMap[c.id] = c;

export const useChannelsStore = create<State>()((set) => ({
  channels: initialMap,
  order: initialOrder,
  servers: seedServers,
  defaults: { ...seedDefaults },
  upsert: (channel) =>
    set((s) => {
      const exists = !!s.channels[channel.id];
      return {
        channels: { ...s.channels, [channel.id]: { ...s.channels[channel.id], ...channel } },
        order: exists ? s.order : [...s.order, channel.id],
      };
    }),
  attachVessel: (channelId, vessel) =>
    set((s) => {
      const cur = s.channels[channelId];
      if (!cur) return s;
      const merged = { ...(cur.vessel ?? {}), ...vessel } as VesselSummary;
      return { channels: { ...s.channels, [channelId]: { ...cur, vessel: merged } } };
    }),
  markVesselStatus: (channelId, status) =>
    set((s) => {
      const cur = s.channels[channelId];
      if (!cur?.vessel) return s;
      return {
        channels: {
          ...s.channels,
          [channelId]: { ...cur, vessel: { ...cur.vessel, status } },
        },
      };
    }),
  bumpUnread: (channelId) =>
    set((s) => {
      const cur = s.channels[channelId];
      if (!cur) return s;
      return {
        channels: { ...s.channels, [channelId]: { ...cur, unread: (cur.unread ?? 0) + 1 } },
      };
    }),
  clearUnread: (channelId) =>
    set((s) => {
      const cur = s.channels[channelId];
      if (!cur?.unread) return s;
      const { unread: _u, ...rest } = cur;
      return { channels: { ...s.channels, [channelId]: rest as Channel } };
    }),
}));

export function findChannelById(id: string): Channel | undefined {
  return useChannelsStore.getState().channels[id];
}
