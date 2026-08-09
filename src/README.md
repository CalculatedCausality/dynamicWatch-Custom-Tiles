# Source Layout

`dynamicwatch-custom-tiles.user.js` remains the Tampermonkey install/update file.

Editable source lives here and is bundled back into that exact filename with:

```bash
npm run build
```

`src/main.js` is the ESM entrypoint. `scripts/build-userscript.mjs` uses `esbuild` to bundle all imported modules into one IIFE userscript, so Tampermonkey still receives a single file and there are no runtime `import` statements or external module fetches.

Current modules:

- `src/app.js` — userscript bootstrap, version banner, test-export surface, and `CustomTilesApp` startup.
- `src/app/custom-tiles-app.js` — main application orchestration: Leaflet interception, provider registration, layer restore, popup enrichment, group headers, history scrubbers, and style injection.
- `src/bridge/mapbox-tile-bridge.js` — Mapbox GL `dw://`/sentinel tile bridge used by GM-fetcher-backed layers in 3D mode.
- `src/config.js` — userscript configuration and layer grouping.
- `src/layers/hover-identify.js` — ArcGIS identify and Leaflet hover-tooltip wiring helpers.
- `src/layers/provider-factories.js` — shared `LayerProvider` base class, raster providers, token-aware providers, ArcGIS export tile helpers, and overzoom fallback.
- `src/layers/polling-data-layer.js` — shared timer/view-refresh layer scaffold for live data overlays.
- `src/layers/vector-tile-layer.js` — shared Leaflet vector-tile overlay factory for MVT-backed providers.
- `src/providers/geocaching.js` — Geocaching.com raster/UTFGrid overlay and lazy cache-details enrichment.
- `src/providers/fog-of-world.js` — session-backed Dropbox downloader, Fog of World sync-chunk decoder, and lazy fog tile renderer.
- `src/providers/heatmaps.js` — Strava and Garmin heatmap providers.
- `src/providers/intvl-global.js` — INTVL Global Map MVT renderer and hover identify.
- `src/providers/light-pollution.js` — Light Pollution WMS overlay.
- `src/providers/live-data.js` — polling live overlays for OpenSky flights, MarineTraffic vessels, and Waze traffic (alerts, jams, wazers).
- `src/providers/raster-providers.js` — low-coupling raster/base/overlay providers such as Google, Apple, QLD Globe/Topo/Relief, Mobile Coverage, OpenSeaMap, and QLD Labels.
- `src/providers/openinframap.js` — OpenInfraMap Power, Telecoms, and Water vector-tile providers.
- `src/providers/cadastre-au.js` — unified Australia Cadastre: per-tile overlay routing across every state/territory service (national fallback for WA/ACT/NT) and click-identify with per-jurisdiction field adapters.
- `src/providers/qld-cadastre.js` — QLD parcel address resolver, the shared OnTheHouse sales pipeline, and the cadastre tooltip formatter used by all jurisdictions.
- `src/providers/qld-environment.js` — QPWS Estate, National Parks, and their ArcGIS query layer helper.
- `src/providers/qld-imagery.js` — QLD Roads and QLD Historical imagery providers.
- `src/providers/qld-mining.js` — QLD mining overlays: Historic Mines (workings), Mine Shafts (Abandoned Mine Lands openings), and Historic Mining Leases (MinesPermitsHistoric title footprints), each with hover-identify tooltips.
- `src/providers/qld-historical-maps.js` — Historic Map Sheets: footprint index of QLD's scanned parish/town/topographic/exploration maps, a click popup listing the sheets at a point with scan links, and a distortable image overlay (CSS `matrix3d` homography, four draggable corners) to rubber-sheet a scan onto the live map.
- `src/providers/scc-applications.js` — Sunshine Coast Council development-application overlay (Development.i APIs).
- `src/providers/stamen-terrain.js` — Stamen Terrain provider.
- `src/providers/vexcel.js` — Vexcel Aerial base map: dated ortho mosaic, IR toggle, oblique metadata queries, and route pixel projection.
- `src/providers/vexcel-auth.js` — Vexcel credential/token persistence, login coalescing, session minting, and required request headers.
- `src/providers/vexcel-oblique-layer.js` — warped oblique imagery pane on the primary map (tile warp, frame transitions, compass control).
- `src/providers/waze-token.js` — Waze reCAPTCHA Enterprise token broker for the georss live-map API.
- `src/providers/wayback.js` — Esri Wayback provider.
- `src/runtime/mode-3d.js` — Mapbox GL terrain controller and planner-toolbar 3D toggle button.
- `src/tokens.js` — QLD and Apple short-lived token managers.
- `src/ui/layer-manager-ui.js` — layer archive/manage panel injected into the Leaflet layer control.
- `src/utils/html.js` — shared escaping, safe-colour, price, and date formatting helpers.
- `src/utils/http.js` — GM_xmlhttpRequest wrappers, abort wiring, request coalescing, and persistent TTL cache helpers.
- `src/utils/intvl.js` — INTVL formatting and geometry helpers.
- `src/utils/mvt.js` — minimal MVT/PBF parsing and INTVL tile preprocessing helpers.
- `src/utils/tile-geometry.js` — pure tile projection helpers.
