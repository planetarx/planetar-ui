import type { ComponentType } from 'react';
import { useLayoutStore, getChannelLayout } from '@/store/layoutStore';
import type { DataTab } from '@/types';
import { Inspector } from './Inspector';
import { MapTab } from './tabs/MapTab';
import { TimelineTab } from './tabs/TimelineTab';
import { GraphTab } from './tabs/GraphTab';
import { ImageryTab } from './tabs/ImageryTab';
import { SignalTab } from './tabs/SignalTab';

const TABS: { id: DataTab; glyph: string; label: string }[] = [
  { id: 'map', glyph: '▣', label: 'Map' },
  { id: 'timeline', glyph: '◷', label: 'Timeline' },
  { id: 'graph', glyph: '⌘', label: 'Graph' },
  { id: 'imagery', glyph: '📷', label: 'Imagery' },
  { id: 'signal', glyph: '〰', label: 'Signal' },
];

const TAB_VIEWS: Record<DataTab, ComponentType> = {
  map: MapTab,
  timeline: TimelineTab,
  graph: GraphTab,
  imagery: ImageryTab,
  signal: SignalTab,
};

export function DataPane() {
  const currentChannelId = useLayoutStore((s) => s.currentChannelId);
  const layout = useLayoutStore((s) => s.channelLayouts[s.currentChannelId]) ?? getChannelLayout(currentChannelId);
  const setActiveTab = useLayoutStore((s) => s.setActiveTab);
  const noteInteraction = useLayoutStore((s) => s.noteInteraction);

  const active = layout.activeDataTab;
  const Active = TAB_VIEWS[active];

  return (
    <section className="pane" onMouseDown={() => noteInteraction('data')}>
      <div className="tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`tab ${t.id === active ? 'active' : ''}`}
            onClick={() => setActiveTab(currentChannelId, t.id)}
          >
            <span className="tab-glyph">{t.glyph}</span>
            <span>{t.label}</span>
          </button>
        ))}
      </div>
      <div className="tab-content">
        <Active />
      </div>
      <Inspector />
    </section>
  );
}
