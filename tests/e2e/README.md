# End-to-end test runner

A Playwright-driven harness that loads dynamic.watch's planner in real
Chromium with the userscript injected, toggles 3D Mode, then captures a
structured snapshot of Mapbox state + Leaflet inventory + console logs.

Lets us iterate on the 3D code without manually clicking through the
browser every change.

## Setup

```bash
npm install                  # installs @playwright/test
npm run e2e:install          # downloads Chromium
npm run e2e:auth             # one-off: log in to dynamic.watch
```

`npm run e2e:auth` opens Chromium, you log in by hand, press ENTER in the
terminal, and the session cookie gets saved to `.auth/storage.json`
(gitignored). The headless runs reuse that until the session expires —
re-run when the headless run reports "redirected to sign_in".

## Running

Two scripts, two purposes.

### `run-3d-asserts.mjs` — the test suite (use this for CI)

```bash
npm run e2e:asserts          # headless
npm run e2e:asserts:headed   # watch a Chromium window
```

Runs 8 pass/fail tests on a saved plan (`PLAN=/plan/2344645` by default).
Exits non-zero on any failure. Tests cover:

1. **3D enabled** — clicks the button, waits for Mapbox style.load.
2. **Markers reproject after rotation** — bearing 45°, verify every
   marker's screen rect matches `mb.project(latLng)`.
3. **Drag waypoint moves marker** — synthetic mouse-drag, verify
   `marker.getLatLng()` actually changed.
4. **Drag waypoint stays under cursor in 4 directions** — drag each
   direction, verify icon centre matches the intended drop point
   within tolerance.
5. **Stress: rapid 3D + layer + camera thrash** — 8 toggle cycles
   while flipping random overlays, then a camera-jump barrage. Asserts
   no CustomTiles page errors, marker latLngs stay sane, route line
   + DEM source survive.
6. **Heatmap layers persist after toggle on** — Strava/Garmin: toggle
   on, wait, assert it's still in the Mapbox style 2.5 s later.
7. **Overlay renders above active-base** — by-URL-fragment check
   that `dw-overlay-N` for Strava has higher index than `active-base`.
8. **Detached markers get pruned from cache** — manually detach an
   icon, run a sync, verify `_markerCache` shrunk by one.

Reports go to `test-results/3d-asserts-<timestamp>.json`.

### `verify-geocaches.mjs` — Geocaches layer end-to-end

```bash
npm run e2e:geocaches            # headless
npm run e2e:geocaches:headed     # watch it
# Aim at a specific area (default is deliberately-cold Gold Coast tiles):
GC_LAT=-33.87 GC_LNG=151.21 GC_ZOOM=12 node tests/e2e/verify-geocaches.mjs
```

The ONLY test that exercises the full integrated Geocaches layer in a
live map. It exists separately because Groundspeak's UTFGrid endpoint
needs the `Referer: https://www.geocaching.com/play/map` header, which
the fetch-based GM shim can't set — so this script installs a
`context.route` handler that injects Referer at the network layer
(below fetch's forbidden-header policy), faithfully reproducing what
real Tampermonkey does.

It forces the map to a cache region, enables Geocaches, waits for the
cold-tile warm cycle (info 204 → png warm → info data), then asserts
markers actually landed in `dwGeocachingPane` with a real GC code in
the tooltip. Saves a screenshot to `test-results/verify-geocaches-*.png`.

Caught two showstoppers the unit/shape/smoke tests missed: a `MAX_TILES`
cap that rendered nothing at normal zoom, and the cold-tile 204 warming
requirement. Both were invisible to isolated helper/endpoint tests.

### `verify-waze.mjs` — Waze Traffic layer (token broker + render)

```bash
npm run e2e:waze            # headless — guards broker/minting code
npm run e2e:waze:headed     # headed  — proves georss acceptance + full render
```

Two phases, because two independent things can break. **Phase 1** (no
auth) loads `https://embed.waze.com/iframe` — the one Waze surface that
allows framing (no X-Frame-Options; www.waze.com is SAMEORIGIN) and
carries the same reCAPTCHA site key. It asserts the userscript's token
broker mints a correct-origin token and publishes it to GM storage, then
validates that token against `/live-map/api/georss` via `node:https`
(which — unlike browser fetch — can set the Referer real Tampermonkey
sends). **Phase 2** (needs auth) seeds that real token as the manual
override, enables the Waze overlay on a plan, and asserts alerts (markers),
jams (polylines), and wazers (circles) render into `dwWazePane` with sane
tooltips.

IMPORTANT — reCAPTCHA scores automated browsers low, so **headless gets a
token georss 403s** (expected, not a bug). Headless therefore gates only
the broker/minting code (green when that's correct) and skips the render
phase; **headed** gets a real-scored token, so georss returns 200 and the
full render is exercised (a passing run shows ~90+ alerts, ~90+ jams,
~40 wazers). Use headed to actually prove the feature; headless as the CI
regression guard.

### `verify-stamen-3d.mjs` / `verify-heatmaps-3d.mjs` — GM blob bridge

```bash
npm run e2e:stamen-3d      # Stamen Terrain renders in 3D
npm run e2e:heatmaps-3d    # Strava + Garmin mirror when toggled on in 3D
npm run e2e:hist-3d        # QLD Historical renders in 3D + scrubber swaps captures
npm run e2e:mobile-ident   # touch-emulated: popup identify + geocache tap containment
```

(`verify-hist-3d.mjs` covers the NON-bridge path: QLD Historical uses a
direct `{bbox-epsg-3857}` exportImage getter — the QLD endpoint reflects
CORS origins — and asserts that moving the capture scrubber while in 3D
swaps the source's `lockRasterIds`.)

Verify the transformRequest blob bridge (the `addProtocol` replacement —
Mapbox v3 has no addProtocol). These layers need a GM_xmlhttpRequest
fetch (Origin spoof / CORS-exempt) that Mapbox's own fetch can't do.
`verify-stamen-3d` injects the `Origin: http://localhost` Stadia requires
via `context.route` (the fetch shim can't set Origin), then asserts the
active-base uses the `dwtile.local` sentinel and Stadia tiles fetch 200.
`verify-heatmaps-3d` toggles Strava + Garmin ON while already in 3D and
asserts each mirrors to a sentinel-backed source + fetches tiles.

### `diag-layers.mjs` — base-switch + overlay-order diagnostic

```bash
npm run e2e:diag-layers          # headless
npm run e2e:diag-layers:headed   # watch it
```

Not pass/fail — dumps Leaflet pane z-indices and the Mapbox 3D layer
stack so you can see how base layers and overlays actually stack. Built
to reproduce two 3D bugs (both fixed in v7.9.90): switching base layers
before the previous finished rendering not updating the 3D imagery, and
INTVL rendering under the base when QLD Globe is active. Exercises
fast-vs-slow 3D base switching and checks INTVL stays above `active-base`.

### `run-3d-check.mjs` — the snapshot debugger

```bash
# Default — open /plan, toggle 3D, dump snapshot
npm run e2e:check

# Watch it run in a visible window
npm run e2e:check:headed

# Open a specific saved plan
PLAN=/plan/2344645 node tests/e2e/run-3d-check.mjs

# Enable Leaflet overlay layers before toggling 3D
OVERLAYS="INTVL Global Map,Mobile Coverage" npm run e2e:check
```

For when you want to inspect Mapbox/Leaflet state, NOT run assertions.
Writes a JSON snapshot + viewport screenshot per run.

Each run writes:

- `test-results/3d-check-<timestamp>.json` — full snapshot + console
  logs + page errors
- `test-results/3d-check-<timestamp>.png` — viewport screenshot taken
  ~2.5 s after 3D enabled

`test-results/` is gitignored.

### Vexcel perspective editing

```bash
npm run e2e:vexcel-editing
npm run e2e:vexcel-editing:headed
```

Uses the live dynamic.watch planner UI with deterministic mocked Vexcel
query, tile, and transform endpoints. It rapidly adds a straight-line route,
inserts and drags a route point, adds and drags a standalone waypoint, deletes
a route point through its popup, and verifies unrelated Leaflet overlays retain
their own clicks. No production Vexcel token is required.

## What the snapshot contains

Same shape as the manual debug snippets we've been pasting in the chat:

- `mbStyleLoaded`, `mbCenter`, `mbZoom`, `mbPitch` — Mapbox camera
- `mbSources`, `mbLayers` — what Mapbox actually has registered
- `leafletLayerCount`, `leafletPaneCounts`, `leafletLayersSample` —
  recursive walk of every Leaflet layer + its pane
- `dwRegistrySize`, `dwRegistryKeys` — userscript-side GM-fetcher
  registrations (Stamen, QLD Historical, Garmin, Strava — the layers
  served through the transformRequest blob bridge)
- `hasAddProtocol` — whether the page Mapbox exposes `addProtocol`.
  Always `false`: Mapbox GL JS v3 dropped it (a MapLibre API). Those
  layers render in 3D via the transformRequest blob bridge instead, so
  this is no longer a blocker — just a signal of which path is in use.

## What's NOT covered

- **Stamen Terrain** — needs an `Origin: http://localhost` spoof that
  `fetch` can't set (browser-forbidden header). It renders blank in this
  harness UNLESS a `context.route` injects the header at the network
  layer (see `verify-stamen-3d.mjs`). Real Tampermonkey's
  GM_xmlhttpRequest sets it natively. In 3D it flows through the
  transformRequest blob bridge (Mapbox v3 has no addProtocol).
- **Geocaches** — Groundspeak's UTFGrid endpoint requires the
  `Referer: https://www.geocaching.com/play/map` header to return
  data at z >= 12; `fetch` strips Referer so the layer renders
  blank in this harness. Real Tampermonkey GM_xmlhttpRequest sets
  it correctly. The shape test in `shape.mjs` covers the endpoint
  contract directly with `node fetch` which CAN set Referer.
- **Auth-gated Cadastre** — the harness sends the dynamic.watch
  session cookie but doesn't have third-party Cadastre logins.
- **Overlay panel automation** — `OVERLAYS=…` is best-effort; the
  layer-control DOM isn't always open by the time we look.

## Architecture

- [`lib/bootstrap.js`](lib/bootstrap.js) — Tampermonkey shim. Defines
  `GM_getValue`/`GM_setValue` (localStorage-backed), `GM_xmlhttpRequest`
  (fetch-backed), `GM_addStyle`, `unsafeWindow = window`, etc. Injected
  via `addInitScript` so it lands before the userscript runs.
- [`run-3d-check.mjs`](run-3d-check.mjs) — the debug snapshotter.
- [`run-3d-asserts.mjs`](run-3d-asserts.mjs) — the test suite.
- [`save-auth.mjs`](save-auth.mjs) — one-off interactive login →
  `.auth/storage.json`.

## Adding a new test

Edit `run-3d-asserts.mjs`, write an `async function runTestN()`, then
call it from the main flow at the bottom of the `await runTestX()`
chain. Use the existing helpers (`pass(name)`, `fail(name, detail)`,
`pageErrors`, `consoleLogs`) — the totals tracker updates automatically.

Most useful primitives:

- `page.evaluate(() => { ... access window._dwMap / window._dwMb / window._dw3D ... })`
  — `_dwMap` is the Leaflet map, `_dwMb` is the Mapbox instance,
  `_dw3D` is the Mode3DController (also see `_dwLayerCtrl` for the
  layer-control registry).
- Synthetic mouse drag — see `runTest3` for the canvas-targeted form
  and `runTest2` for the marker-icon-targeted form.
- `mb.getStyle().layers` — bottom-to-top render order; index N paints
  over index N-1.

Keep tests small + focused. The stress test exists to catch state
leaks; individual functional assertions should be their own test.
