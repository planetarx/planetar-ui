// Resolved canonical entities from planetar-ontology's Object API.
// Seeded by useOntology's REST fetch, kept live by the /subscribe WS feed.

import { create } from 'zustand';
import type { OntologyEntity } from '@/lib/ontology';

interface State {
  byId: Record<string, OntologyEntity>;
  upsert: (e: OntologyEntity) => void;
}

export const useEntitiesStore = create<State>()((set) => ({
  byId: {},
  upsert: (e) =>
    set((s) => ({ byId: { ...s.byId, [e.id]: e } })),
}));
