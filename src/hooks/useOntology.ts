// Singleton wiring to planetar-ontology: seeds the entities store from the
// REST Object API and keeps it live via the /subscribe WebSocket feed.
// Ref-counted so mount/unmount cycles (e.g. switching to/from the Graph tab)
// do not flap the entity listener.

import { useEffect, useState } from 'react';
import { ontology } from '@/lib/ontology';
import { useEntitiesStore } from '@/store/entitiesStore';

const SEED_TYPES = ['planetar:Vessel'];

let entityUnsub: (() => void) | null = null;
let refCount = 0;

export function useOntology(): 'connecting' | 'open' | 'closed' {
  const [status, setStatus] = useState(ontology.getStatus());

  useEffect(() => {
    const offStatus = ontology.onStatus(setStatus);
    refCount += 1;
    if (refCount === 1) {
      entityUnsub = ontology.onEntity((e) => useEntitiesStore.getState().upsert(e));
      for (const type of SEED_TYPES) {
        ontology
          .listObjects(type)
          .then((entities) => {
            const { upsert } = useEntitiesStore.getState();
            for (const e of entities) upsert(e);
          })
          .catch(() => {
            // service may be down — the WS feed will fill in once it is up
          });
      }
    }
    return () => {
      offStatus();
      refCount -= 1;
      if (refCount === 0) {
        entityUnsub?.();
        entityUnsub = null;
      }
    };
  }, []);

  return status;
}
