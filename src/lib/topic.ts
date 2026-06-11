import type { Channel } from '@/types';

export function chatTopic(channel: Pick<Channel, 'serverId' | 'name'>): string {
  return `chat.${channel.serverId}.${channel.name}`;
}

export function parseChatTopic(topic: string): { serverId: string; channelName: string } | null {
  const m = /^chat\.([^.]+)\.(.+)$/.exec(topic);
  if (!m) return null;
  return { serverId: m[1], channelName: m[2] };
}
