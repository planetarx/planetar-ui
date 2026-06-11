// One singleton subscription to `vessel.ais.position`. Mount once near the
// app root (or lazily inside MapTab); it ref-counts the broker subscription
// so unmount/remount cycles do not flap the WS sub list.

import { useEffect } from 'react';
import { broker } from '@/lib/broker';
import { useAisStore } from '@/store/aisStore';
import type { AisPosition } from '@/types/ais';
import type { ZmesgEnvelope } from '@/types/zmesg';

const POSITION_TOPIC = 'vessel.ais.position';
const POSITION_SCHEMA = 'vessel.ais.Position.v1';

let envelopeUnsub: (() => void) | null = null;
let refCount = 0;

function handleEnvelope(env: ZmesgEnvelope) {
  if (env.topic !== POSITION_TOPIC) return;
  if (env.schemaName !== POSITION_SCHEMA) return;
  const p = env.payload as AisPosition | undefined;
  if (!p || typeof p.mmsi !== 'number' || typeof p.lat !== 'number' || typeof p.lon !== 'number') return;
  useAisStore.getState().ingestPosition(p);
}

export function useAisPositions(): void {
  useEffect(() => {
    refCount += 1;
    if (refCount === 1) {
      envelopeUnsub = broker.onEnvelope(handleEnvelope);
      broker.subscribe(POSITION_TOPIC);
    }
    return () => {
      refCount -= 1;
      if (refCount === 0) {
        envelopeUnsub?.();
        envelopeUnsub = null;
        broker.unsubscribe(POSITION_TOPIC);
      }
    };
  }, []);
}
