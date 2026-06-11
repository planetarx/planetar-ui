import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ChannelLayout, DataTab, PaneKey } from '@/types';

interface State {
  currentServerId: string;
  currentChannelId: string;

  paneVisibility: Record<Exclude<PaneKey, 'conversation'>, boolean> & { header: boolean };

  focusedPane: PaneKey | null;
  lastInteractedPane: PaneKey;

  channelLayouts: Record<string, ChannelLayout>;

  showHelp: boolean;
  selectedEntityId: string | null;

  setCurrentServer: (id: string) => void;
  setCurrentChannel: (id: string) => void;
  toggleVisibility: (key: keyof State['paneVisibility']) => void;
  setVisibility: (key: keyof State['paneVisibility'], value: boolean) => void;
  focusPane: (pane: PaneKey | null) => void;
  noteInteraction: (pane: PaneKey) => void;
  resetLayout: () => void;
  setChannelWidth: (channelId: string, key: 'channelsWidth' | 'dataWidth', width: number) => void;
  setActiveTab: (channelId: string, tab: DataTab) => void;
  toggleHelp: () => void;
  setSelectedEntity: (id: string | null) => void;
}

const DEFAULT_LAYOUT: ChannelLayout = {
  channelsWidth: 20,
  dataWidth: 36,
  activeDataTab: 'map',
};

export const useLayoutStore = create<State>()(
  persist(
    (set, get) => ({
      currentServerId: 'pac',
      currentChannelId: 'pac-ais',
      paneVisibility: { rail: true, channels: true, data: true, header: true },
      focusedPane: null,
      lastInteractedPane: 'conversation',
      channelLayouts: {},
      showHelp: false,
      selectedEntityId: null,

      // Switching Operations clears the vessel selection — a selection in one
      // Operation must not pull the map camera back when you move to another.
      setCurrentServer: (id) => set({ currentServerId: id, selectedEntityId: null }),
      setCurrentChannel: (id) => set({ currentChannelId: id }),

      toggleVisibility: (key) =>
        set((s) => ({
          paneVisibility: { ...s.paneVisibility, [key]: !s.paneVisibility[key] },
        })),
      setVisibility: (key, value) =>
        set((s) => ({ paneVisibility: { ...s.paneVisibility, [key]: value } })),

      focusPane: (pane) => set({ focusedPane: pane }),
      noteInteraction: (pane) => {
        if (get().lastInteractedPane !== pane) set({ lastInteractedPane: pane });
      },

      resetLayout: () =>
        set({
          paneVisibility: { rail: true, channels: true, data: true, header: true },
          focusedPane: null,
          channelLayouts: {},
        }),

      setChannelWidth: (channelId, key, width) =>
        set((s) => {
          const prev = s.channelLayouts[channelId] ?? DEFAULT_LAYOUT;
          return {
            channelLayouts: {
              ...s.channelLayouts,
              [channelId]: { ...prev, [key]: width },
            },
          };
        }),

      setActiveTab: (channelId, tab) =>
        set((s) => {
          const prev = s.channelLayouts[channelId] ?? DEFAULT_LAYOUT;
          return {
            channelLayouts: {
              ...s.channelLayouts,
              [channelId]: { ...prev, activeDataTab: tab },
            },
          };
        }),

      toggleHelp: () => set((s) => ({ showHelp: !s.showHelp })),
      setSelectedEntity: (id) => set({ selectedEntityId: id }),
    }),
    {
      name: 'planetar-ui-layout',
      version: 1,
      partialize: (s) => ({
        currentServerId: s.currentServerId,
        currentChannelId: s.currentChannelId,
        paneVisibility: s.paneVisibility,
        channelLayouts: s.channelLayouts,
      }),
    },
  ),
);

export function getChannelLayout(channelId: string): ChannelLayout {
  return useLayoutStore.getState().channelLayouts[channelId] ?? DEFAULT_LAYOUT;
}

export { DEFAULT_LAYOUT };
