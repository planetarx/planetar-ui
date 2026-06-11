import { useEffect, useMemo, useRef } from 'react';
import { Group, Panel, Separator, useGroupRef } from 'react-resizable-panels';
import type { Layout } from 'react-resizable-panels';
import { ChannelList } from '@/components/ChannelList';
import { Conversation } from '@/components/Conversation';
import { DataPane } from '@/components/DataPane';
import { KeystrokeHelp } from '@/components/KeystrokeHelp';
import { ServerRail } from '@/components/ServerRail';
import { DEFAULT_LAYOUT, useLayoutStore } from '@/store/layoutStore';
import type { PaneKey } from '@/types';
import './App.css';

const PANE_LABEL: Record<PaneKey, string> = {
  rail: 'Server rail',
  channels: 'Channels',
  conversation: 'Conversation',
  data: 'Data',
};

export default function App() {
  const visibility = useLayoutStore((s) => s.paneVisibility);
  const focusedPane = useLayoutStore((s) => s.focusedPane);
  const lastInteractedPane = useLayoutStore((s) => s.lastInteractedPane);
  const showHelp = useLayoutStore((s) => s.showHelp);
  const currentChannelId = useLayoutStore((s) => s.currentChannelId);
  const layout = useLayoutStore((s) => s.channelLayouts[s.currentChannelId]) ?? DEFAULT_LAYOUT;

  const toggleVisibility = useLayoutStore((s) => s.toggleVisibility);
  const focusPane = useLayoutStore((s) => s.focusPane);
  const resetLayout = useLayoutStore((s) => s.resetLayout);
  const toggleHelp = useLayoutStore((s) => s.toggleHelp);
  const setChannelWidth = useLayoutStore((s) => s.setChannelWidth);

  // Compute which panes are visible
  const showRail = focusedPane ? focusedPane === 'rail' : visibility.rail;
  const showChannels = focusedPane ? focusedPane === 'channels' : visibility.channels;
  const showConversation = focusedPane ? focusedPane === 'conversation' : true;
  const showData = focusedPane ? focusedPane === 'data' : visibility.data;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Esc clears focus or closes help
      if (e.key === 'Escape') {
        if (showHelp) {
          e.preventDefault();
          toggleHelp();
          return;
        }
        if (focusedPane) {
          e.preventDefault();
          focusPane(null);
          return;
        }
        return;
      }

      // Don't capture typing keys outside of Ctrl+Shift modifier
      if (!(e.ctrlKey && e.shiftKey)) return;

      const k = e.key.toLowerCase();
      switch (k) {
        case 'r':
          e.preventDefault();
          toggleVisibility('rail');
          break;
        case 's':
          e.preventDefault();
          toggleVisibility('channels');
          break;
        case 'y':
          e.preventDefault();
          toggleVisibility('header');
          break;
        case 'd':
          e.preventDefault();
          toggleVisibility('data');
          break;
        case 'f':
          e.preventDefault();
          focusPane(focusedPane ? null : lastInteractedPane);
          break;
        case '?':
        case '/':
          e.preventDefault();
          toggleHelp();
          break;
        case '0':
        case ')':
          e.preventDefault();
          resetLayout();
          break;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [focusedPane, lastInteractedPane, showHelp, toggleVisibility, focusPane, resetLayout, toggleHelp]);

  // Layout sizes for the horizontal panel group
  const panelSpec = useMemo(() => {
    if (focusedPane) {
      return { channels: 100, conv: 100, data: 100 };
    }
    const ch = showChannels ? layout.channelsWidth : 0;
    const da = showData ? layout.dataWidth : 0;
    const co = Math.max(20, 100 - ch - da);
    return { channels: ch, conv: co, data: da };
  }, [focusedPane, showChannels, showData, layout.channelsWidth, layout.dataWidth]);

  const handleLayoutChanged = (next: Layout) => {
    if (focusedPane) return;
    if (showChannels && typeof next['channels-panel'] === 'number') {
      setChannelWidth(currentChannelId, 'channelsWidth', next['channels-panel']);
    }
    if (showData && typeof next['data-panel'] === 'number') {
      setChannelWidth(currentChannelId, 'dataWidth', next['data-panel']);
    }
  };

  /*
   * Per-channel layout used to be applied by re-keying the Group on
   * `currentChannelId`, which forced a remount of every Panel — and therefore
   * a remount of the MapLibre canvas inside the data pane. That race
   * (MapLibre capturing container dims during the in-flight Panel relayout)
   * showed up as a horizontally-stretched map after "Open channel". We now
   * keep the Group mounted across channel switches and apply the new
   * channel's stored widths imperatively. The Map's ResizeObserver picks up
   * the smooth panel transition and resizes the canvas naturally.
   */
  const groupRef = useGroupRef();
  const lastAppliedChannelRef = useRef<string | null>(null);
  useEffect(() => {
    if (!groupRef.current) return;
    if (focusedPane) return;
    if (lastAppliedChannelRef.current === currentChannelId) return;
    lastAppliedChannelRef.current = currentChannelId;
    const target: Record<string, number> = {};
    if (showChannels) target['channels-panel'] = panelSpec.channels;
    if (showConversation) target['conv-panel'] = panelSpec.conv;
    if (showData) target['data-panel'] = panelSpec.data;
    groupRef.current.setLayout(target);
  }, [currentChannelId, panelSpec, focusedPane, showChannels, showConversation, showData, groupRef]);

  // Group remounts only when the set of visible panels changes — NOT on
  // channel change. That keeps the MapLibre WebGL context alive.
  const groupKey = `${focusedPane ?? '-'}|${showChannels ? 1 : 0}${showConversation ? 1 : 0}${showData ? 1 : 0}`;

  return (
    <div className="app">
      {showRail && <ServerRail />}
      <div className="workspace">
        <Group key={groupKey} groupRef={groupRef} orientation="horizontal" onLayoutChanged={handleLayoutChanged}>
          {showChannels && (
            <Panel defaultSize={panelSpec.channels} minSize={12} id="channels-panel">
              <ChannelList />
            </Panel>
          )}
          {showChannels && (showConversation || showData) && (
            <Separator className="resize-handle" />
          )}
          {showConversation && (
            <Panel defaultSize={panelSpec.conv} minSize={20} id="conv-panel">
              <Conversation />
            </Panel>
          )}
          {showConversation && showData && <Separator className="resize-handle" />}
          {showData && (
            <Panel defaultSize={panelSpec.data} minSize={18} id="data-panel">
              <DataPane />
            </Panel>
          )}
        </Group>
      </div>

      {focusedPane && (
        <div className="focus-banner">
          <span className="label">Focus</span>
          <span className="target">{PANE_LABEL[focusedPane]}</span>
          <span className="kbd">Esc</span>
        </div>
      )}

      {showHelp && <KeystrokeHelp />}
    </div>
  );
}
