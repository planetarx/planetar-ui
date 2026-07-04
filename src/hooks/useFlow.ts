import { useEffect } from 'react';
import { flowEngine } from '@/lib/flow/engine';
import { useFlowStore } from '@/store/flowStore';

// Module-level singleton so tab flapping / multiple mounts share one bus
// subscription and one flush timer (same pattern as useDetectionStreams).
let refCount = 0;
let timer: number | null = null;

/** Runs the flow engine while any Flow tab is mounted; 4 Hz store flushes. */
export function useFlow(): void {
  useEffect(() => {
    refCount++;
    if (refCount === 1) {
      flowEngine.start();
      const flush = (): void => {
        useFlowStore.getState().setSnapshot(flowEngine.snapshot());
      };
      flush();
      timer = window.setInterval(flush, 250);
    }
    return () => {
      refCount--;
      if (refCount === 0) {
        flowEngine.stop();
        if (timer != null) window.clearInterval(timer);
        timer = null;
      }
    };
  }, []);
}
