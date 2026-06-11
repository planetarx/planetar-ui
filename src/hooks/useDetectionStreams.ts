// Singleton subscription to the SAR / track / acoustic detection topics.
// Mounted by MapTab; ref-counted so tab switches don't flap the broker subs.

import { useEffect } from 'react';
import { broker } from '@/lib/broker';
import { useDetectionsStore } from '@/store/detectionsStore';
import { DETECTION_TOPICS } from '@/types/detections';
import type { AcousticDetect, SarChip, TrackUpdate } from '@/types/detections';
import type { ZmesgEnvelope } from '@/types/zmesg';

const TOPICS = [
  DETECTION_TOPICS.sarChip,
  DETECTION_TOPICS.trackUpdate,
  DETECTION_TOPICS.acousticDetect,
];

let unsub: (() => void) | null = null;
let refCount = 0;

function handle(env: ZmesgEnvelope) {
  const store = useDetectionsStore.getState();
  switch (env.topic) {
    case DETECTION_TOPICS.sarChip: {
      const p = env.payload as SarChip | undefined;
      if (p && typeof p.lat === 'number' && typeof p.lon === 'number') store.ingestSarChip(p);
      break;
    }
    case DETECTION_TOPICS.trackUpdate: {
      const p = env.payload as TrackUpdate | undefined;
      if (p && typeof p.lat === 'number' && typeof p.lon === 'number' && p.track_id) {
        store.ingestTrackUpdate(p);
      }
      break;
    }
    case DETECTION_TOPICS.acousticDetect: {
      const p = env.payload as AcousticDetect | undefined;
      if (p && typeof p.lat === 'number' && typeof p.lon === 'number' && p.site_code) {
        store.ingestAcousticDetect(p);
      }
      break;
    }
  }
}

export function useDetectionStreams(): void {
  useEffect(() => {
    refCount += 1;
    if (refCount === 1) {
      unsub = broker.onEnvelope(handle);
      for (const t of TOPICS) broker.subscribe(t);
    }
    return () => {
      refCount -= 1;
      if (refCount === 0) {
        unsub?.();
        unsub = null;
        for (const t of TOPICS) broker.unsubscribe(t);
      }
    };
  }, []);
}
