// Map tab — MapLibre GL canvas backed by aisStore. Vessels render as a
// circle layer driven by a GeoJSON source that is re-set on every store
// change (cheap for O(100) vessels; revisit when we need O(10k)).
//
// Selection sync is bidirectional with the rest of the app:
//   click on a vessel  → setSelectedEntity(`MMSI ${mmsi}`)
//   selectedEntityId   → camera pans to that vessel, track polyline shown
//   current channel    → if its `vessel` is set, the same selection applies
//
// Tracked vessels (see @/types/ais TRACKED_MMSI) render with a distinct
// "tracked" style and the map flies to them on first sighting.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import maplibregl, { type Map as MapLibreMap, type MapMouseEvent } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useAisPositions } from '@/hooks/useAisPositions';
import { useDetectionStreams } from '@/hooks/useDetectionStreams';
import { parseMmsi, useAisStore } from '@/store/aisStore';
import { useChannelsStore } from '@/store/channelsStore';
import { useDetectionsStore } from '@/store/detectionsStore';
import { useLayoutStore } from '@/store/layoutStore';
import { isTracked } from '@/types/ais';
import type { VesselRecord } from '@/store/aisStore';
import type { AcousticSiteRecord, TrackRecord } from '@/store/detectionsStore';
import type { SarChip } from '@/types/detections';

// Fallback map home if the selected Operation carries no `center` — the
// Victoria BBox. Operations that set `server.center` (Pacific Patrol, Strait
// of Hormuz) override this on mount and on Operation switch.
const INITIAL_CENTER: [number, number] = [-123.38, 48.42];
const INITIAL_ZOOM = 10;

const VESSEL_SOURCE = 'vessels';
const VESSEL_LAYER = 'vessel-dots';
const VESSEL_TRACKED_LAYER = 'vessel-tracked';
const TRACK_SOURCE = 'track';
const TRACK_LAYER = 'track-line';

// Detection layers
const SAR_SOURCE = 'sar-chips';
const SAR_LAYER = 'sar-chip-dots';
const DTRACK_SOURCE = 'det-tracks';
const DTRACK_LINE_LAYER = 'det-track-lines';
const DTRACK_HEAD_LAYER = 'det-track-heads';
const ACOUSTIC_SOURCE = 'acoustic-sites';
const ACOUSTIC_LAYER = 'acoustic-site-dots';

type LayerKey = 'vessels' | 'sar' | 'tracks' | 'acoustic';

interface LayerDef {
  key: LayerKey;
  label: string;
  /** MapLibre layer ids this toggle controls */
  ids: string[];
  swatch: string;
}

const LAYER_DEFS: LayerDef[] = [
  { key: 'vessels', label: 'Vessels (AIS)', ids: [VESSEL_LAYER, VESSEL_TRACKED_LAYER, TRACK_LAYER], swatch: '#4ade80' },
  { key: 'sar', label: 'SAR detections', ids: [SAR_LAYER], swatch: '#c084fc' },
  { key: 'tracks', label: 'SAR tracks', ids: [DTRACK_LINE_LAYER, DTRACK_HEAD_LAYER], swatch: '#ffb24a' },
  { key: 'acoustic', label: 'Hydrophones', ids: [ACOUSTIC_LAYER], swatch: '#6fb6ff' },
];

// Esri "World Dark Gray" canvas basemap — a dark raster basemap with a
// separate label overlay. No API key. (CARTO's dark_all raster, used until
// 2026-10, now returns an "API KEY REQUIRED" placeholder tile with HTTP 200.)
// Esri tile paths are {z}/{y}/{x}, not {z}/{x}/{y}.
const ESRI_CANVAS = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas';
const MAP_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    basemap: {
      type: 'raster',
      tiles: [`${ESRI_CANVAS}/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`],
      tileSize: 256,
      attribution: 'Esri, HERE, Garmin, © OpenStreetMap contributors',
      maxzoom: 16,
    },
    labels: {
      type: 'raster',
      tiles: [`${ESRI_CANVAS}/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}`],
      tileSize: 256,
      maxzoom: 16,
    },
  },
  layers: [
    {
      id: 'basemap',
      type: 'raster',
      source: 'basemap',
      paint: {
        // The basemap is already dark; nudge contrast so the deep-navy app
        // background and the vessel dots both read cleanly on top.
        'raster-brightness-max': 0.92,
        'raster-contrast': 0.05,
      },
    },
    { id: 'basemap-labels', type: 'raster', source: 'labels' },
  ],
};

function vesselsToFeatureCollection(records: VesselRecord[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: records.map((r) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [r.latest.lon, r.latest.lat] },
      properties: {
        mmsi: r.mmsi,
        name: r.latest.name ?? `MMSI ${r.mmsi}`,
        sog: r.latest.sog ?? 0,
        cog: r.latest.cog ?? 0,
        status: r.status,
        tracked: isTracked(r.mmsi),
      },
    })),
  };
}

function trackToFeature(record: VesselRecord | undefined): GeoJSON.FeatureCollection {
  if (!record || record.track.length < 2) {
    return { type: 'FeatureCollection', features: [] };
  }
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: record.track.map((p) => [p.lon, p.lat]),
        },
        properties: { mmsi: record.mmsi },
      },
    ],
  };
}

function sarChipsToFC(chips: SarChip[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: chips.map((c, i) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [c.lon, c.lat] },
      properties: { kind: 'sar', idx: i, scene_id: c.scene_id, snr: c.snr },
    })),
  };
}

function tracksToLineFC(tracks: TrackRecord[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: tracks
      .filter((t) => t.points.length >= 2)
      .map((t) => ({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: t.points.map((p) => [p.lon, p.lat]) },
        properties: { track_id: t.track_id },
      })),
  };
}

function tracksToHeadFC(tracks: TrackRecord[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: tracks.map((t) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [t.latest.lon, t.latest.lat] },
      properties: {
        kind: 'track',
        track_id: t.track_id,
        speed_kn: t.latest.speed_kn,
        course_deg: t.latest.course_deg,
        n_hits: t.latest.n_hits,
      },
    })),
  };
}

function acousticSitesToFC(sites: AcousticSiteRecord[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: sites.map((s) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
      properties: {
        kind: 'acoustic',
        site_code: s.site_code,
        site_name: s.site_name,
        detections: s.detections,
        clips: s.clips,
        active: s.latest.detected,
      },
    })),
  };
}

function escapeHtml(s: unknown): string {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c,
  );
}

/** Build the inner HTML for a detection popup from a clicked feature's props. */
function detectionPopupHtml(p: Record<string, unknown>): string {
  const row = (k: string, v: unknown) =>
    `<div class="mp-row"><span class="mp-k">${k}</span><span class="mp-v">${escapeHtml(v)}</span></div>`;
  const isActive = p.active === true || p.active === 'true';
  if (p.kind === 'sar') {
    const snr = typeof p.snr === 'number' ? p.snr.toFixed(1) : p.snr;
    return `<div class="mp-title">SAR detection</div>${row('scene', p.scene_id)}${row('SNR', snr)}`;
  }
  if (p.kind === 'track') {
    return (
      `<div class="mp-title">SAR track</div>` +
      row('track', p.track_id) +
      row('speed', `${p.speed_kn} kn`) +
      row('course', `${Math.round(Number(p.course_deg))}°`) +
      row('hits', p.n_hits)
    );
  }
  if (p.kind === 'acoustic') {
    return (
      `<div class="mp-title">Hydrophone · ${escapeHtml(p.site_name)}</div>` +
      row('site', p.site_code) +
      row('clips', `${p.detections} det / ${p.clips} total`) +
      row('state', isActive ? 'detection active' : 'quiet')
    );
  }
  return '<div class="mp-title">detection</div>';
}

export function MapTab() {
  useAisPositions();
  useDetectionStreams();

  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const flownToTrackedRef = useRef<Set<number>>(new Set());
  const popupRef = useRef<maplibregl.Popup | null>(null);
  const homeServerRef = useRef<string | null>(null);

  // Follow mode: when true the camera tracks position updates for the selected
  // vessel; when false (user panned/zoomed/dragged) the camera stays put and a
  // "Recenter" button appears to re-engage tracking.
  const [followMode, setFollowMode] = useState(true);
  const prevSelectedMmsiRef = useRef<number | null>(null);

  // Per-layer visibility, toggled from the layer control.
  const [layerVis, setLayerVis] = useState<Record<LayerKey, boolean>>({
    vessels: true,
    sar: true,
    tracks: true,
    acoustic: true,
  });

  const vessels = useAisStore((s) => s.byMmsi);
  const sarChips = useDetectionsStore((s) => s.sarChips);
  const detTracks = useDetectionsStore((s) => s.tracks);
  const acousticSites = useDetectionsStore((s) => s.acousticSites);
  const selectedEntityId = useLayoutStore((s) => s.selectedEntityId);
  const setSelectedEntity = useLayoutStore((s) => s.setSelectedEntity);
  const currentChannelId = useLayoutStore((s) => s.currentChannelId);
  const channel = useChannelsStore((s) => s.channels[currentChannelId]);
  const currentServerId = useLayoutStore((s) => s.currentServerId);

  // The selected Operation's map home (Pacific Patrol → Victoria, Strait of
  // Hormuz → the Persian Gulf chokepoint). Operations are static seed data,
  // so reading servers once via getState() is safe.
  const serverHome = useMemo(
    () => useChannelsStore.getState().servers.find((sv) => sv.id === currentServerId)?.center,
    [currentServerId],
  );

  /**
   * Resolve the currently selected MMSI from either the entity selection
   * (set by clicking a token in chat or a pin on the map) or the current
   * channel's vessel sidecar (set by clicking a #vessels channel).
   */
  const selectedMmsi = useMemo(() => {
    return parseMmsi(selectedEntityId) ?? parseMmsi(channel?.vessel?.mmsi);
  }, [selectedEntityId, channel?.vessel?.mmsi]);

  // ---------- map lifecycle ----------
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    // Centre on the Operation that's active at mount. MapTab remounts on
    // channel switch (PanelGroup is keyed on currentChannelId), so switching
    // Operations lands here with the new home already resolved.
    const homeAtMount = useChannelsStore
      .getState()
      .servers.find((sv) => sv.id === useLayoutStore.getState().currentServerId)?.center;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: MAP_STYLE,
      center: homeAtMount ? [homeAtMount.lon, homeAtMount.lat] : INITIAL_CENTER,
      zoom: homeAtMount?.zoom ?? INITIAL_ZOOM,
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'nautical', maxWidth: 120 }), 'bottom-left');

    map.on('load', () => {
      map.addSource(VESSEL_SOURCE, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addSource(TRACK_SOURCE, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      const emptyFC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
      map.addSource(SAR_SOURCE, { type: 'geojson', data: emptyFC });
      map.addSource(DTRACK_SOURCE, { type: 'geojson', data: emptyFC });
      map.addSource(ACOUSTIC_SOURCE, { type: 'geojson', data: emptyFC });

      // --- detection layers (rendered beneath the vessel layers) ---
      map.addLayer({
        id: DTRACK_LINE_LAYER,
        type: 'line',
        source: DTRACK_SOURCE,
        paint: { 'line-color': '#ffb24a', 'line-width': 1.5, 'line-opacity': 0.7, 'line-dasharray': [2, 1.5] },
      });
      map.addLayer({
        id: SAR_LAYER,
        type: 'circle',
        source: SAR_SOURCE,
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 3, 14, 6],
          'circle-color': '#c084fc',
          'circle-opacity': 0.85,
          'circle-stroke-color': '#1a1030',
          'circle-stroke-width': 1,
        },
      });
      map.addLayer({
        id: DTRACK_HEAD_LAYER,
        type: 'circle',
        source: DTRACK_SOURCE,
        // only the LineString features carry no `kind`; head points do.
        filter: ['==', ['get', 'kind'], 'track'],
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 3.5, 14, 6.5],
          'circle-color': '#ffb24a',
          'circle-stroke-color': '#2a1c00',
          'circle-stroke-width': 1.5,
        },
      });
      map.addLayer({
        id: ACOUSTIC_LAYER,
        type: 'circle',
        source: ACOUSTIC_SOURCE,
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 5, 14, 9],
          'circle-color': ['case', ['get', 'active'], '#6fb6ff', '#37506e'],
          'circle-opacity': 0.9,
          'circle-stroke-color': '#cfe6ff',
          'circle-stroke-width': 1.5,
        },
      });

      map.addLayer({
        id: TRACK_LAYER,
        type: 'line',
        source: TRACK_SOURCE,
        paint: {
          'line-color': '#6fb6ff',
          'line-width': 2,
          'line-opacity': 0.85,
        },
      });
      map.addLayer({
        id: VESSEL_LAYER,
        type: 'circle',
        source: VESSEL_SOURCE,
        filter: ['!=', ['get', 'tracked'], true],
        paint: {
          'circle-radius': [
            'interpolate', ['linear'], ['zoom'],
            8, 3,
            14, 7,
          ],
          'circle-color': [
            'match', ['get', 'status'],
            'dark', '#ffb24a',
            'lost', '#5a647c',
            /* live default */ '#4ade80',
          ],
          'circle-stroke-color': '#0b101c',
          'circle-stroke-width': 1.5,
        },
      });
      map.addLayer({
        id: VESSEL_TRACKED_LAYER,
        type: 'circle',
        source: VESSEL_SOURCE,
        filter: ['==', ['get', 'tracked'], true],
        paint: {
          'circle-radius': [
            'interpolate', ['linear'], ['zoom'],
            8, 6,
            14, 12,
          ],
          'circle-color': '#ff6b6b',
          'circle-stroke-color': '#fff',
          'circle-stroke-width': 2.5,
        },
      });
    });

    const onClick = (e: MapMouseEvent) => {
      // Vessels take priority — they drive the Inspector panel.
      const vesselHits = map.queryRenderedFeatures(e.point, {
        layers: [VESSEL_TRACKED_LAYER, VESSEL_LAYER],
      });
      if (vesselHits.length > 0) {
        const mmsi = vesselHits[0].properties?.mmsi;
        if (typeof mmsi === 'number' || typeof mmsi === 'string') {
          setSelectedEntity(`MMSI ${mmsi}`);
        }
        return;
      }
      // Detections are self-contained — show a popup rather than hijacking
      // the vessel-shaped Inspector.
      const detHits = map.queryRenderedFeatures(e.point, {
        layers: [SAR_LAYER, DTRACK_HEAD_LAYER, ACOUSTIC_LAYER],
      });
      if (detHits.length === 0) return;
      popupRef.current?.remove();
      popupRef.current = new maplibregl.Popup({ closeButton: true, className: 'map-pop' })
        .setLngLat(e.lngLat)
        .setHTML(detectionPopupHtml(detHits[0].properties ?? {}))
        .addTo(map);
    };
    map.on('click', onClick);
    for (const lid of [VESSEL_LAYER, VESSEL_TRACKED_LAYER, SAR_LAYER, DTRACK_HEAD_LAYER, ACOUSTIC_LAYER]) {
      map.on('mouseenter', lid, () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', lid, () => { map.getCanvas().style.cursor = ''; });
    }

    /*
     * Drop follow-mode the moment the user moves the camera themselves
     * (drag-pan, scroll-zoom, pinch). Programmatic easeTo/flyTo from our own
     * follow effect fire 'movestart' without an `originalEvent`, so they
     * don't trip this handler — that's the key distinction.
     */
    map.on('movestart', (e) => {
      if ((e as unknown as { originalEvent?: Event }).originalEvent) {
        setFollowMode(false);
      }
    });

    /*
     * MapLibre captures container dimensions at construction. The map lives
     * inside a PanelGroup that re-mounts on channel switch — and the new
     * channel's stored layout (per-channel pane widths) settles a frame or
     * two after the map's useEffect fires. The result is a canvas captured
     * at the wrong width: tiny on first paint (black rectangle), or stretched
     * horizontally if the data pane grew after construction.
     *
     * Defence: a ResizeObserver on the container fires whenever its size
     * shifts AND a small chain of sequential frame-and-timeout resizes
     * during the first ~300ms catches whatever the observer missed.
     */
    const ro = new ResizeObserver(() => map.resize());
    if (containerRef.current) ro.observe(containerRef.current);

    const rafIds: number[] = [];
    const timeoutIds: ReturnType<typeof setTimeout>[] = [];
    let cancelled = false;
    const settle = () => {
      if (cancelled) return;
      map.resize();
    };
    // Five sequential frames covers ~80 ms of layout settling at 60fps.
    const chain = (n: number) => {
      if (cancelled || n === 0) return;
      rafIds.push(requestAnimationFrame(() => {
        settle();
        chain(n - 1);
      }));
    };
    chain(5);
    // Plus two longer catch-ups for slow layout transitions.
    timeoutIds.push(setTimeout(settle, 150));
    timeoutIds.push(setTimeout(settle, 400));
    // MapLibre swaps in a new transform when the style loads, and a camera
    // animation that began earlier keeps re-applying the old one — whose
    // width is the pre-layout one (36 px in practice). The result is a
    // stretched map that stays stretched until the window is resized. Re-measure
    // once the style is in and again once the map first goes idle (after any
    // animation has finished).
    map.once('load', settle);
    map.once('idle', settle);

    mapRef.current = map;
    return () => {
      cancelled = true;
      for (const id of rafIds) cancelAnimationFrame(id);
      for (const id of timeoutIds) clearTimeout(id);
      ro.disconnect();
      popupRef.current?.remove();
      popupRef.current = null;
      map.remove();
      mapRef.current = null;
    };
  }, [setSelectedEntity]);

  // ---------- channel change → schedule another round of resizes ----------
  // The PanelGroup is keyed on currentChannelId; in most cases this means a
  // fresh MapTab and the lifecycle effect above covers it. But if React
  // happens to reuse this MapTab instance (e.g. tab navigation that keeps
  // the same group identity), force the existing map to re-measure too.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const rafs: number[] = [];
    const timeouts: ReturnType<typeof setTimeout>[] = [];
    let cancelled = false;
    const tick = () => { if (!cancelled) map.resize(); };
    rafs.push(requestAnimationFrame(() => { tick(); rafs.push(requestAnimationFrame(tick)); }));
    timeouts.push(setTimeout(tick, 100));
    timeouts.push(setTimeout(tick, 300));
    return () => {
      cancelled = true;
      for (const id of rafs) cancelAnimationFrame(id);
      for (const id of timeouts) clearTimeout(id);
    };
  }, [currentChannelId]);

  // ---------- Operation switch → recentre the camera on its home ----------
  // MapTab usually remounts on an Operation switch (the new default channel
  // changes currentChannelId, which keys the PanelGroup) and the lifecycle
  // effect above handles it. This covers the case where React reuses the
  // instance instead: ease the camera to the new Operation's home box.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !serverHome) return;
    // The lifecycle effect already centred on the mount-time Operation;
    // only fly on an actual switch.
    const prev = homeServerRef.current;
    homeServerRef.current = currentServerId;
    if (prev === null || prev === currentServerId) return;
    map.flyTo({
      center: [serverHome.lon, serverHome.lat],
      zoom: serverHome.zoom ?? INITIAL_ZOOM,
      speed: 1.2,
    });
  }, [currentServerId, serverHome]);

  // ---------- vessel source updates ----------
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const src = map.getSource(VESSEL_SOURCE) as maplibregl.GeoJSONSource | undefined;
      if (!src) return;
      // Scope the map to the active Operation. The broker fans every
      // vessel.ais.position to all clients, so when a Victoria and a Hormuz
      // planetar-ais share one broker the store holds both fleets — a vessel
      // tagged with another Operation's serverId belongs on that tab, not
      // this one. Untagged vessels (legacy producer) are shown everywhere.
      const records = Object.values(vessels).filter(
        (r) => !r.serverId || r.serverId === currentServerId,
      );
      src.setData(vesselsToFeatureCollection(records));
      // fly to a tracked vessel the first time it appears
      for (const r of records) {
        if (!isTracked(r.mmsi)) continue;
        if (flownToTrackedRef.current.has(r.mmsi)) continue;
        flownToTrackedRef.current.add(r.mmsi);
        map.flyTo({ center: [r.latest.lon, r.latest.lat], zoom: 12, speed: 0.8 });
      }
    };
    if (map.isStyleLoaded()) apply();
    else map.once('load', apply);
  }, [vessels, currentServerId]);

  // ---------- track source (selected vessel only) ----------
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const src = map.getSource(TRACK_SOURCE) as maplibregl.GeoJSONSource | undefined;
      if (!src) return;
      const rec = selectedMmsi != null ? vessels[selectedMmsi] : undefined;
      src.setData(trackToFeature(rec));
    };
    if (map.isStyleLoaded()) apply();
    else map.once('load', apply);
  }, [selectedMmsi, vessels]);

  // ---------- detection sources: SAR chips ----------
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const src = map.getSource(SAR_SOURCE) as maplibregl.GeoJSONSource | undefined;
      if (src) src.setData(sarChipsToFC(sarChips));
    };
    if (map.isStyleLoaded()) apply();
    else map.once('load', apply);
  }, [sarChips]);

  // ---------- detection sources: SAR tracks (lines + heads, one source) ----------
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const recs = Object.values(detTracks);
    const apply = () => {
      const src = map.getSource(DTRACK_SOURCE) as maplibregl.GeoJSONSource | undefined;
      if (!src) return;
      src.setData({
        type: 'FeatureCollection',
        features: [...tracksToLineFC(recs).features, ...tracksToHeadFC(recs).features],
      });
    };
    if (map.isStyleLoaded()) apply();
    else map.once('load', apply);
  }, [detTracks]);

  // ---------- detection sources: hydrophone sites ----------
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const recs = Object.values(acousticSites);
    const apply = () => {
      const src = map.getSource(ACOUSTIC_SOURCE) as maplibregl.GeoJSONSource | undefined;
      if (src) src.setData(acousticSitesToFC(recs));
    };
    if (map.isStyleLoaded()) apply();
    else map.once('load', apply);
  }, [acousticSites]);

  // ---------- layer visibility toggles ----------
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      for (const def of LAYER_DEFS) {
        const vis = layerVis[def.key] ? 'visible' : 'none';
        for (const id of def.ids) {
          if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis);
        }
      }
    };
    if (map.isStyleLoaded()) apply();
    else map.once('load', apply);
  }, [layerVis]);

  // ---------- selection-change → recenter once + re-enable follow ----------
  useEffect(() => {
    if (selectedMmsi === prevSelectedMmsiRef.current) return;
    prevSelectedMmsiRef.current = selectedMmsi;
    if (selectedMmsi != null) setFollowMode(true);
  }, [selectedMmsi]);

  // ---------- while follow-mode is on, camera tracks position updates ----------
  useEffect(() => {
    if (!followMode || selectedMmsi == null) return;
    const map = mapRef.current;
    if (!map) return;
    const rec = vessels[selectedMmsi];
    if (!rec) return;
    map.easeTo({ center: [rec.latest.lon, rec.latest.lat], duration: 600, zoom: Math.max(map.getZoom(), 11) });
  }, [followMode, selectedMmsi, vessels]);

  const handleRecenter = useCallback(() => {
    const map = mapRef.current;
    if (!map || selectedMmsi == null) return;
    const rec = vessels[selectedMmsi];
    if (!rec) return;
    setFollowMode(true);
    map.easeTo({ center: [rec.latest.lon, rec.latest.lat], duration: 700, zoom: Math.max(map.getZoom(), 12) });
  }, [selectedMmsi, vessels]);

  // Show the recenter button only when there's a vessel to recenter on AND
  // the user has wandered off it (follow mode disengaged).
  const recenterAvailable =
    selectedMmsi != null && vessels[selectedMmsi] != null && !followMode;
  const recenterLabel = (() => {
    if (selectedMmsi == null) return null;
    const v = vessels[selectedMmsi]?.latest;
    return v?.name ?? `MMSI ${selectedMmsi}`;
  })();

  const detCounts: Record<LayerKey, number> = {
    vessels: Object.keys(vessels).length,
    sar: sarChips.length,
    tracks: Object.keys(detTracks).length,
    acoustic: Object.keys(acousticSites).length,
  };

  return (
    // data-vessel-count is an invisible test/debug hook — the visible legend
    // overlay was removed; this keeps the count queryable without chrome.
    <div
      className="map-tab"
      data-vessel-count={detCounts.vessels}
      data-sar-count={detCounts.sar}
      data-track-count={detCounts.tracks}
      data-acoustic-count={detCounts.acoustic}
    >
      <div ref={containerRef} className="map-canvas" />
      <div className="map-layers">
        {LAYER_DEFS.map((def) => (
          <label key={def.key} className="map-layer-row">
            <input
              type="checkbox"
              checked={layerVis[def.key]}
              onChange={(e) =>
                setLayerVis((v) => ({ ...v, [def.key]: e.target.checked }))
              }
            />
            <span className="map-layer-swatch" style={{ background: def.swatch }} />
            <span className="map-layer-label">{def.label}</span>
            <span className="map-layer-count">{detCounts[def.key]}</span>
          </label>
        ))}
      </div>
      {recenterAvailable ? (
        <button
          type="button"
          className="map-recenter"
          onClick={handleRecenter}
          title={`Recenter on ${recenterLabel ?? 'vessel'} and resume follow`}
        >
          <span className="map-recenter-glyph">⌖</span>
          Recenter
        </button>
      ) : null}
    </div>
  );
}
