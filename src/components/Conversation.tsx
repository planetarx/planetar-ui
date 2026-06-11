import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useBroker } from '@/hooks/useBroker';
import { useChannelMessages } from '@/hooks/useChannelMessages';
import { chatTopic } from '@/lib/topic';
import { useChannelsStore } from '@/store/channelsStore';
import { useLayoutStore } from '@/store/layoutStore';
import type { VesselSummary } from '@/types';
import type { ChatPayload, ZmesgEnvelope } from '@/types/zmesg';
import { isChatEnvelope } from '@/types/zmesg';

const SELF_SOURCE = 'ui:you';
const SELF_NAME = 'you';

// How close to the bottom (px) still counts as "following the conversation".
// Matches the doibio comms-app threshold.
const BOTTOM_THRESHOLD = 100;

function formatTime(ns: string): string {
  try {
    const ms = Number(BigInt(ns) / 1_000_000n);
    const d = new Date(ms);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  } catch {
    return '—:—';
  }
}

function initialsFor(name: string): string {
  return name.slice(0, 2).toUpperCase();
}

const ENTITY_RX = /⟦([^⟧]+)⟧/g;

function renderBody(text: string, onPick: (id: string) => void) {
  const parts: React.ReactNode[] = [];
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  ENTITY_RX.lastIndex = 0;
  while ((m = ENTITY_RX.exec(text))) {
    if (m.index > lastIdx) parts.push(text.slice(lastIdx, m.index));
    const id = m[1];
    parts.push(
      <span
        key={`${m.index}-${id}`}
        className="entity-token"
        onClick={() => onPick(id)}
        title={`Focus ${id}`}
      >
        ⟦{id}⟧
      </span>,
    );
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < text.length) parts.push(text.slice(lastIdx));
  return parts;
}

function statusText(status: 'connecting' | 'open' | 'closed') {
  if (status === 'open') return 'bus · live';
  if (status === 'connecting') return 'bus · connecting';
  return 'bus · offline';
}

function formatLatLon(lat: number, lon: number) {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(4)}${ns} ${Math.abs(lon).toFixed(4)}${ew}`;
}

function ageOf(ns?: string): string {
  if (!ns) return '—';
  try {
    const ms = Number(BigInt(ns) / 1_000_000n);
    const dt = Date.now() - ms;
    if (dt < 0) return 'now';
    if (dt < 1000) return 'now';
    if (dt < 60_000) return `${Math.floor(dt / 1000)}s ago`;
    if (dt < 3_600_000) return `${Math.floor(dt / 60_000)}m ago`;
    return `${Math.floor(dt / 3_600_000)}h ago`;
  } catch {
    return '—';
  }
}

function VesselPin({ vessel }: { vessel: VesselSummary }) {
  const status = vessel.status ?? 'live';
  const moored = typeof vessel.sog === 'number' && vessel.sog < 0.3;
  return (
    <div className={`vessel-pin vessel-pin-${status}`}>
      <div className="vessel-pin-head">
        <span className="vessel-pin-name">{vessel.name}</span>
        <span className="vessel-pin-mmsi">MMSI {vessel.mmsi}</span>
        {vessel.type ? <span className="vessel-pin-chip">{vessel.type}</span> : null}
        {vessel.flag ? <span className="vessel-pin-chip">{vessel.flag}</span> : null}
        <span className="vessel-pin-spacer" />
        <span className={`vessel-pin-status vessel-pin-status-${status}`}>
          {status === 'lost' ? 'lost' : status === 'dark' ? 'AIS dark' : moored ? 'moored' : 'live'}
        </span>
      </div>
      <div className="vessel-pin-row">
        <span className="vessel-pin-label">pos</span>
        <span className="vessel-pin-value">
          {typeof vessel.lat === 'number' && typeof vessel.lon === 'number'
            ? formatLatLon(vessel.lat, vessel.lon)
            : '—'}
        </span>
        <span className="vessel-pin-label">sog</span>
        <span className="vessel-pin-value">
          {typeof vessel.sog === 'number' ? `${vessel.sog.toFixed(1)} kn` : '—'}
        </span>
        <span className="vessel-pin-label">cog</span>
        <span className="vessel-pin-value">
          {typeof vessel.cog === 'number' ? `${Math.round(vessel.cog)}°` : '—'}
        </span>
        {vessel.destination ? (
          <>
            <span className="vessel-pin-label">dest</span>
            <span className="vessel-pin-value">⟦{vessel.destination}⟧</span>
          </>
        ) : null}
        <span className="vessel-pin-spacer" />
        <span className="vessel-pin-age">last AIS · {ageOf(vessel.lastSeenNs)}</span>
      </div>
    </div>
  );
}

export function Conversation() {
  const currentChannelId = useLayoutStore((s) => s.currentChannelId);
  const headerVisible = useLayoutStore((s) => s.paneVisibility.header);
  const noteInteraction = useLayoutStore((s) => s.noteInteraction);
  const setSelectedEntity = useLayoutStore((s) => s.setSelectedEntity);

  const channel = useChannelsStore((s) => s.channels[currentChannelId]);
  const topic = useMemo(() => (channel ? chatTopic(channel) : null), [channel]);

  const envelopes = useChannelMessages(topic);
  const { status, publish } = useBroker();

  const [draft, setDraft] = useState('');
  const [unreadCount, setUnreadCount] = useState(0);
  const streamRef = useRef<HTMLDivElement>(null);
  // Whether the user is currently parked at (or near) the bottom. While true,
  // new messages auto-scroll into view; while false, they accumulate behind
  // the "N new messages" pill and the scroll position is left untouched.
  const atBottomRef = useRef(true);
  const prevTopicRef = useRef<string | null>(null);
  const prevLenRef = useRef(0);

  const scrollToBottom = () => {
    const el = streamRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  // Track whether the user has scrolled away from the bottom.
  useEffect(() => {
    const el = streamRef.current;
    if (!el) return;
    const onScroll = () => {
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_THRESHOLD;
      atBottomRef.current = nearBottom;
      // Returning to the bottom clears the unread pill.
      if (nearBottom) setUnreadCount(0);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // New-message handling: auto-scroll only if the user is following along;
  // otherwise bump the unread count. Channel switches always land at bottom.
  useLayoutEffect(() => {
    const el = streamRef.current;
    if (!el) return;
    const topicChanged = prevTopicRef.current !== topic;
    const prevLen = prevLenRef.current;
    const newLen = envelopes.length;
    prevTopicRef.current = topic;
    prevLenRef.current = newLen;

    if (topicChanged) {
      atBottomRef.current = true;
      setUnreadCount(0);
      el.scrollTop = el.scrollHeight;
      return;
    }
    if (newLen === 0) return;
    if (atBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    } else {
      // delta is 0 once the per-topic store hits its cap; count it as ≥1.
      const delta = newLen - prevLen;
      setUnreadCount((c) => c + (delta > 0 ? delta : 1));
    }
  }, [topic, envelopes]);

  // Reset draft on channel switch
  useEffect(() => {
    setDraft('');
  }, [topic]);

  const jumpToBottom = () => {
    scrollToBottom();
    atBottomRef.current = true;
    setUnreadCount(0);
  };

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!topic || !draft.trim()) return;
    const payload: ChatPayload = {
      text: draft.trim(),
      author: { id: SELF_SOURCE, name: SELF_NAME, role: 'operator' },
    };
    publish({
      topic,
      source: SELF_SOURCE,
      schemaName: 'chat.v1.Message',
      payload,
    });
    setDraft('');
    // Sending re-engages bottom-follow so you see your own message land.
    atBottomRef.current = true;
    setUnreadCount(0);
    scrollToBottom();
  };

  return (
    <section className="pane conversation" onMouseDown={() => noteInteraction('conversation')}>
      {headerVisible && (
        <header className="pane-header">
          <span className="ph-section">#</span>
          <span className="ph-title">{channel?.name ?? '—'}</span>
          <span className="ph-spacer" />
          <span className={`status-dot ${status === 'open' ? '' : 'offline'}`} />
          <span style={{ fontSize: 11, color: 'var(--text-dim)', fontFamily: 'var(--mono)' }}>
            {statusText(status)}
          </span>
        </header>
      )}
      <div className="conv-stream-wrap">
      <div className="conv-stream" ref={streamRef}>
        {channel?.vessel ? <VesselPin vessel={channel.vessel} /> : null}
        {envelopes.length === 0 && !channel?.vessel ? (
          <div style={{ color: 'var(--text-dim)', fontSize: 12, fontFamily: 'var(--mono)', padding: '8px 0' }}>
            no envelopes yet on <code>{topic}</code> — waiting for traffic.
          </div>
        ) : null}
        {envelopes.map((env: ZmesgEnvelope) => {
          if (!isChatEnvelope(env)) {
            // Render unknown schema as raw envelope summary
            return (
              <div key={env.id} className="conv-msg">
                <div className="conv-avatar">??</div>
                <div className="conv-content">
                  <div className="conv-meta">
                    <span className="conv-author">{env.source}</span>
                    <span className="conv-time">{formatTime(env.createdAtNs)}</span>
                    <span className="conv-time">· {env.schemaName}</span>
                  </div>
                  <div className="conv-body" style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text-dim)' }}>
                    {JSON.stringify(env.payload)}
                  </div>
                </div>
              </div>
            );
          }
          const { text, author } = env.payload;
          return (
            <div key={env.id} className="conv-msg">
              <div className="conv-avatar">{initialsFor(author.name)}</div>
              <div className="conv-content">
                <div className="conv-meta">
                  <span className="conv-author">{author.name}</span>
                  <span className="conv-time">{formatTime(env.createdAtNs)}</span>
                  {author.role ? <span className="conv-time">· {author.role}</span> : null}
                </div>
                <div className="conv-body">{renderBody(text, setSelectedEntity)}</div>
              </div>
            </div>
          );
        })}
      </div>
        {unreadCount > 0 ? (
          <button type="button" className="conv-jump" onClick={jumpToBottom}>
            {unreadCount} new message{unreadCount === 1 ? '' : 's'} ↓
          </button>
        ) : null}
      </div>
      <form className="conv-input" onSubmit={onSubmit}>
        <input
          id="message-input"
          placeholder={topic ? `Message #${channel?.name ?? ''}` : 'select a channel'}
          autoComplete="off"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={!topic || status !== 'open'}
        />
      </form>
    </section>
  );
}
