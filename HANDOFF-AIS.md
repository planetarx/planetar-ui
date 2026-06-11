# AIS integration — handoff for the UI agent

Written by the `planetar-ais` agent on 2026-05-14. Scope: everything the
UI agent should know about how vessel data gets into planetar-ui, what's
wired correctly, what's wired but quiet by protocol, and what's still
loose.

---

## What planetar-ais publishes

Single Node microservice at `~/github/planetarx/planetar-ais/`. Speaks
length-prefixed zmesg to `127.0.0.1:12001`. Three topics, all
schema-pinned:

| Topic | Schema | Cadence | Payload shape |
|---|---|---|---|
| `vessel.ais.position` | `vessel.ais.Position.v1` | ITU-R rate per vessel (2 s underway → 3 min moored) | `AisPosition` directly (no wrapper). Fields in `src/types/ais.ts`. |
| `vessel.ais.fleet` | `vessel.ais.Fleet.v1` | One per state transition + once per position tick | `{event, mmsi, channelId, channelName, serverId, topic, vessel}`. `event ∈ {appeared, update, static-update, anomaly, lost}`. |
| `chat.pac.vessel-<MMSI>` | `chat.v1.Message` | Throttled — default 10 s summary, faster on speed-change or anomaly | `{text, author}` — `author={id:'agent-ais', name:'ais', role:'agent'}`. Uses `⟦TOKEN⟧` entity syntax for ports/destinations so the existing chat renderer highlights them. |

Source selection: `AIS_SOURCE=aisstream` (real, needs `AISSTREAM_API_KEY`)
vs `AIS_SOURCE=mock` (12 synthetic Victoria vessels, the default if no
env). See `planetar-ais/README.md`.

---

## How it lands in the UI

```
broker ─ vessel.ais.position ─► useAisPositions ─► aisStore.byMmsi (map dots, tracks)
broker ─ vessel.ais.fleet    ─► fleetListener   ─► channelsStore (left-rail Vessels section)
                                              └─► aisStore.markStatus (map status paint)
broker ─ chat.pac.vessel-N   ─► useChannelMessages (per-channel conversation pane)
```

`useAisPositions` is mounted by `MapTab` and ref-counts the broker
subscription, so it survives tab switches without re-subscribing.
`fleetListener` is started once from `main.tsx` via `startFleetListener()`
and never tears down.

**Key contract:** the `vessel.ais.position` payload IS the vessel
snapshot directly — `{mmsi, lat, lon, sog, cog, lastSeenNs, ...}` — no
wrapping envelope. `aisStore.ingestPosition` ingests it as-is. Don't
add a `.vessel` wrapper without coordinating with the producer.

---

## What was bugged and is now fixed

Both fixes are in `src/lib/fleetListener.ts`. Pull a `git diff` of
that file for the literals.

1. **Status forwarding (fleet → aisStore).** The map's circle layer has
   a `match ['get', 'status']` paint expression that maps `live →
   green`, `dark → orange`, `lost → grey`, but nothing was ever calling
   `aisStore.markStatus()`. `fleetListener` now does it on every
   `update` / `anomaly` / `lost` branch, so dots actually change colour
   as the producer transitions a vessel.

2. **Lost-vessel handling.** `fleetListener` calls
   `aisStore.markStatus(mmsi, 'lost')` on `event: 'lost'`. The map dot
   stays at the last-known position, painted grey (`#5a647c`) by the
   circle-color match — for dark-vessel detection work this is exactly
   what the operator wants to see. Channel also greys.
   `aisStore.remove()` is wired but currently unused; reserve it for
   manual clear or for an eventual long-retention sweep.

Comment near the top of `aisStore.ts` claimed `useFleet` forwards
lifecycle events here — that function never existed. The new
`fleetListener` does the same job, and the comment in
`fleetListener.ts` now reflects it.

---

## What still might bite

These aren't blockers; flag in case they show up later.

- **Map re-renders on every position tick.** `MapTab`'s `useEffect`
  depends on the whole `vessels` object; every `ingestPosition` creates
  a new ref, so the GeoJSON source is `setData`'d for *all* vessels on
  every tick of *any* vessel. Fine at O(100) vessels; revisit if you
  scale to hundreds. Cheapest fix is debouncing the `setData` or moving
  to per-vessel feature mutation.

- **Quiet channels are protocol, not bug.** Class A AIS broadcasts every
  **3 minutes** when moored, 2 s when underway. Most of Victoria most
  hours is moored. The `VesselPin` at the top of `Conversation.tsx`
  shows the latest position with a `last AIS · Xm ago` stamp so quiet
  channels still feel alive. If users complain "the channel is dead,"
  point them at the pin's age stamp.

- **Tracked MMSI is hardcoded** in `src/types/ais.ts` —
  `TRACKED_MMSI = new Set([311001249])` (Victoria Clipper V). If you
  want this dynamic, the obvious paths are: an env-driven seed, a
  per-user pin store, or wiring it to the entity-selection model.

- **No upper bound on `aisStore.byMmsi`.** Lost vessels persist on the
  map (deliberately — see "Lost-vessel handling"). The record set only
  grows during a session. For a long-running watch this means hundreds
  of grey ghosts could accumulate after a few hours. If that becomes a
  problem, add a retention sweep that drops records whose `lastSeenMs`
  is older than some configurable horizon (e.g. 4 h), or expose a
  manual "clear lost" action.

---

## The mock-service situation

There are currently **two** `planetar-ais` services running:

| PID | Mode | What it does |
|---|---|---|
| 1203345 | `AIS_SOURCE=aisstream` | Real Victoria vessels via aisstream.io |
| 1293398 | (no env → mock default) | 12 synthetic Victoria-area vessels, advancing every 3 s |

Both publish to the same broker, so the UI receives positions for
~12 mock vessels with MMSIs in the 316/366/477/538 ranges (e.g.
`PACIFIC VOYAGER` 316001234) plus real vessels (e.g. `VICTORIA
CLIPPER V` 311001249, `COHO` 366929710, `CDN WARSHIP 334` 316148000).
The UI can't tell them apart — they look the same on the wire.

User has not yet decided whether to keep this or kill the mock. If/when
asked to distinguish them, the cleanest signal would be a `synthetic:
true` flag on the mock's fleet payload, which the UI can then style
differently (dashed circle, `[demo]` suffix in channel name, etc.).
Coordinate with the AIS agent before implementing — the contract change
is small but should land on both sides.

---

## Files touched (planetar-ui side)

Earlier work — already in place:
- `src/components/Conversation.tsx` — `VesselPin` live status header
- `src/components/ChannelList.tsx` — `vessels` section + status glyphs
- `src/store/channelsStore.ts` — `attachVessel`, `markVesselStatus`
- `src/types.ts` — `ChannelSection` widened, `VesselSummary` added
- `src/App.css` — `.vessel-pin*`, `.channel-dark`, `.channel-lost`

Today's fix:
- `src/lib/fleetListener.ts` — forwards status into `aisStore` so the
  map's color expression paints live/dark/lost correctly. Lost vessels
  stay visible at their last-known position painted grey — the
  dark-vessel demo wants that record, not a disappearance.

---

## Tail-running services to be aware of

| Service | Where | Status |
|---|---|---|
| planetar-broker | `127.0.0.1:12001/12002/12003` + `/tmp/planetar-broker.sock` | ✓ |
| Vite dev server | `127.0.0.1:5180` (planetar-ui) | ✓ |
| planetar-ui bridge | `ws://127.0.0.1:9100` | ✓ |
| planetar-ais (real) | PID 1203345 | ✓ |
| planetar-ais (mock) | PID 1293398 | ✓ (dup; decision pending) |

A handful of other agents also publish — saw `sar.chip`,
`track.update`, `acoustic.detect`, `acoustic.psd` on the bus. Those
are out of scope for this handoff.
