# AIS Integration Contract

This is the **consumer-side contract** describing what the planetar-ui Map
foundation expects from any AIS data producer (currently `planetar-ais`).
The producer publishes zmesg envelopes onto the planetar-broker; the UI
subscribes to specific topics and renders the data on the Map tab. If a
producer follows this contract, vessels will appear on the map and in the
sidebar's `#vessels` section without any UI changes.

This document is the single source of truth for that contract. If you change
something here, the UI and the AIS agent must move together.

---

## Topology

```
   ┌────────────────┐    TCP 12001    ┌───────────────────┐    TCP 12002    ┌───────────┐    WS 9100    ┌────────────┐
   │  planetar-ais  │ ──── PUB ─────▶ │  planetar-broker  │ ──── SUB ─────▶ │  bridge   │ ───── WS ───▶ │ planetar-ui│
   └────────────────┘                 │  (12001/2/3 + SHM)│                 │ (WS↔TCP)  │               │  Map tab   │
                                      └───────────────────┘                 └───────────┘               └────────────┘
```

The bridge already subscribes to the broker with `SUB **` and forwards every
envelope to any WS client subscribed to the matching exact topic. **The
broker supports wildcard subscriptions; the WS bridge does not** — UI clients
subscribe to specific topic strings, listed below.

---

## Topics

### `vessel.ais.position` (schema `vessel.ais.Position.v1`) — high-frequency

The map's primary data stream. One envelope per vessel position update; payload
is the **vessel snapshot directly** (no wrapping object). The producer SHOULD
emit a position envelope every 1–30 seconds per active vessel; the map can
absorb up to a few thousand envelopes per second.

```ts
interface AisPosition {
  mmsi: number;              // required, AIS MMSI 9-digit identifier
  name?: string;             // human-readable name; falls back to "MMSI <n>"
  type?: string;             // ship type ("Cargo", "Tanker", "Fishing", …)
  flag?: string | null;      // ISO 3166-1 alpha-2 or country name
  length?: number;           // overall length in metres
  callsign?: string;
  lat: number;               // required, WGS-84 decimal degrees
  lon: number;               // required, WGS-84 decimal degrees
  sog: number;               // required, speed over ground in knots
  cog: number;               // required, course over ground in degrees true
  heading?: number;          // gyrocompass heading; often equals cog for slow vessels
  destination?: string | null;
  lastSeenNs: string;        // required, BigInt-as-string (JSON can't carry ns precision)
  firstSeenNs?: string;      // optional, BigInt-as-string
  inBBox?: boolean;          // producer-side AOI flag; UI uses for "left BBox" handling later
}
```

**UI behaviour:**
- Every envelope appends a `TrackPoint` to that MMSI's polyline (ring buffer, last 256 points).
- The map symbol layer redraws with the latest position.
- If the MMSI is in `TRACKED_MMSI` (currently `{ 311001249 }`), the camera flies to it the first time it appears.

### `vessel.ais.fleet` (schema `vessel.ais.Fleet.v1`) — control plane

Sidebar bookkeeping. The map foundation listens to `'appeared'` and `'lost'`
events to add/remove vessels from the map even before the first position
arrives.

```ts
interface AisFleetEvent {
  event: 'appeared' | 'update' | 'static-update' | 'anomaly' | 'lost';
  mmsi: number;
  channelId: string;         // e.g. "pac-v-311001249" — used by ChannelList
  channelName: string;       // e.g. "vessel-311001249"
  serverId: string;          // e.g. "pac"
  topic: string;             // the chat topic for this vessel (chat.pac.vessel-<MMSI>)
  vessel: Partial<AisPosition> & { mmsi: number };
}
```

The control plane is **already wired** in `src/lib/fleetListener.ts`. New
vessels show up in the sidebar's `#vessels` section without any per-MMSI
configuration.

### `chat.pac.vessel-<MMSI>` (schema `chat.v1.Message`) — per-vessel narrative

Slack-style narrative channel for each tracked vessel. Producer-side
summaries: first AIS contact, AIS gap, speed change, destination set, etc.
Same `ChatPayload` schema as user-typed messages — `{ text, author: { id,
name, role } }`. Already rendered by the existing `Conversation` component.

---

## What the map renders

| Layer | Source | Style |
|---|---|---|
| `osm` | Public OpenStreetMap raster tiles | Slightly desaturated to fit the dark theme. |
| `vessel-dots` | `aisStore.byMmsi` filtered to non-tracked | Circle, color by status (live=green, dark=amber, lost=grey). |
| `vessel-tracked` | `aisStore.byMmsi` filtered to TRACKED_MMSI | Larger circle, red with white border. |
| `track-line` | Selected vessel's `track[]` polyline | Cyan, 2px. |

Click semantics:
- Click a vessel → `setSelectedEntity('MMSI <mmsi>')` → Inspector populates, track polyline appears.
- Click a `#vessels` channel in the sidebar → that vessel becomes selected on the map (camera follows).
- Click an entity token in chat that looks like `⟦MMSI 311001249⟧` → same as clicking the pin.

---

## Sequence of operations (per vessel)

1. Producer detects a new MMSI in its source feed.
2. Producer publishes `vessel.ais.fleet` with `event: 'appeared'` — UI sidebar gets a new `#vessels/vessel-<MMSI>` channel.
3. Producer publishes the first `vessel.ais.position` envelope — UI map gets the marker; aisStore creates the record.
4. Producer continues publishing `vessel.ais.position` every 1–30 seconds per vessel.
5. If a vessel hasn't been seen for a producer-defined timeout, the producer publishes `vessel.ais.fleet` with `event: 'lost'` — UI marks the channel and the marker as `lost` (grey).
6. Optionally, the producer publishes `vessel.ais.fleet` with `event: 'anomaly'` when something noteworthy happens (AIS gap, speed change, etc.) and a narrative `chat.pac.vessel-<MMSI>` envelope describing it.

---

## Tracked vessels

Some MMSIs get distinct map styling and behaviour. The list is in
`src/types/ais.ts`:

```ts
export const TRACKED_MMSI: ReadonlySet<number> = new Set<number>([
  311001249, // user-tracked vessel
]);
```

A tracked vessel is rendered with a larger red marker, the camera flies to it
on first sighting, and the legend includes its MMSI as a pill (greyed out
until the producer has reported a position for it).

To add a tracked MMSI, edit this set. If the producer's source feed reaches
that MMSI, the map handles the rest.

---

## Testing without real AIS

`planetar-ais` ships a `MockAisSource` that spawns 12 synthetic vessels in
the Victoria BBox (48.20°N – 48.65°N, 123.05°W – 123.70°W) and emits
`vessel.ais.position` envelopes at the same cadence the real source would.
This is the default; set `AIS_SOURCE=aisstream` and provide
`AISSTREAM_API_KEY` to switch to live data.

**If MMSI 311001249 needs to appear in mock mode**, add it to `MockAisSource`'s
seed list (around line 7 of `planetar-ais/src/source-mock.mjs`) with realistic
lat/lon inside the Victoria BBox.

---

## Things the UI does NOT do (yet)

These are deliberate omissions — add them as separate features, not by
extending the existing contract:

- **Vessel clustering** at low zoom. Symbol layer is naïve and starts to feel
  busy past ~500 vessels.
- **Direction indicators.** `cog`/`heading` are stored but not rendered as
  arrows. A symbol layer with a chevron sprite would fix this; needs a
  custom sprite atlas.
- **Detection / SAR / EO overlays.** The Map tab is wired for one source
  (`vessels`) only; adding `det.*` or `sar.*` layers is a follow-up that
  extends the source registry in `MapTab.tsx`.
- **Historical replay.** The map shows live state only. Replay would require
  a separate consumer that reads from the broker WAL.

---

## Files in this contract

| Side | File | Role |
|---|---|---|
| UI | `src/types/ais.ts` | TypeScript types + `TRACKED_MMSI` set. |
| UI | `src/store/aisStore.ts` | Zustand store keyed by MMSI; tracks latest + last-256 points. |
| UI | `src/hooks/useAisPositions.ts` | Singleton subscription to `vessel.ais.position`. |
| UI | `src/components/tabs/MapTab.tsx` | MapLibre canvas + layers. |
| UI | `src/components/Inspector.tsx` | Resolves selected MMSI to a vessel record. |
| UI | `src/lib/fleetListener.ts` | Already-wired control-plane handler. |
| AIS | `planetar-ais/src/index.mjs` | Publishes the three topics above. |
| AIS | `planetar-ais/src/source-mock.mjs` | 12-vessel synthetic generator. |
| AIS | `planetar-ais/src/source-aisstream.mjs` | Live AISStream.io adapter. |
| AIS | `planetar-ais/src/publisher.mjs` | TCP publisher to broker:12001. |

---

## Change protocol

- **Adding optional fields to an existing payload**: backward compatible. Producer can ship; UI ignores until rendered.
- **Adding required fields, renaming, or changing types**: bump the schema version (`vessel.ais.Position.v1` → `…v2`), publish BOTH versions during transition, then retire v1 here and on the producer.
- **New topic family** (e.g., `sar.detection`): treat as a new contract, not an extension. Add a new section above with the schema and the UI's rendering behaviour.

Any change here should be matched by edits in `planetar-ais` and verified by
the Playwright smoke test in `tests/smoke.spec.ts`.
