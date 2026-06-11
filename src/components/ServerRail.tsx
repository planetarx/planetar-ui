import { servers, defaultChannelByServer } from '@/data/mocks';
import { useLayoutStore } from '@/store/layoutStore';

export function ServerRail() {
  const currentServerId = useLayoutStore((s) => s.currentServerId);
  const setCurrentServer = useLayoutStore((s) => s.setCurrentServer);
  const setCurrentChannel = useLayoutStore((s) => s.setCurrentChannel);
  const noteInteraction = useLayoutStore((s) => s.noteInteraction);

  const select = (id: string) => {
    setCurrentServer(id);
    const fallback = defaultChannelByServer[id];
    if (fallback) setCurrentChannel(fallback);
    noteInteraction('rail');
  };

  return (
    <nav className="rail" onMouseDown={() => noteInteraction('rail')} aria-label="Servers">
      {servers.map((s) => (
        <button
          key={s.id}
          className={`rail-server ${s.id === currentServerId ? 'active' : ''}`}
          title={s.name}
          onClick={() => select(s.id)}
        >
          {s.short}
        </button>
      ))}
      <div className="rail-divider" />
      <button className="rail-server rail-add" title="Add server">
        +
      </button>
    </nav>
  );
}
