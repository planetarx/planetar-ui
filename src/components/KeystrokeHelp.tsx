import { useLayoutStore } from '@/store/layoutStore';

const ROWS: { keys: string; label: string }[] = [
  { keys: 'Ctrl + Shift + R', label: 'Toggle server rail' },
  { keys: 'Ctrl + Shift + S', label: 'Toggle channel list' },
  { keys: 'Ctrl + Shift + Y', label: 'Toggle channel header' },
  { keys: 'Ctrl + Shift + D', label: 'Toggle data pane' },
  { keys: 'Ctrl + Shift + F', label: 'Focus current pane fullscreen' },
  { keys: 'Esc', label: 'Exit focus mode' },
  { keys: 'Ctrl + Shift + 0', label: 'Reset layout' },
  { keys: 'Ctrl + Shift + /', label: 'Show this help' },
];

export function KeystrokeHelp() {
  const toggleHelp = useLayoutStore((s) => s.toggleHelp);

  return (
    <div className="help-overlay" onClick={toggleHelp}>
      <div className="help-panel" onClick={(e) => e.stopPropagation()}>
        <div className="help-title">Keystrokes</div>
        {ROWS.map((r) => (
          <div className="help-row" key={r.keys}>
            <span>{r.label}</span>
            <span className="kbd">{r.keys}</span>
          </div>
        ))}
        <div className="help-hint">click anywhere or press Esc to close</div>
      </div>
    </div>
  );
}
