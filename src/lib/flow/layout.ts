/*
 * Flow layout — pure geometry for the Flow tab (ARCH-planetar-flow-trace.md §5.3).
 *
 * Deterministic three-column composition: producers | the bus (a container of
 * topic-family lane rows) | consumers. No physics — the star-through-bus shape
 * IS the architecture, so the layout states it. Shared by the DOM node layer
 * and the canvas renderer so edges, particles, and cards agree on coordinates.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type ConsumerKey = 'shell' | 'ontology' | 'wal';

export interface FlowLayout {
  width: number;
  height: number;
  producers: Map<string, Rect>;
  /** "· n more sources" card when producers overflow the column. */
  producerOverflow: { rect: Rect; keys: string[] } | null;
  bus: Rect;
  lanes: Map<string, Rect>;
  laneOverflow: { rect: Rect; keys: string[] } | null;
  consumers: Map<ConsumerKey, Rect>;
}

const M = 14; // stage margin
const PROD_W = 168;
const PROD_H = 50;
const PROD_GAP = 8;
const CONS_W = 188;
const CONS_H = 62;
const BUS_HEADER = 30;
const BUS_PAD = 10;
const LANE_H = 40;
const LANE_GAP = 6;
const OVERFLOW_H = 26;

export function computeLayout(
  width: number,
  height: number,
  producerKeys: string[],
  laneKeys: string[],
): FlowLayout {
  const availH = Math.max(120, height - 2 * M);
  // The data pane is often ~440 px wide — columns shrink before they overlap.
  const prodW = Math.round(Math.min(PROD_W, Math.max(104, width * 0.22)));
  const consW = Math.round(Math.min(CONS_W, Math.max(116, width * 0.24)));
  const gutter = Math.round(Math.min(64, Math.max(18, width * 0.05)));

  const maxProducers = Math.max(1, Math.floor((availH - OVERFLOW_H) / (PROD_H + PROD_GAP)));
  const shownProducers = producerKeys.length > maxProducers
    ? producerKeys.slice(0, maxProducers)
    : producerKeys;
  const producerRest = producerKeys.slice(shownProducers.length);

  const producers = new Map<string, Rect>();
  shownProducers.forEach((key, i) => {
    producers.set(key, { x: M, y: M + i * (PROD_H + PROD_GAP), w: prodW, h: PROD_H });
  });
  const producerOverflow = producerRest.length
    ? {
        keys: producerRest,
        rect: { x: M, y: M + shownProducers.length * (PROD_H + PROD_GAP), w: prodW, h: OVERFLOW_H },
      }
    : null;

  const busX = M + prodW + gutter;
  const busRight = width - M - consW - gutter;
  const bus: Rect = { x: busX, y: M, w: Math.max(96, busRight - busX), h: availH };

  const laneArea = bus.h - BUS_HEADER - 2 * BUS_PAD;
  const maxLanes = Math.max(1, Math.floor((laneArea - OVERFLOW_H) / (LANE_H + LANE_GAP)));
  const shownLanes = laneKeys.length > maxLanes ? laneKeys.slice(0, maxLanes) : laneKeys;
  const laneRest = laneKeys.slice(shownLanes.length);

  const lanes = new Map<string, Rect>();
  shownLanes.forEach((key, i) => {
    lanes.set(key, {
      x: bus.x + BUS_PAD,
      y: bus.y + BUS_HEADER + BUS_PAD + i * (LANE_H + LANE_GAP),
      w: bus.w - 2 * BUS_PAD,
      h: LANE_H,
    });
  });
  const laneOverflow = laneRest.length
    ? {
        keys: laneRest,
        rect: {
          x: bus.x + BUS_PAD,
          y: bus.y + BUS_HEADER + BUS_PAD + shownLanes.length * (LANE_H + LANE_GAP),
          w: bus.w - 2 * BUS_PAD,
          h: OVERFLOW_H,
        },
      }
    : null;

  // Three sinks, evenly spread over the column height.
  const consumers = new Map<ConsumerKey, Rect>();
  const keys: ConsumerKey[] = ['shell', 'ontology', 'wal'];
  const span = availH - CONS_H;
  keys.forEach((key, i) => {
    consumers.set(key, {
      x: width - M - consW,
      y: M + Math.floor((span * i) / (keys.length - 1)),
      w: consW,
      h: CONS_H,
    });
  });

  return { width, height, producers, producerOverflow, bus, lanes, laneOverflow, consumers };
}

export const rectRightCenter = (r: Rect): { x: number; y: number } => ({ x: r.x + r.w, y: r.y + r.h / 2 });
export const rectLeftCenter = (r: Rect): { x: number; y: number } => ({ x: r.x, y: r.y + r.h / 2 });

export interface CubicSeg {
  kind: 'cubic';
  x0: number; y0: number;
  cx1: number; cy1: number;
  cx2: number; cy2: number;
  x1: number; y1: number;
}
export interface LineSeg {
  kind: 'line';
  x0: number; y0: number;
  x1: number; y1: number;
}
export type PathSeg = CubicSeg | LineSeg;

/** Horizontal S-curve between two points — the house edge shape. */
export function sCurve(x0: number, y0: number, x1: number, y1: number): CubicSeg {
  const dx = Math.max(24, (x1 - x0) * 0.45);
  return { kind: 'cubic', x0, y0, cx1: x0 + dx, cy1: y0, cx2: x1 - dx, cy2: y1, x1, y1 };
}

export function line(x0: number, y0: number, x1: number, y1: number): LineSeg {
  return { kind: 'line', x0, y0, x1, y1 };
}

export function pointOn(seg: PathSeg, t: number): { x: number; y: number } {
  if (seg.kind === 'line') {
    return { x: seg.x0 + (seg.x1 - seg.x0) * t, y: seg.y0 + (seg.y1 - seg.y0) * t };
  }
  const u = 1 - t;
  const x =
    u * u * u * seg.x0 + 3 * u * u * t * seg.cx1 + 3 * u * t * t * seg.cx2 + t * t * t * seg.x1;
  const y =
    u * u * u * seg.y0 + 3 * u * u * t * seg.cy1 + 3 * u * t * t * seg.cy2 + t * t * t * seg.y1;
  return { x, y };
}

export function tracePath(ctx: CanvasRenderingContext2D, seg: PathSeg): void {
  ctx.moveTo(seg.x0, seg.y0);
  if (seg.kind === 'line') ctx.lineTo(seg.x1, seg.y1);
  else ctx.bezierCurveTo(seg.cx1, seg.cy1, seg.cx2, seg.cy2, seg.x1, seg.y1);
}
