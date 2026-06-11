import { create } from 'zustand';
import { broker } from '@/lib/broker';
import type { ZmesgEnvelope } from '@/types/zmesg';

const MAX_PER_TOPIC = 500;

interface State {
  byTopic: Record<string, ZmesgEnvelope[]>;
  ingest: (env: ZmesgEnvelope) => void;
  clear: (topic: string) => void;
}

export const useMessagesStore = create<State>()((set) => ({
  byTopic: {},
  ingest: (env) =>
    set((s) => {
      const prev = s.byTopic[env.topic] ?? [];
      const next = [...prev, env];
      if (next.length > MAX_PER_TOPIC) next.splice(0, next.length - MAX_PER_TOPIC);
      return { byTopic: { ...s.byTopic, [env.topic]: next } };
    }),
  clear: (topic) =>
    set((s) => {
      const next = { ...s.byTopic };
      delete next[topic];
      return { byTopic: next };
    }),
}));

// Wire the broker to the store. One global listener for all envelopes.
broker.onEnvelope((env) => {
  useMessagesStore.getState().ingest(env);
});
