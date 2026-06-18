# Test suite

Regression coverage for `dynamicwatch-custom-tiles.user.js`.

## Run

```bash
npm test                 # rebuild bundle, then run all suites
bash tests/run.sh        # all three suites, coloured output
bash tests/run.sh --ci   # plain text, log-scrapable, same exit code
```

Exits with the sum of failures. Run individual suites:

```bash
node tests/unit.mjs        # 57 tests, no network, ~200 ms
bash tests/smoke.sh         # 34 tests + 7 skips, ~15 s
node tests/shape.mjs        # 42 tests + 2 skips, ~15 s
```

## Three layers, increasing depth

### `unit.mjs` — pure helpers (57 tests, no network)

Loads the bundled userscript via `_loader.mjs` in a `vm.createContext`
sandbox (Leaflet + GM + browser globals stubbed; boot disabled by test
flags). Asserts the
pure code paths the script relies on every frame:

- `tileToBBox4326` / `tileToBBox3857` — world coverage, four-quadrant
  split, round-trip over Brisbane, half-per-zoom width invariant
- `zig`, `readVarint` — protobuf primitives
- `decodeGeometry` — triangle MoveTo+LineTo+ClosePath, two-ring sequence
- `mvtDecode` — empty PBF returns []; hand-built minimal PBF round-trips
- `hexAlpha` — `#rrggbb` → `rgba()`; non-hex passes through
- `pointInRing` — inside/outside on the unit square
- `intvlActivityTime` — cuid v1 prefix decode, garbage rejection
- `intvlAgo` — today / yesterday / N days ago
- `intvlArea` — m² under 0.1 km², km² with magnitude-aware precision
- layer-provider factories and overlay group registration

### `smoke.sh` — endpoint liveness (34 tests, 7 skips)

Each test fetches one representative request over Brisbane CBD
(`-27.4698, 153.0251`) and verifies:

1. HTTP 200 (or 401/500 where the test is "is this endpoint alive?")
2. Content-Type substring matches
3. Body size ≥ minimum (catches empty-error-page-disguised-as-tile)

Coverage by group:

| Group | Tests |
| --- | --- |
| Raster XYZ | Google Hybrid, OpenSeaMap, Strava, Garmin (all 5 activities), QLD Topo + Relief + Labels, Stamen via Stadia (localhost spoof), Mapbox GL JS CDN |
| Vector tiles | INTVL global, OpenInfraMap power + telecoms + water |
| ArcGIS exportImage | ACCC Mobile Coverage, QLD QPWS Estate, QLD Cadastre |
| WMS | Light Pollution (grid-aligned z=10 bbox) |
| JSON APIs | OpenSky, QPWS national-park query, Wayback catalog, Cadastre `/identify` + attribute query, QLD AerialOrtho query, OnTheHouse locations + property + events |
| Auth liveness | Apple DDG JWT (200 + JWT shape), QLD token endpoint (500 + structured error), Geocaching UTFGrid (200, cell-coded list), Geocaching map.details (success JSON) |
| Auth-gated / tokened (skipped) | Mapbox Terrain-DEM TileJSON unless `MAPBOX_TOKEN` is set, QLD Globe + Roads + Historical photos (QLD token bootstrap), Apple tiles (DDG → Apple), Wayback tile, MarineTraffic (Cloudflare-blocked anon) |

### `shape.mjs` — structural validation (42 tests, 2 skips)

The same endpoints but with deep assertions on response structure. This
catches the case where an upstream silently renames a field or changes a
type — smoke would still pass, shape would fail. Uses the userscript's
own `mvtDecode` (loaded via `_loader.mjs`) so PBF decoding is exercised
end-to-end with the same code the script runs in the browser.

Mapbox Terrain-DEM structural probes are opt-in so no Mapbox token is
committed to the repository. Run with `MAPBOX_TOKEN=pk...` to include
the TileJSON and terrain-raster checks.

What gets validated per type:

- **Image tiles** — magic-byte sniff (`89 50 4E 47` for PNG, `FF D8 FF`
  for JPEG); catches error pages masquerading as `image/png`
- **Strava** — PNG IHDR dimensions ≥ 512 (confirms HiDPI `@2x` raster,
  not the basic 256px fallback)
- **INTVL PBF** — decodes via `mvtDecode`, expects layer named
  `"territories"` with extent 4096, ≥1 polygon feature, and properties
  `colour` + `currentArea` + `startTime` + (`runId` or `activityId`)
- **OpenInfraMap power PBF** — decodes, expects ≥1 layer from
  `{power_line, power_substation, power_substation_point, power_plant,
  power_plant_point, power_generator_area, power_generator, power_tower}`
- **OpenInfraMap telecoms PBF** — decodes, expects ≥1 of
  `{telecoms_data_center, telecoms_data_center_point, telecoms_mast,
  telecoms_antenna}`
- **OpenInfraMap water PBF** — decodes, expects ≥1 of
  `{water_pipeline, water_treatment_plant_polygon/point,
  wastewater_plant_polygon/point, water_reservoir, water_reservoir_point,
  pumping_station_polygon/point, water_tower, water_well}`
- **OpenSky** — `{time, states}`; if non-empty, each state is an array
  with len ≥ 17; lon (`s[5]`) + lat (`s[6]`) are numbers
- **QPWS national parks** — GeoJSON FeatureCollection; every feature has
  `properties.estatename` and `properties.esttype` ∈ `{NP, NS, NY, NA}`
- **Wayback catalog** — top-level object with >100 release keys; each
  entry has `itemTitle` matching `/Wayback /`
- **Cadastre `/identify`** — `results[].attributes` is an object
- **Cadastre attr query** — `features[].attributes.lotplan` is a string
- **QLD AerialOrtho query** — `features[].attributes` has `objectid`
  (number) + `capturestart` (epoch ms)
- **OnTheHouse locations** — `content[]` rows have `propertyId`,
  `streetNumber`, `streetName`, `streetType`, `suburb`, `postCode`
- **OnTheHouse property** — `address.formattedAddress` + `streetNumber`
  + `streetName` + `suburb` + `postCode` + top-level `type`
- **OnTheHouse events** — `content[]` has ≥1 known type
  (`SoldEvent`/`ForRentEvent`/`ListedEvent`/`WithdrawnEvent`)
- **Apple DDG JWT** — body matches `/^[\w-]+\.[\w-]+\.[\w-]+$/`
- **QLD token endpoint** — `POST {}` returns HTTP 500 + `{error}`
- **Geocaching UTFGrid** — anon → HTTP 200, `keys[]` of `(cx, cy)` strings, `data[k]` = array of `{i: GC<code>, n: <name>}`
- **Geocaching map.details** — anon → `{status: "success", data: [{gc, name, difficulty, terrain, container, type, owner, available}]}`

## Adding tests

### A new public layer

1. In `smoke.sh`, copy the closest `probe` (raster) or `probe_json` line
   and edit the URL. Use the Brisbane tile-coord lookup:

   | Zoom | x | y |
   | ---: | ---: | ---: |
   |  8 |  236 |  148 |
   | 10 |  947 |  593 |
   | 12 | 3789 | 2373 |

   Compute others with:
   ```js
   const lon = 153.0251, lat = -27.4698;
   const n = 2 ** z;
   const x = Math.floor((lon + 180) / 360 * n);
   const rad = lat * Math.PI / 180;
   const y = Math.floor(
     (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * n);
   ```

   For WMS, the bbox must be exactly grid-aligned to the cache or
   GeoServer returns `400: No SRS specified` (misleading error). Use
   `tileToBBox3857(z, x, y)` from the userscript.

2. In `shape.mjs`, add a `test(name, async () => {...})` block. For
   images use `sniffImage(r.body)`; for JSON use `assertHasKeys` /
   `assertType`; for PBF use `dw.mvtDecode(r.body.buffer)`.

### A new pure helper

In `unit.mjs`, add the function name to `HELPERS` in `_loader.mjs` so
it's exported from the sandbox. Then write a `t(name, fn)` assertion.

### An auth-gated layer

The `SKIP` entries in `smoke.sh` are placeholders for layers that need
real credentials or an explicit local token. To wire one up, implement its bootstrap (the
`QldTokenManager` / `AppleTokenManager` flows can be lifted from the
userscript), acquire the token, and probe the tile URL. Worth doing
only if you actively need that coverage — the credential dance is
brittle and ties tests to upstream auth flow changes.
