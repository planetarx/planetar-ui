import { useMemo } from 'react';
import { useChannelsStore } from '@/store/channelsStore';
import { useLayoutStore } from '@/store/layoutStore';
import type { ChannelSection } from '@/types';

const SECTION_TITLES: Record<ChannelSection, string> = {
  channels: 'Channels',
  vessels: 'Vessels',
  threads: 'Threads',
  alerts: 'Alerts',
};

const SECTION_ORDER: ChannelSection[] = ['channels', 'vessels', 'threads', 'alerts'];

function sectionGlyph(section: ChannelSection, status?: 'live' | 'dark' | 'lost') {
  if (section === 'threads') return '🧵';
  if (section === 'alerts') return '⚠';
  if (section === 'vessels') {
    if (status === 'lost') return '✕';
    if (status === 'dark') return '◌';
    return '⛵';
  }
  return '#';
}

export function ChannelList() {
  const currentServerId = useLayoutStore((s) => s.currentServerId);
  const currentChannelId = useLayoutStore((s) => s.currentChannelId);
  const setCurrentChannel = useLayoutStore((s) => s.setCurrentChannel);
  const noteInteraction = useLayoutStore((s) => s.noteInteraction);

  const channelMap = useChannelsStore((s) => s.channels);
  const order = useChannelsStore((s) => s.order);
  const servers = useChannelsStore((s) => s.servers);

  const grouped = useMemo(() => {
    const visible = order.map((id) => channelMap[id]).filter((c) => c && c.serverId === currentServerId);
    return SECTION_ORDER.map((section) => ({
      section,
      items: visible.filter((c) => c.section === section),
    }));
  }, [channelMap, order, currentServerId]);

  const server = servers.find((s) => s.id === currentServerId);

  return (
    <aside className="pane" onMouseDown={() => noteInteraction('channels')}>
      <header className="pane-header">
        <span className="ph-section">Operation</span>
        <span className="ph-title">{server?.name ?? '—'}</span>
      </header>
      <div className="pane-body">
        {grouped.map(({ section, items }) =>
          items.length === 0 ? null : (
            <div className="channels-section" key={section}>
              <div className="channels-section-title">
                {SECTION_TITLES[section]}
                <span className="channels-section-count">{items.length}</span>
              </div>
              {items.map((c) => {
                const status = c.vessel?.status;
                const subtitle =
                  c.vessel
                    ? `${c.vessel.name}${typeof c.vessel.sog === 'number' ? ` · ${c.vessel.sog.toFixed(1)} kn` : ''}`
                    : null;
                return (
                  <div
                    key={c.id}
                    className={`channel-item ${c.id === currentChannelId ? 'active' : ''} ${
                      status === 'dark' ? 'channel-dark' : status === 'lost' ? 'channel-lost' : ''
                    }`}
                    onClick={() => {
                      setCurrentChannel(c.id);
                      noteInteraction('channels');
                    }}
                    title={subtitle ?? c.name}
                  >
                    <span className="hash">{sectionGlyph(section, status)}</span>
                    <span>{c.name}</span>
                    {c.unread ? <span className="alert-dot" /> : null}
                  </div>
                );
              })}
            </div>
          ),
        )}
      </div>
    </aside>
  );
}
