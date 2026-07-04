import type { Channel } from '@/types';

export function chatTopic(channel: Pick<Channel, 'serverId' | 'name'>): string {
  return `chat.${channel.serverId}.${channel.name}`;
}

export function parseChatTopic(topic: string): { serverId: string; channelName: string } | null {
  const m = /^chat\.([^.]+)\.(.+)$/.exec(topic);
  if (!m) return null;
  return { serverId: m[1], channelName: m[2] };
}

/**
 * Broker-style topic patterns: `*` matches exactly one dot-segment, a trailing
 * `**` matches the rest (so `**` alone matches everything).
 * Mirrors bridge/server.mjs topicMatches — keep the two in sync.
 */
export function topicMatches(pattern: string, topic: string): boolean {
  if (pattern === topic) return true;
  if (!pattern.includes('*')) return false;
  const p = pattern.split('.');
  const t = topic.split('.');
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '**') return i === p.length - 1;
    if (i >= t.length) return false;
    if (p[i] !== '*' && p[i] !== t[i]) return false;
  }
  return p.length === t.length;
}
