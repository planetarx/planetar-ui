/*
 * Flow renderer — the canvas layer of the Flow tab: edges, glows, and one
 * particle per real envelope (ARCH-planetar-flow-trace.md §5.2–5.3, §7).
 *
 * The canvas sits above the DOM node cards with pointer-events:none; clicks
 * land on the stage and are resolved against live particles via hitTest().
 * A message's journey is three chained segments — producer→lane (550 ms),
 * across the lane (400 ms), lane→sinks (450 ms) — matching the real path:
 * ingress, WAL+fan-out inside the broker, delivery. Past the live-particle
 * cap the renderer degrades honestly: the lane pulses brighter and the
 * coalesced counter ticks up instead of silently dropping.
 */

import type { EdgeSnap, Modality, Spawn } from './engine';
import { MODALITY_COLORS, flowEngine } from './engine';
import type { FlowLayout, PathSeg } from './layout';
import { line, pointOn, rectLeftCenter, rectRightCenter, sCurve, tracePath } from './layout';

const PARTICLE_CAP = 150;
const STAGE_MS = { ingress: 550, lane: 400, fanout: 450 } as const;
const EDGE_FADE_MS = 4000;

interface Particle {
  envId: string | null; // null → entity pulse (not hit-testable to a trace)
  color: string;
  seg: PathSeg;
  t0: number;
  dur: number;
  next: ((p: Particle, now: number) => Particle[]) | null;
}

export interface Highlight {
  ids: Set<string>; // envelope ids on the selected trace
  producers: Set<string>;
  lanes: Set<string>;
}

const easeInOut = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - (1 - t) * (1 - t) * 2);

export class FlowRenderer {
  #ctx: CanvasRenderingContext2D;
  #layout: FlowLayout | null = null;
  #edges: EdgeSnap[] = [];
  #particles: Particle[] = [];
  #lanePulse = new Map<string, number>();
  #highlight: Highlight | null = null;
  #raf = 0;
  #running = false;
  #shellRate = 0;

  constructor(canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('flow: no 2d context');
    this.#ctx = ctx;
  }

  setLayout(l: FlowLayout): void {
    this.#layout = l;
  }

  setEdges(edges: EdgeSnap[], shellRate: number): void {
    this.#edges = edges;
    this.#shellRate = shellRate;
  }

  setHighlight(h: Highlight | null): void {
    this.#highlight = h;
  }

  liveParticles(): number {
    return this.#particles.length;
  }

  spawn(s: Spawn): void {
    const l = this.#layout;
    if (!l) return;
    const now = performance.now();

    if (s.kind === 'entity') {
      const onto = l.consumers.get('ontology')!;
      const from = rectRightCenter(l.bus);
      const to = rectLeftCenter(onto);
      this.#particles.push({
        envId: null,
        color: MODALITY_COLORS.entity,
        seg: sCurve(from.x, from.y, to.x - 4, to.y),
        t0: now,
        dur: STAGE_MS.fanout,
        next: null,
      });
      return;
    }

    const laneRect = l.lanes.get(s.lane) ?? l.laneOverflow?.rect;
    if (!laneRect) return;
    if (this.#particles.length >= PARTICLE_CAP) {
      this.#lanePulse.set(s.lane, Math.min(1, (this.#lanePulse.get(s.lane) ?? 0) + 0.25));
      flowEngine.noteCoalesced();
      return;
    }

    const fromRect = l.producers.get(s.producer) ?? l.producerOverflow?.rect;
    const from = fromRect ? rectRightCenter(fromRect) : { x: l.bus.x - 40, y: l.bus.y + l.bus.h / 2 };
    const laneIn = { x: laneRect.x + 4, y: laneRect.y + laneRect.h / 2 };
    const laneOut = { x: laneRect.x + laneRect.w - 4, y: laneRect.y + laneRect.h / 2 };
    const color = MODALITY_COLORS[s.modality];

    const fanout = (_p: Particle, at: number): Particle[] => {
      const out: Particle[] = [];
      for (const key of ['shell', 'wal'] as const) {
        const sink = l.consumers.get(key);
        if (!sink) continue;
        const to = rectLeftCenter(sink);
        out.push({
          envId: s.id,
          color,
          seg: sCurve(laneOut.x, laneOut.y, to.x - 4, to.y),
          t0: at,
          dur: STAGE_MS.fanout,
          next: null,
        });
      }
      return out;
    };

    const acrossLane = (_p: Particle, at: number): Particle[] => [
      {
        envId: s.id,
        color,
        seg: line(laneIn.x, laneIn.y, laneOut.x, laneOut.y),
        t0: at,
        dur: STAGE_MS.lane,
        next: fanout,
      },
    ];

    this.#particles.push({
      envId: s.id,
      color,
      seg: sCurve(from.x, from.y, laneIn.x, laneIn.y),
      t0: now,
      dur: STAGE_MS.ingress,
      next: acrossLane,
    });
  }

  /** Nearest live particle within 10 px, for stage clicks → trace selection. */
  hitTest(x: number, y: number): string | null {
    const now = performance.now();
    let best: string | null = null;
    let bestD = 10;
    for (const p of this.#particles) {
      if (!p.envId) continue;
      const t = easeInOut(Math.min(1, (now - p.t0) / p.dur));
      const pos = pointOn(p.seg, t);
      const d = Math.hypot(pos.x - x, pos.y - y);
      if (d < bestD) {
        bestD = d;
        best = p.envId;
      }
    }
    return best;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    const loop = (): void => {
      if (!this.#running) return;
      this.#draw();
      this.#raf = requestAnimationFrame(loop);
    };
    this.#raf = requestAnimationFrame(loop);
  }

  stop(): void {
    this.#running = false;
    cancelAnimationFrame(this.#raf);
    this.#particles = [];
  }

  resize(w: number, h: number, dpr: number): void {
    const canvas = this.#ctx.canvas;
    canvas.width = Math.max(1, Math.floor(w * dpr));
    canvas.height = Math.max(1, Math.floor(h * dpr));
    this.#ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  #dimmed(involved: boolean): number {
    if (!this.#highlight) return 1;
    return involved ? 1 : 0.13;
  }

  #draw(): void {
    const ctx = this.#ctx;
    const l = this.#layout;
    const now = performance.now();
    const wallNow = Date.now();
    ctx.clearRect(0, 0, l?.width ?? ctx.canvas.width, l?.height ?? ctx.canvas.height);
    if (!l) return;

    // ingress edges — alpha tracks recency so quiet routes recede
    for (const e of this.#edges) {
      const laneRect = l.lanes.get(e.lane) ?? l.laneOverflow?.rect;
      const prodRect = l.producers.get(e.producer) ?? l.producerOverflow?.rect;
      if (!laneRect || !prodRect) continue;
      const from = rectRightCenter(prodRect);
      const to = { x: laneRect.x + 4, y: laneRect.y + laneRect.h / 2 };
      const recency = Math.exp(-(wallNow - e.lastMs) / EDGE_FADE_MS);
      const involved =
        !this.#highlight || (this.#highlight.producers.has(e.producer) && this.#highlight.lanes.has(e.lane));
      ctx.globalAlpha = (0.1 + 0.45 * recency) * this.#dimmed(involved);
      ctx.strokeStyle = MODALITY_COLORS[e.modality as Modality] ?? MODALITY_COLORS.other;
      ctx.lineWidth = involved && this.#highlight ? 2 : 1.25;
      ctx.beginPath();
      tracePath(ctx, sCurve(from.x, from.y, to.x, to.y));
      ctx.stroke();
    }

    // egress trunks — bus to each sink; WAL glow tracks total ingress rate
    const busOut = rectRightCenter(l.bus);
    for (const key of ['shell', 'ontology', 'wal'] as const) {
      const sink = l.consumers.get(key);
      if (!sink) continue;
      const to = rectLeftCenter(sink);
      const rate = key === 'ontology' ? 0 : this.#shellRate;
      ctx.globalAlpha = (0.12 + Math.min(0.4, rate * 0.06)) * this.#dimmed(!this.#highlight);
      ctx.strokeStyle = '#2d3a55';
      ctx.lineWidth = 1.5;
      if (key === 'ontology') ctx.setLineDash([4, 4]); // subscription, evidenced by entity pulses
      ctx.beginPath();
      tracePath(ctx, sCurve(busOut.x, busOut.y, to.x - 4, to.y));
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // burst pulses — lanes glowing past the particle cap
    for (const [lane, pulse] of this.#lanePulse) {
      const r = l.lanes.get(lane) ?? l.laneOverflow?.rect;
      if (!r || pulse <= 0.01) {
        this.#lanePulse.delete(lane);
        continue;
      }
      ctx.globalAlpha = 0.25 * pulse;
      ctx.fillStyle = MODALITY_COLORS[modalityOfLanePulse(this.#edges, lane)];
      ctx.fillRect(r.x, r.y, r.w, r.h);
      this.#lanePulse.set(lane, pulse * 0.92);
    }

    // particles + tails
    const survivors: Particle[] = [];
    const spawned: Particle[] = [];
    for (const p of this.#particles) {
      const raw = (now - p.t0) / p.dur;
      if (raw >= 1) {
        if (p.next) spawned.push(...p.next(p, now));
        continue;
      }
      const involved = !this.#highlight || (p.envId !== null && this.#highlight.ids.has(p.envId));
      const alpha = this.#dimmed(involved);
      const t = easeInOut(raw);
      const pos = pointOn(p.seg, t);
      ctx.strokeStyle = p.color;
      ctx.lineWidth = 2;
      for (let i = 1; i <= 4; i++) {
        const tt = Math.max(0, t - i * 0.02);
        const tail = pointOn(p.seg, tt);
        ctx.globalAlpha = alpha * 0.5 * (1 - i / 5);
        ctx.beginPath();
        ctx.moveTo(pos.x, pos.y);
        ctx.lineTo(tail.x, tail.y);
        ctx.stroke();
      }
      ctx.globalAlpha = alpha;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, involved && this.#highlight ? 3.5 : 2.5, 0, Math.PI * 2);
      ctx.fill();
      survivors.push(p);
    }
    this.#particles = survivors.concat(spawned);
    ctx.globalAlpha = 1;
  }
}

function modalityOfLanePulse(edges: EdgeSnap[], lane: string): Modality {
  const e = edges.find((x) => x.lane === lane);
  return (e?.modality as Modality) ?? 'other';
}
