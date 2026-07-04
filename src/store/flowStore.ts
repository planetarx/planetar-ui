import { create } from 'zustand';
import type { FlowSnapshot } from '@/lib/flow/engine';
import type { ConsumerKey } from '@/lib/flow/layout';

export type FlowSelection =
  | { kind: 'message'; id: string }
  | { kind: 'lane'; key: string }
  | { kind: 'producer'; key: string }
  | { kind: 'consumer'; key: ConsumerKey }
  | null;

interface FlowState {
  /** Topology + stats, flushed from the flow engine at 4 Hz (not per message). */
  snapshot: FlowSnapshot | null;
  selection: FlowSelection;
  setSnapshot: (s: FlowSnapshot) => void;
  select: (sel: FlowSelection) => void;
}

export const useFlowStore = create<FlowState>()((set) => ({
  snapshot: null,
  selection: null,
  setSnapshot: (snapshot) => set({ snapshot }),
  select: (selection) => set({ selection }),
}));
