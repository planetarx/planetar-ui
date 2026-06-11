import { useEffect } from 'react';
import { broker } from '@/lib/broker';
import { useMessagesStore } from '@/store/messagesStore';
import type { ZmesgEnvelope } from '@/types/zmesg';

const EMPTY: readonly ZmesgEnvelope[] = Object.freeze([]);

export function useChannelMessages(topic: string | null): readonly ZmesgEnvelope[] {
  useEffect(() => {
    if (!topic) return;
    const off = broker.subscribe(topic);
    return off;
  }, [topic]);

  return useMessagesStore((s) => (topic ? s.byTopic[topic] ?? EMPTY : EMPTY));
}
