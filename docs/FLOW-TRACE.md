# Flow tab — live data-flow graph & message trace

Design doc: `~/data/vaults/docs/ARCH-planetar-flow-trace.md` (the SSOT — read it
before changing behavior). This file is the repo-local quick reference.

## What it is

The **Flow** tab renders the bus as a live pipeline graph: producers →
planetar-broker (topic-family lanes) → sinks. The topology is **derived from
observed traffic** — nothing is configured; a service appears because its
envelopes do. Every particle on the canvas is one real message. Clicking a
particle or a ticker row opens the **trace panel**: per-hop nanosecond timings
(created → stored → published → received), the causal chain via
`causationId`, correlated siblings via `correlationId`, and the entity fields
the message set in planetar-ontology.

## Pieces

| File | Role |
|---|---|
| `src/lib/flow/engine.ts` | Non-reactive core: `**` subscription, ring buffer (3000) indexed by id/causation/correlation, topology stats, spawn events. Module singleton. |
| `src/lib/flow/layout.ts` | Pure geometry: three-column layout, bezier paths. Adapts column widths down to ~440 px panes. |
| `src/lib/flow/renderer.ts` | Canvas layer: edges, glows, particles (cap 150, honest coalescing), hit-testing, trace highlight. |
| `src/lib/flow/trace.ts` | Merges the ring buffer with `GET :4000/trace/:id` into one causal picture. |
| `src/store/flowStore.ts` | zustand: 4 Hz snapshots + selection. |
| `src/hooks/useFlow.ts` | Ref-counted engine lifecycle. |
| `src/components/tabs/FlowTab.tsx` | The view: node cards, bus, ticker, HUD, panels. |
| `src/components/flow/TracePanel.tsx` | Hop timeline + lineage + entity linkage. |

## Bridge contract

The bridge (`bridge/server.mjs`) accepts **pattern subscriptions** on the WS
side: `*` = one dot-segment, trailing `**` = the rest (`**` alone = everything).
The Flow tab subscribes `['**']`. `topicMatches` is duplicated in
`src/lib/topic.ts` — keep the two in sync. Mock-mode synthetic chatter ignores
pattern topics.

## Modality palette

Validated categorical palette (dataviz six-checks, dark surface `#0b101c`):
AIS `#3987e5` · acoustic `#199e70` · SAR/track `#c98500` · entity `#008300` ·
EO `#9085e9` · chat `#d55181` · other `#d95926`. Identity is never color-alone
(labels everywhere); `--accent-hot` red stays reserved for alerts.

## Tests

`tests/flow.spec.ts` — publishes a causation chain through the bridge WS and
asserts topology derivation + trace walking. Observability is via `data-*`
attributes on `.flow-tab` (`data-msg-total`, `data-lane-count`,
`data-selected-trace`, …). Works with or without a live broker.
