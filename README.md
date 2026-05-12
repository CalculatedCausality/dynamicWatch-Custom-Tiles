# dynamicWatch Custom Tiles

A Tampermonkey userscript that improves the [dynamicWatch](https://dynamic.watch) trip planner with better map layers and a few quality-of-life tweaks.

---

## Features

### Map layers

The stock dynamicWatch map only ships with OpenStreetMap/topo. This script adds several more options to the layer switcher:

| Layer | Type | Max zoom | What it's good for |
|---|---|---|---|
| **QLD Globe** | Base | 21 | High-res Queensland Government aerial imagery; clearest option for most of QLD |
| **Google Hybrid** | Base | 21 | Satellite with road labels baked in; good fallback outside QLD |
| **QLD Historical** | Base | 21 | Browse past aerial captures of a location; see how an area looked years ago |
| **NSW Imagery** | Base | 21 | NSW Government (SIX Maps) high-res aerial imagery |
| **VIC Imagery** | Base | 20 | Victoria's Vicmap aerial imagery from the Department of Transport and Planning |
| **NT Imagery** | Base | 19 | Northern Territory NRMaps satellite/aerial imagery |
| **Strava Heatmap** | Overlay | 10 | Aggregated Strava activity data; useful for finding popular routes |
| **Garmin Heatmap** | Overlay | 17 | Composited heatmap from Garmin Connect — running, hiking, trail running and mountain biking all blended together |

**QLD Labels** and **QLD Roads** are injected as overlays and toggle on/off automatically when you switch to or away from a QLD base layer. **VIC Labels** and **NT Labels** work the same way for their respective base layers. None of these clutter the layer switcher.

| QLD Globe + Strava Heatmap | QLD Historical (1972) |
|---|---|
| ![QLD Globe aerial imagery with Strava heatmap overlay showing trail activity](images/screenshot-strava.png) | ![QLD Historical layer showing a 1972 aerial capture with the date navigator control](images/screenshot-historical.png) |

### Historical imagery navigator

When the QLD Historical layer is active, a **◀ date ▶** control appears in the top-right corner. Click the arrows to step through every aerial capture available for the current map view. Panning to a new area automatically loads the captures for that location.

### Street View from any click

Right-clicking the map (or placing a waypoint) shows a popup with the usual dynamicWatch actions. The script adds a **Street View** button to the same row; opens Google Street View at that exact coordinate in a new tab.

### Layer memory

Your last active base layer is saved and restored automatically when you come back to the page.

### Layer manager

The ⚙ **Manage layers** link at the bottom of the layer switcher lets you hide layers you never use. Hidden layers are remembered in `localStorage`; unhide them any time.

---

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/) for your browser.
2. Open Tampermonkey → **Create a new script**.
3. Replace everything in the editor with the contents of [`dynamicwatch-custom-tiles.user.js`](dynamicwatch-custom-tiles.user.js) and save.
4. Open [dynamic.watch/plan](https://dynamic.watch/plan); the new layers appear in the switcher straight away.

---

## How the QLD token works

Queensland Globe imagery requires a short-lived bearer token issued by the QLD Government API. The script fetches one silently in the background on first load, caches it via Tampermonkey's storage, and schedules a refresh before it expires. If a refresh fails it retries with exponential backoff. No QLD account needed; the token endpoint is publicly accessible.

---

## Known limitations

- **Strava Heatmap is zoom <= 10 only.** Higher-zoom tiles require CloudFront signed cookies that Strava only issues via a browser session on their own site. Fetching them from an external script isn't reliably possible, so the layer uses the anonymous endpoint and caps at zoom 10.
- **Garmin Heatmap composites 4 activity types** (running, hiking, trail running, mountain biking) by fetching each tile separately and blending them with additive canvas compositing. Other Garmin activity types (cycling, walking, etc.) don't have public tile endpoints. Each map tile requires 4 network requests so it may be slightly slower to load.
- **NT Imagery and NT Labels** are served via a POST-based API (not a standard tile service) so each tile is fetched individually through Tampermonkey's cross-origin request handler. Tiles may load slightly slower than standard layers.
- **QLD Historical coverage is location-dependent.** Some parts of QLD have many captures going back decades; others have very few or none. The navigator shows "Loading..." while querying the catalog and updates once results come back.