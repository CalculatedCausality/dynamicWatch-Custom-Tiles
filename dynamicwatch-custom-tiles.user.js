// ==UserScript==
// @name         dynamicWatch – Map Layers & Overlays
// @namespace    https://dynamic.watch
// @version      7.9.130
// @description  Multi-source basemaps (QLD Globe/Historical/Topo, Google Hybrid, Apple Maps, Stamen Terrain, Esri Wayback, Vexcel Aerial) plus overlays: QPWS Estate, QLD Cadastre, SCC Applications (Development.i), Mobile Coverage, Marine Vessels (with grid-clustering), Live Flights, Waze Traffic (alerts + jams), Geocaches, Strava/Garmin heatmaps, Light Pollution, Power Infrastructure, Telecoms, Water Infrastructure, National Parks, OpenSeaMap, QLD Relief, INTVL Global Map. Includes overlay persistence, QPWS hover-identify, cadastre Sales lookup via OnTheHouse, coordinate click-to-copy, and auto-refreshing access tokens for QLD and Apple MapKit.
// @author       Matthew Aucott
// @match        https://dynamic.watch/plan*
// @match        https://embed.waze.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @connect      qldglobe.information.qld.gov.au
// @connect      spatial-img.information.qld.gov.au
// @connect      spatial-gis.information.qld.gov.au
// @connect      geopublic.scc.qld.gov.au
// @connect      developmenti.sunshinecoast.qld.gov.au
// @connect      publicdocs.scc.qld.gov.au
// @connect      api.vexcelgroup.com
// @connect      admin.vexcelgroup.com
// @connect      connecttile.garmin.com
// @connect      strava.com
// @connect      content-a.strava.com
// @connect      cdn.apple-mapkit.com
// @connect      duckduckgo.com
// @connect      tiles.stadiamaps.com
// @connect      s3-us-west-2.amazonaws.com
// @connect      wayback.maptiles.arcgis.com
// @connect      opensky-network.org
// @connect      www.marinetraffic.com
// @connect      www.waze.com
// @connect      openinframap.org
// @connect      spatial.infrastructure.gov.au
// @connect      tiles.openseamap.org
// @connect      www2.lightpollutionmap.info
// @connect      www.onthehouse.com.au
// @connect      d1yalngj9nsyl4.cloudfront.net
// @connect      www.geocaching.com
// @connect      tiles01.geocaching.com
// @connect      tiles02.geocaching.com
// @connect      tiles03.geocaching.com
// @connect      tiles04.geocaching.com
// @connect      api.mapbox.com
// @connect      s3.amazonaws.com
// @connect      elevation-tiles-prod.s3.amazonaws.com
// @run-at       document-start
// ==/UserScript==
(() => {
  // src/config.js
  var CFG = {
    LAYER_QLD: "QLD Globe",
    LAYER_GOOGLE: "Google Hybrid",
    LAYER_APPLE: "Apple Maps",
    LAYER_STAMEN_TERRAIN: "Stamen Terrain",
    LAYER_WAYBACK: "Esri Wayback",
    WAYBACK_CONFIG_URL: "https://s3-us-west-2.amazonaws.com/config.maptiles.arcgis.com/waybackconfig.json",
    // Apple MapKit raster tile endpoint (ti/tile). The vector endpoint
    // (md/v1/vtile) returns protobuf and won't render in plain Leaflet.
    // style=0 = road map; tint=dark gives the dark colour scheme.
    // accessKey and `v` build number are injected at runtime by
    // AppleTokenManager (acquired via DuckDuckGo's bootstrap flow).
    APPLE_TILE_BASE: "https://cdn.apple-mapkit.com/ti/tile?x={x}&y={y}&z={z}&style=0&size=1&scale=2&lang=en&poi=1&labels=1&tint=dark&emphasis=standard",
    APPLE_DDG_TOKEN_URL: "https://duckduckgo.com/local.js?get_mk_token=1",
    APPLE_BOOTSTRAP_URL: "https://cdn.apple-mapkit.com/ma/bootstrap?apiVersion=2&mkjsVersion=5.79.95&poi=1",
    APPLE_DDG_ORIGIN: "https://duckduckgo.com",
    APPLE_TOKEN_TTL: 30 * 60 * 1e3,
    APPLE_DEFAULT_V: "2605231",
    // Stadia Maps (Stamen Toner host) allows keyless tile requests from
    // localhost. We proxy tiles through GM_xmlhttpRequest with spoofed
    // Origin/Referer headers — browser CORS blocks setting these from
    // regular XHR, but the userscript-manager API bypasses that.
    STADIA_SPOOF_ORIGIN: "http://localhost",
    LAYER_LABELS: "QLD Labels",
    LAYER_ROADS: "QLD Roads",
    // Vexcel high-res aerial (ANZ program, "urban" ortho mosaic) via
    // their WMTS. Needs a user-supplied JWT (expires ~daily) — pasted
    // once per day via prompt, stored in GM. CORS is open so tiles are
    // plain <img> loads in 2D and direct raster sources in 3D.
    LAYER_VEXCEL: "Vexcel Aerial",
    VEXCEL_API_BASE: "https://api.vexcelgroup.com",
    VEXCEL_WMTS_BASE: "https://api.vexcelgroup.com/v2/ortho/wmts",
    VEXCEL_TOKEN_KEY: "dw_vexcel_token",
    VEXCEL_VIEWER_URL: "https://anz-viewer.vexcelgroup.com",
    // Auto-login (opt-in): the viewer mints its ~24 h JWT via
    // POST admin.vexcelgroup.com/api/auth/authenticate {username,password,
    // application} → {data:{token}}. Credentials live in GM storage on the
    // user's own machine ONLY (same trust model as the token) — never in
    // the script or git. Lets the daily token refresh silently.
    VEXCEL_ADMIN_BASE: "https://admin.vexcelgroup.com",
    VEXCEL_USER_KEY: "dw_vexcel_user",
    VEXCEL_PASS_KEY: "dw_vexcel_pass",
    VEXCEL_APP_KEY: "anz",
    VEXCEL_APP_HDR: "viewer-app",
    // Esri's reference overlays — the label/road tile pair designed to
    // sit on World Imagery. Auto-synced onto the Wayback base the same
    // way QLD Labels/Roads pair with the QLD bases. Keyless XYZ.
    LAYER_ESRI_REF: "Esri Labels & Roads",
    ESRI_PLACES_TILE: "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
    ESRI_TRANSPORT_TILE: "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}",
    LAYER_STRAVA: "Strava Heatmap",
    LAYER_GARMIN: "Garmin Heatmap",
    QLD_ORIGIN: "https://qldglobe.information.qld.gov.au",
    QLD_TOKEN_EP: "https://qldglobe.information.qld.gov.au/api/qldglobe/public/token",
    QLD_SERVICE: "https://spatial-img.information.qld.gov.au/arcgis/rest/services/Basemaps/LatestStateProgram_QGovSISPUsers/ImageServer",
    QLD_TILE_TPL: "https://spatial-img.information.qld.gov.au/arcgis/rest/services/Basemaps/LatestStateProgram_QGovSISPUsers/ImageServer/tile/{z}/{y}/{x}",
    QLD_LABELS_TILE: "https://spatial-gis.information.qld.gov.au/arcgis/rest/services/Basemaps/QldImageryLabel/MapServer/tile/{z}/{y}/{x}",
    QLD_ROADS_EXPORT: "https://spatial-gis.information.qld.gov.au/arcgis/rest/services/Transportation/RoadsAndTracks/MapServer/export",
    MAPTYPE_COOKIE: "leafletgl_maptype",
    ARCHIVE_KEY: "dw_archived_layers",
    REFRESH_MARGIN: 5 * 60 * 1e3,
    DEFAULT_TTL: 60 * 60 * 1e3,
    RETRY_DELAY: 2 * 60 * 1e3,
    RETRY_MAX_DELAY: 30 * 60 * 1e3,
    LAYER_HIST: "QLD Historical",
    QLD_HIST_SERVICE: "https://spatial-img.information.qld.gov.au/arcgis/rest/services/TimeSeries/AerialOrtho_AllUsers/ImageServer",
    QLD_HIST_PHOTOS_SERVICE: "https://spatial-img.information.qld.gov.au/arcgis/rest/services/QImagery/HistoricalAerialPhoto_AllUsers/ImageServer",
    LAYER_WATER: "Water Infrastructure",
    LAYER_FLIGHTS: "Live Flights",
    LAYER_MARINE: "Marine Vessels",
    LAYER_WAZE: "Waze Traffic",
    LAYER_MOBILE: "Mobile Coverage",
    LAYER_SEAMARKS: "OpenSeaMap",
    LAYER_INFRA: "Power Infrastructure",
    LAYER_TELECOM: "Telecoms",
    LAYER_LIGHTPOL: "Light Pollution",
    LAYER_CADASTRE: "QLD Cadastre",
    LAYER_QPWS: "QPWS Estate",
    LAYER_RELIEF: "QLD Relief",
    LAYER_NATIONAL_PARKS: "National Parks",
    LAYER_TOPO: "QLD Topo",
    LAYER_INTVL_GLOBAL: "INTVL Global Map",
    LAYER_GEOCACHING: "Geocaches",
    // Single layer-panel entry; which Development.i sublayers show
    // (dev/building/plumbing × current/decided) is picked in the on-map
    // submenu that appears while the overlay is active. Selection is
    // persisted under SCC_APPS_STATE_KEY.
    LAYER_SCC_APPS: "SCC Applications",
    SCC_APPS_STATE_KEY: "dw_scc_apps_filters",
    MODE_3D_STATE_KEY: "dw_mode_3d_on",
    OVERLAY_STATE_KEY: "dw_active_overlays",
    // Mapbox GL JS — loaded dynamically when 3D Mode is first toggled
    // on, not at script init. The borrowed token only satisfies the
    // library's init check; all our tile sources are keyless. Tiles
    // are AWS-hosted Mapzen Terrarium DEM (free, no auth, world
    // coverage to z14) decoded via Mapbox GL's built-in `terrarium`
    // encoding. Mapbox telemetry is silenced after script load.
    MAPBOX_GL_VERSION: "3.7.0",
    // No embedded Mapbox token — dynamic.watch already serves its own
    // public pk.eyJ... in the page payload (mapOptions.k[0] for /me,
    // route-thumbnail URLs everywhere); pickMapboxToken() scrapes it.
    // Geocaching.com's PUBLIC tile-based map API — same endpoints the
    // pre-2018 geocaching.com world map browsed with. No login, no
    // session cookie, no API key. `map.info` returns a UTFGrid where
    // each non-empty cell encodes a cache's code + name; `map.details
    // ?i=GC<code>` returns difficulty/terrain/container/type/owner.
    // Server filters to active + available caches only. Subdomain
    // rotation across tiles01..tiles04 distributes load across edges.
    GEOCACHING_PUBLIC_INFO: "https://tiles{s}.geocaching.com/map.info?x={x}&y={y}&z={z}",
    // The PNG tile is the legacy map's VISUAL render. We don't draw it
    // (custom markers instead), but requesting it triggers the server
    // to generate the tile, which is what populates the map.info
    // UTFGrid. Cold tiles (never recently rendered) return HTTP 204 on
    // map.info until a map.png request warms them. The warming is
    // shared across the tiles01..04 edges and persists server-side, so
    // we only pay it once per tile per cache-eviction cycle. Verified
    // empirically: map.png works with any Referer; map.info needs the
    // geocaching.com Referer; HEAD does NOT warm (must be a full GET).
    GEOCACHING_PUBLIC_PNG: "https://tiles{s}.geocaching.com/map.png?x={x}&y={y}&z={z}",
    GEOCACHING_PUBLIC_DETAILS: "https://tiles01.geocaching.com/map.details?i=",
    GEOCACHING_TILE_SUBDOMAINS: ["01", "02", "03", "04"],
    // INTVL global Mapbox Vector Tile (MVT) CDN. Each tile is a PBF
    // containing a 'territories' layer of POLYGON features with
    // properties: runId, activityId, colour, currentArea, startTime.
    // The path `/single-player/run/{z}/{x}/{y}.pbf` is the PUBLIC
    // "every runner claims their own territory" mode — the same data
    // the INTVL app shows on its main map. (The other mode at this
    // CDN is `/clubs-mode/run/...` — only for club members.)
    //
    // Native max zoom is 11. Empirically verified by probing 2x2
    // quads at each zoom: z=8..11 each return 4 distinct files per
    // quad, z=12+ return 4 identical files (server-side overzoom of
    // the z=11 parent with no scaling). If we let Leaflet request z
    // > 11 directly, the lambda returns the parent's z=11 content
    // verbatim — so the same 4096-extent polygons render in 4
    // different z=12 canvases each positioned at a different
    // geographic location, which looks like the polygons are 1/4 the
    // size they should be and produces hard seams at every z=12
    // tile boundary. Capping maxNativeZoom at 11 makes Leaflet
    // fetch one z=11 tile and CSS-scale 2x for z=12 viewing,
    // rendering each polygon once at its true location.
    INTVL_TILES_BASE: "https://d1yalngj9nsyl4.cloudfront.net/single-player/run",
    INTVL_TILES_MAX_NATIVE_Z: 11,
    // `startTime` in the territories layer is an integer DAY count, but
    // NOT days since the Unix epoch — it counts days since a custom app
    // epoch ~1977-09-03, i.e. it runs 2802 days behind the Unix day
    // number. Pinned from ground truth: a territory captured 2026-05-31
    // carries startTime 17802 (20604 − 2802). Decoding it as days since
    // 1970 (the original guess) rendered every hover date ~7.67 years
    // early (that capture showed as 2018-09-28). Verified against the
    // cuid creation timestamps embedded in activityId: the offset stays
    // in a tight ±a-few-days band across the whole data range, so the
    // unit is days (slope 1) and only the epoch was wrong. Add this back
    // before treating startTime as a Unix day number.
    INTVL_START_TIME_EPOCH_OFFSET_DAYS: 2802,
    // QLD Topo and Relief tile caches — public, no token required.
    QLD_TOPO_TILE: "https://spatial-gis.information.qld.gov.au/arcgis/rest/services/Basemaps/QldMap_Topo/MapServer/tile/{z}/{y}/{x}",
    QLD_RELIEF_TILE: "https://spatial-gis.information.qld.gov.au/arcgis/rest/services/Basemaps/QldMap_Relief/MapServer/tile/{z}/{y}/{x}",
    // Minimum zoom for QPWS hover-identify (below this, polygons too small).
    QLD_QPWS_HOVER_MIN_ZOOM: 11,
    OIM_WATER_TILES: "https://openinframap.org/map/water",
    // QLD Digital Cadastral Database via Planning Cadastre MapServer.
    // Layer 1 is the parent "Land Parcels" group — service handles
    // scale-dependent sub-layer selection (full parcels close-in,
    // generalised >10ha groupings further out).
    QLD_CADASTRE_SERVICE: "https://spatial-gis.information.qld.gov.au/arcgis/rest/services/PlanningCadastre/LandParcelPropertyFramework/MapServer",
    QLD_CADASTRE_LAYER_ID: 1,
    // Identify against this specific sublayer (Base Parcels Only) — gives
    // real lot/plan/tenure attributes rather than road-segment metadata.
    QLD_CADASTRE_IDENTIFY_LAYER: 8,
    QLD_CADASTRE_HOVER_MIN_ZOOM: 14,
    // OnTheHouse (Cotality) base URL — used by fetchOthSales for the
    // optional "Sales" lookup on the cadastre tooltip.
    OTH_BASE: "https://www.onthehouse.com.au",
    // Sunshine Coast Council development/building/plumbing applications
    // (the data behind Development.i). Point sublayers, queried as
    // GeoJSON per viewport rather than rendered via /export — the
    // server-side icons carry no attributes, the vector features do.
    //   0/1 = Development apps (in progress / decided)
    //   2/3 = Building apps    (in progress / decided)
    //   4/5 = Plumbing apps    (in progress / decided)
    SCC_APPS_SERVICE: "https://geopublic.scc.qld.gov.au/arcgis/rest/services/PlanningCadastre/Applications_SCRC/MapServer",
    // Development.i site — FilterDirect renders the map-search page and
    // applies the querystring `filters` client-side (DANumber= /
    // BANumber= / PlumbNumber= inside the encoded value).
    SCC_DEVI_BASE: "https://developmenti.sunshinecoast.qld.gov.au",
    // SCC public document repository (HPE Content Manager WebDrawer) —
    // the actual lodged application documents (forms, plans, reports,
    // decision notices). Anonymous JSON search by application number;
    // Record/{uri}/file/document serves the file directly.
    SCC_DOCS_BASE: "https://publicdocs.scc.qld.gov.au",
    // "Make a submission" landing page linked from notifying apps.
    SCC_SUBMISSION_URL: "https://haveyoursay.sunshinecoast.qld.gov.au/submissions-and-comments-development-applications",
    // QPWS estate: protected-area polygons + tracks/trails of all kinds.
    // Layer IDs in the source service:
    //   10 = Protected areas and forests   5 = Walking track
    //    6 = Great walk                    7 = Horse trail
    //    8 = Mountain bike trail           9 = Trail bike trail
    // Rendered server-side so we inherit official QPWS symbology.
    QLD_QPWS_SERVICE: "https://spatial-gis.information.qld.gov.au/arcgis/rest/services/Environment/ParksTerrestrialProtectedAreas/MapServer",
    QLD_QPWS_LAYER_IDS: "10,5,6,7,8,9",
    // OpenInfraMap public power vector-tile pyramid (MVT/pbf). Global,
    // CDN-served, derived from OSM — far more reliable than hitting raw
    // Overpass. Layers per tile: power_line, power_substation(_point),
    // power_plant(_point), power_generator(_area), power_tower. Voltages
    // are in kV and generator/plant output in MW (converted on read).
    OIM_POWER_TILES: "https://openinframap.org/map/power",
    OIM_TELECOM_TILES: "https://openinframap.org/map/telecoms",
    OIM_MAX_NATIVE_Z: 16,
    // External basemap / overlay tile URLs centralised so endpoint
    // changes happen in one place.
    GOOGLE_HYBRID_TILE: "https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}",
    STRAVA_HEATMAP_TILE: "https://content-a.strava.com/anon/globalheat/all/blue/{z}/{x}/{y}@2x.png?v=19",
    OPENSEAMAP_TILE: "https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png",
    ACCC_MOBILE_COVERAGE_SERVICE: "https://spatial.infrastructure.gov.au/server/rest/services/ACCC_Mobile_Sites_and_Coverages/MapServer",
    // lightpollutionmap.info GeoServer (WMS via GWC tile cache).
    // LAYERS=PostGIS:SB_2025 = sky brightness, latest published edition.
    // STYLES=WA = "World Atlas" colour ramp matching the official site.
    LIGHTPOL_WMS_BASE: "https://www2.lightpollutionmap.info/geoserver/gwc/service/wms",
    LIGHTPOL_WMS_LAYER: "PostGIS:SB_2025",
    LIGHTPOL_WMS_STYLE: "WA"
  };
  var BLANK_TILE = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
  var DW_LAYER_GROUPS = [
    {
      header: "Global",
      names: [
        CFG.LAYER_GOOGLE,
        CFG.LAYER_APPLE,
        CFG.LAYER_STAMEN_TERRAIN,
        CFG.LAYER_WAYBACK,
        CFG.LAYER_VEXCEL
      ]
    },
    {
      header: "Queensland",
      names: [CFG.LAYER_QLD, CFG.LAYER_HIST, CFG.LAYER_TOPO],
      shortLabels: {
        [CFG.LAYER_QLD]: "Current Imagery",
        [CFG.LAYER_HIST]: "Historical",
        [CFG.LAYER_TOPO]: "Topographic"
      }
    }
  ];
  var DW_OVERLAY_GROUPS = [
    {
      header: "Property",
      names: [CFG.LAYER_CADASTRE, CFG.LAYER_SCC_APPS, CFG.LAYER_QPWS, CFG.LAYER_RELIEF]
    },
    {
      header: "Infrastructure",
      names: [CFG.LAYER_INFRA, CFG.LAYER_TELECOM, CFG.LAYER_WATER, CFG.LAYER_MOBILE]
    },
    {
      header: "Environment",
      names: [CFG.LAYER_NATIONAL_PARKS, CFG.LAYER_LIGHTPOL, CFG.LAYER_SEAMARKS]
    },
    {
      header: "Live data",
      names: [
        CFG.LAYER_FLIGHTS,
        CFG.LAYER_MARINE,
        CFG.LAYER_WAZE,
        CFG.LAYER_INTVL_GLOBAL,
        CFG.LAYER_GEOCACHING
      ]
    },
    {
      header: "Heatmaps",
      names: [CFG.LAYER_STRAVA, CFG.LAYER_GARMIN]
    }
  ];

  // src/utils/http.js
  function gmGet(url, opts, cb) {
    if (typeof opts === "function") {
      cb = opts;
      opts = {};
    }
    opts = opts || {};
    const handle = { aborted: false, _xhr: null };
    const req = GM_xmlhttpRequest({
      method: opts.method || "GET",
      url,
      headers: opts.headers || {},
      data: opts.data,
      responseType: opts.responseType,
      timeout: opts.timeout || 25e3,
      anonymous: opts.anonymous === false ? false : true,
      onload: (r) => {
        if (handle.aborted) return;
        cb(null, r);
      },
      onerror: () => {
        if (handle.aborted) return;
        cb(new Error("network"), null);
      },
      ontimeout: () => {
        if (handle.aborted) return;
        cb(new Error("timeout"), null);
      }
    });
    handle._xhr = req;
    return handle;
  }
  function gmJsonGet(url, opts, cb) {
    if (typeof opts === "function") {
      cb = opts;
      opts = {};
    }
    opts = opts || {};
    const headers = Object.assign(
      { Accept: "application/json" },
      opts.headers || {}
    );
    return gmGet(url, Object.assign({}, opts, { headers }), (err, r) => {
      if (err) {
        cb(err, null, r);
        return;
      }
      if (r.status < 200 || r.status >= 300) {
        cb(new Error("http " + r.status), null, r);
        return;
      }
      try {
        cb(null, JSON.parse(r.responseText), r);
      } catch (e) {
        cb(new Error("parse: " + e.message), null, r);
      }
    });
  }
  function gmCancel(handle) {
    if (!handle || handle.aborted) return;
    handle.aborted = true;
    if (handle._xhr && typeof handle._xhr.abort === "function") {
      try {
        handle._xhr.abort();
      } catch (_) {
      }
    }
  }
  function wireTileAbort(gridLayer) {
    gridLayer.on("tileunload", (e) => {
      const t = e.tile;
      if (!t) return;
      if (t._dwHandle) {
        gmCancel(t._dwHandle);
        t._dwHandle = null;
      }
      if (t._dwHandles) {
        for (const h of t._dwHandles) gmCancel(h);
        t._dwHandles = null;
      }
    });
  }
  var _gmInflight = /* @__PURE__ */ new Map();
  function gmCoalesce(key, fn, cb) {
    const existing = _gmInflight.get(key);
    if (existing) {
      existing.push(cb);
      return;
    }
    const waiters = [cb];
    _gmInflight.set(key, waiters);
    fn((err, value) => {
      _gmInflight.delete(key);
      for (const w of waiters) {
        try {
          w(err, value);
        } catch (e) {
          console.error("[CustomTiles] cb error", e);
        }
      }
    });
  }
  function cachedFetch(key, ttlMs, fetcher, cb) {
    const storageKey = "dw_cache_" + key;
    try {
      const raw = GM_getValue(storageKey, null);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && (parsed.e === 0 || parsed.e > Date.now())) {
          cb(null, parsed.v);
          return;
        }
      }
    } catch (_) {
    }
    gmCoalesce(storageKey, fetcher, (err, value) => {
      if (!err && value !== void 0) {
        try {
          const expires = ttlMs > 0 ? Date.now() + ttlMs : 0;
          GM_setValue(storageKey, JSON.stringify({ v: value, e: expires }));
        } catch (_) {
        }
      }
      cb(err, value);
    });
  }
  var _CACHE_TTL = {
    CAD_ADDRESS: 30 * 24 * 3600 * 1e3,
    OTH_LOCATIONS: 7 * 24 * 3600 * 1e3,
    OTH_PROPERTY: 6 * 3600 * 1e3,
    OTH_EVENTS: 24 * 3600 * 1e3,
    SCC_DETAIL: 6 * 3600 * 1e3
  };

  // src/layers/hover-identify.js
  function arcgisIdentify(map, latlng, opts, cb) {
    const size = map.getSize();
    const b = map.getBounds();
    const mapExtent = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].join(",");
    const imageDisplay = `${size.x},${size.y},96`;
    const geometry = encodeURIComponent(JSON.stringify({
      x: latlng.lng,
      y: latlng.lat,
      spatialReference: { wkid: 4326 }
    }));
    const url = `${opts.baseUrl}/identify?geometry=${geometry}&geometryType=esriGeometryPoint&sr=4326&layers=${opts.layers}&tolerance=${opts.tolerance || 3}&mapExtent=${mapExtent}&imageDisplay=${imageDisplay}&returnGeometry=false&f=json`;
    gmJsonGet(url, (err, data) => {
      if (err) {
        cb(err, null);
        return;
      }
      cb(null, (data.results || [])[0] || null);
    });
  }
  function makeHoverIdentify(opts) {
    const debounceMs = opts.debounceMs || 200;
    return function install(layer, map) {
      const tooltip = L.tooltip({
        sticky: true,
        opacity: 0.95,
        className: opts.tipClass,
        direction: "right",
        offset: [12, 0]
      });
      let lastOid = null;
      let lastAttrs = null;
      let debounce = null;
      let gen = 0;
      const clearTip = () => {
        if (tooltip._map) tooltip.remove();
        lastOid = null;
        lastAttrs = null;
      };
      const identify = (latlng) => {
        const myGen = ++gen;
        arcgisIdentify(map, latlng, opts, (err, feat) => {
          if (err) return;
          if (myGen !== gen) return;
          if (!feat) {
            clearTip();
            return;
          }
          const attrs = feat.attributes || {};
          const oid = attrs["Object ID"] || attrs.OBJECTID || JSON.stringify(attrs);
          if (oid === lastOid && tooltip._map) {
            tooltip.setLatLng(latlng);
            return;
          }
          lastOid = oid;
          lastAttrs = attrs;
          tooltip.setLatLng(latlng).setContent(opts.formatTooltip(attrs));
          if (!tooltip._map) tooltip.addTo(map);
          if (opts.afterRender) {
            opts.afterRender(attrs, {
              isCurrent: () => myGen === gen && !!tooltip._map && lastAttrs === attrs,
              setContent: (html) => tooltip.setContent(html)
            });
          }
        });
      };
      const onMove = (e) => {
        if (map.getZoom() < opts.minZoom) {
          clearTip();
          return;
        }
        clearTimeout(debounce);
        const latlng = e.latlng;
        debounce = setTimeout(() => identify(latlng), debounceMs);
      };
      const onLeave = () => {
        clearTimeout(debounce);
        gen++;
        clearTip();
      };
      map.on("mousemove", onMove);
      map.on("mouseout", onLeave);
      layer._dwHoverOff = () => {
        clearTimeout(debounce);
        gen++;
        map.off("mousemove", onMove);
        map.off("mouseout", onLeave);
        clearTip();
      };
    };
  }

  // src/bridge/mapbox-tile-bridge.js
  var _dwMbLayers = /* @__PURE__ */ new Map();
  var _dwMbNextId = 1;
  var _dwMbHasProtocol = false;
  function hasDwMbProtocol() {
    return _dwMbHasProtocol;
  }
  function setDwMbHasProtocol(value) {
    _dwMbHasProtocol = !!value;
  }
  function dwRegisterMbLayer(lyr, fetchTile) {
    const key = "lyr" + _dwMbNextId++;
    _dwMbLayers.set(key, fetchTile);
    lyr._dwMbKey = key;
    return key;
  }
  function dwMbProtocolHandler(params) {
    const m = (params.url || "").match(/^dw:\/\/(\w+)\/(\d+)\/(\d+)\/(\d+)\b/);
    if (!m) return Promise.reject(new Error("dw://: bad url " + params.url));
    const [, key, z, x, y] = m;
    const fetchTile = _dwMbLayers.get(key);
    if (!fetchTile) return Promise.reject(new Error("dw://: no layer " + key));
    return Promise.resolve().then(() => fetchTile(+z, +x, +y)).then((data) => ({ data }));
  }
  function dwMbFetchAB(url) {
    return fetch(url, { credentials: "omit" }).then((r) => {
      if (!r.ok) throw new Error("HTTP " + r.status + " " + url);
      return r.arrayBuffer();
    });
  }
  function dwMbGmFetchAB(url, opts) {
    return new Promise((resolve, reject) => {
      gmGet(url, { responseType: "arraybuffer", ...opts || {} }, (err, r) => {
        if (err) return reject(err);
        if (!r || r.status >= 400) return reject(new Error("HTTP " + (r?.status || "?") + " " + url));
        resolve(r.response);
      });
    });
  }
  var DW_TILE_PREFIX = "https://dwtile.local/";
  var DW_TRANSPARENT_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
  function dwTileSentinel(key) {
    return `${DW_TILE_PREFIX}${key}/{z}/{x}/{y}.png`;
  }
  var _dwTileBlobs = /* @__PURE__ */ new Map();
  var _dwTileInflight = /* @__PURE__ */ new Set();
  var _dwTileFailed = /* @__PURE__ */ new Map();
  var DW_TILE_FAIL_RETRY_MS = 60 * 1e3;
  var DW_TILE_BLOB_MAX = 600;
  function _dwTileFailedRecently(cacheKey) {
    const at = _dwTileFailed.get(cacheKey);
    return at != null && Date.now() - at < DW_TILE_FAIL_RETRY_MS;
  }
  function _dwTileEvict() {
    while (_dwTileBlobs.size > DW_TILE_BLOB_MAX) {
      const first = _dwTileBlobs.keys().next().value;
      const url = _dwTileBlobs.get(first);
      _dwTileBlobs.delete(first);
      setTimeout(() => {
        try {
          URL.revokeObjectURL(url);
        } catch (_) {
        }
      }, 30 * 1e3);
    }
  }

  // src/utils/html.js
  function _escHtml(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function esc(strings, ...values) {
    let out = strings[0];
    for (let i = 0; i < values.length; i++) {
      out += _escHtml(values[i]) + strings[i + 1];
    }
    return out;
  }
  function _safeColor(c, fallback) {
    fallback = fallback || "#888";
    if (typeof c !== "string") return fallback;
    const s = c.trim();
    return /^#[0-9a-f]{3,8}$/i.test(s) || /^(?:rgb|rgba|hsl|hsla)\([0-9.,%\s/]+\)$/i.test(s) || /^[a-z]{3,20}$/i.test(s) ? s : fallback;
  }
  function _fmtPrice(n) {
    if (!isFinite(n) || n <= 0) return "";
    if (n >= 1e6) return "$" + (n / 1e6).toFixed(n % 1e6 ? 2 : 1) + "M";
    if (n >= 1e3) return "$" + Math.round(n / 1e3) + "k";
    return "$" + n;
  }
  function _fmtDate(s) {
    if (!s) return "";
    const m = /^(\d{4})-(\d{2})/.exec(String(s));
    if (!m) return String(s);
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return months[parseInt(m[2], 10) - 1] + " " + m[1];
  }

  // src/utils/intvl.js
  function hexAlpha(hex, a) {
    const m = /^#([0-9a-f]{6})$/i.exec(hex);
    if (!m) return hex;
    const v = parseInt(m[1], 16);
    return `rgba(${v >> 16 & 255},${v >> 8 & 255},${v & 255},${a})`;
  }
  function pointInRing(px, py, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1];
      const xj = ring[j][0], yj = ring[j][1];
      const intersect = yi > py !== yj > py && px < (xj - xi) * (py - yi) / (yj - yi + 1e-12) + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  }
  function intvlActivityTime(activityId) {
    if (typeof activityId !== "string" || activityId.length < 9 || activityId[0] !== "c") return null;
    const ms = parseInt(activityId.slice(1, 9), 36);
    if (!Number.isFinite(ms) || ms < Date.UTC(2018, 0, 1) || ms > Date.now() + 864e5) return null;
    return new Date(ms);
  }
  function intvlAgo(date) {
    if (!(date instanceof Date) || isNaN(date)) return "";
    const days = Math.floor((Date.now() - date.getTime()) / 864e5);
    if (days < 0) return "";
    if (days === 0) return "today";
    if (days === 1) return "yesterday";
    if (days < 30) return days + " days ago";
    const months = Math.floor(days / 30);
    if (months < 12) return months + (months === 1 ? " month" : " months") + " ago";
    const years = Math.floor(days / 365);
    const rem = Math.floor((days - years * 365) / 30);
    return years + "y" + (rem ? " " + rem + "mo" : "") + " ago";
  }
  function intvlArea(m2) {
    const v = Number(m2) || 0;
    if (v < 1e5) return Math.round(v).toLocaleString() + " m²";
    const km2 = v / 1e6;
    return (km2 < 10 ? km2.toFixed(2) : km2.toFixed(1)) + " km²";
  }

  // src/runtime/mode-3d.js
  var pageWin = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
  function pickMapboxToken() {
    if (pageWin.mapboxgl?.accessToken && /^pk\./.test(pageWin.mapboxgl.accessToken)) {
      return pageWin.mapboxgl.accessToken;
    }
    try {
      const html = document.documentElement.outerHTML;
      const m = html.match(/pk\.eyJ[A-Za-z0-9._-]{30,}/);
      if (m) return m[0];
    } catch (_) {
    }
    return "pk.no-mapbox-tiles-needed";
  }
  function ensureMapboxLoaded() {
    const win = pageWin;
    if (win.mapboxgl) return Promise.resolve(win.mapboxgl);
    if (!ensureMapboxLoaded._p) {
      ensureMapboxLoaded._p = new Promise((resolve, reject) => {
        if (!document.getElementById("dw-mb-css")) {
          const link = document.createElement("link");
          link.id = "dw-mb-css";
          link.rel = "stylesheet";
          link.href = `https://api.mapbox.com/mapbox-gl-js/v${CFG.MAPBOX_GL_VERSION}/mapbox-gl.css`;
          document.head.appendChild(link);
        }
        const script = document.createElement("script");
        script.src = `https://api.mapbox.com/mapbox-gl-js/v${CFG.MAPBOX_GL_VERSION}/mapbox-gl.js`;
        script.onload = () => {
          if (win.mapboxgl) {
            try {
              if (win.mapboxgl.config) win.mapboxgl.config.EVENTS_URL = null;
              if (typeof win.mapboxgl.setTelemetryEnabled === "function") win.mapboxgl.setTelemetryEnabled(false);
            } catch (e) {
            }
            try {
              if (typeof win.mapboxgl.addProtocol === "function") {
                const handler = typeof exportFunction === "function" ? exportFunction(dwMbProtocolHandler, win, { allowCrossOriginArguments: true }) : dwMbProtocolHandler;
                win.mapboxgl.addProtocol("dw", handler);
                setDwMbHasProtocol(true);
              } else {
                console.info(
                  "[CustomTiles] mapboxgl.addProtocol unavailable in this build (v" + (win.mapboxgl.version || "?") + " — Mapbox v3 dropped it); Stamen / QLD Historical / Garmin Heatmap render in 3D via the transformRequest blob bridge instead."
                );
              }
            } catch (e) {
              console.warn("[CustomTiles] addProtocol failed:", e.message);
            }
            resolve(win.mapboxgl);
          } else reject(new Error("mapboxgl global missing after load"));
        };
        script.onerror = () => reject(new Error("script tag load failed"));
        document.head.appendChild(script);
      });
    }
    return ensureMapboxLoaded._p;
  }
  var Mode3DController = class {
    constructor(app) {
      this._app = app;
      this._active = false;
      this._loading = false;
      this._mbMap = null;
      this._mbContainer = null;
      this._handler3DMove = null;
      this._baseTracker = null;
    }
    isActive() {
      return this._active || this._loading;
    }
    enable(map) {
      if (this._active || this._loading) return;
      const stale = document.getElementById("dw-mb-container");
      if (stale && stale.parentNode) stale.parentNode.removeChild(stale);
      this._loading = true;
      this._gen = (this._gen || 0) + 1;
      const myGen = this._gen;
      ensureMapboxLoaded().then((mapboxgl) => {
        if (myGen !== this._gen) return;
        this._loading = false;
        this._mount(map);
        this._initMbMap(map, mapboxgl);
        this._wireMarkerCache(map);
        this._wireSync(map);
        this._wireBasemapTracker(map);
        this._active = true;
        console.info("[CustomTiles] 3D Mode enabled");
      }).catch((e) => {
        if (myGen !== this._gen) return;
        this._loading = false;
        console.error(
          "[CustomTiles] 3D Mode: failed to load mapbox-gl-js:",
          e.message
        );
      });
    }
    disable(map) {
      if (this._loading) {
        this._gen = (this._gen || 0) + 1;
        this._loading = false;
        const stale = document.getElementById("dw-mb-container");
        if (stale && stale.parentNode) stale.parentNode.removeChild(stale);
        return;
      }
      if (!this._active) return;
      clearTimeout(this._dwReloadTimer);
      this._unwireBasemapTracker(map);
      this._unwireSync(map);
      this._unwireMarkerObserver();
      this._unwireMarkerCache(map);
      this._unpatchLeafletProjection();
      if (this._mbMap) {
        try {
          this._mbMap.remove();
        } catch (_) {
        }
        this._mbMap = null;
      }
      this._popup = null;
      this._hoverBound = null;
      if (this._pendingRetry) {
        clearTimeout(this._pendingRetry);
        this._pendingRetry = null;
      }
      this._pendingRetryCount = 0;
      this._unmount(map);
      this._active = false;
      console.info("[CustomTiles] 3D Mode disabled");
    }
    _mount(map) {
      this._hiddenPanes = [];
      this._hideHiddenable(map);
      if (!document.getElementById("dw-mb-container")) {
        const root = map.getContainer();
        const div = document.createElement("div");
        div.id = "dw-mb-container";
        div.style.cssText = "position:absolute;top:0;left:0;width:100%;height:100%;z-index:200;pointer-events:auto;";
        if (root.firstChild) root.insertBefore(div, root.firstChild);
        else root.appendChild(div);
        this._mbContainer = div;
      } else {
        this._mbContainer = document.getElementById("dw-mb-container");
      }
    }
    // Walk all panes and hide the ones we shouldn't render in 3D.
    // Idempotent — call from `_mount` AND from every resync so
    // panes created AFTER 3D was enabled (user toggles INTVL or
    // flips a custom-canvas layer mid-session) get hidden too.
    _hideHiddenable(map) {
      if (!document.getElementById("dw-3d-hide-styles")) {
        const css = document.createElement("style");
        css.id = "dw-3d-hide-styles";
        css.textContent = `
				.dw-3d-active .leaflet-tile-pane,
				.dw-3d-active .leaflet-overlay-pane,
				.dw-3d-active .leaflet-shadow-pane,
				.dw-3d-active .leaflet-tooltip-pane,
				.dw-3d-active [class*="leaflet-pane"][class*="dw"] {
					opacity: 0 !important;
				}
			`;
        document.head.appendChild(css);
      }
      map.getContainer().classList.add("dw-3d-active");
      this._hiddenPanes ?? (this._hiddenPanes = []);
      const tracked = new Set(this._hiddenPanes.map((p) => p.name));
      const hide = (name) => {
        if (tracked.has(name)) return;
        const pane = map.getPane(name);
        if (!pane) return;
        this._hiddenPanes.push({ name, prev: pane.style.opacity });
        pane.style.opacity = "0";
        tracked.add(name);
      };
      hide("tilePane");
      hide("overlayPane");
      hide("shadowPane");
      hide("tooltipPane");
      for (const key of Object.keys(map._panes || {})) {
        if (key.startsWith("dw")) hide(key);
      }
    }
    _unmount(map) {
      for (const el of document.querySelectorAll("#dw-mb-container")) {
        el.parentNode?.removeChild(el);
      }
      this._mbContainer = null;
      map.getContainer().classList.remove("dw-3d-active");
      for (const entry of this._hiddenPanes || []) {
        const pane = map.getPane(entry.name);
        if (pane) pane.style.opacity = entry.prev || "";
      }
      this._hiddenPanes = null;
      map.eachLayer((lyr) => {
        if (!(lyr instanceof L.Marker)) return;
        const el = lyr._icon || lyr.getElement?.();
        if (el) el.style.removeProperty("transform");
      });
      try {
        map.fire("viewreset");
      } catch (_) {
      }
    }
    _initMbMap(map, mapboxgl) {
      const sources = {
        "mapbox-dem": {
          type: "raster-dem",
          url: "mapbox://mapbox.mapbox-terrain-dem-v1",
          tileSize: 512,
          maxzoom: 14
        }
      };
      const layers = [
        { id: "bg", type: "background", paint: { "background-color": "#c8c4b8" } }
      ];
      const base = this._activeBaseTiles(map);
      if (base) {
        sources["active-base"] = {
          type: "raster",
          tiles: base.tiles,
          tileSize: 256,
          maxzoom: base.maxzoom
        };
        layers.push({
          id: "active-base",
          type: "raster",
          source: "active-base",
          paint: { "raster-fade-duration": 0 }
        });
      } else {
        console.info(
          "[CustomTiles] 3D Mode: no URL-template basemap on map; showing bare terrain. Switch to Google Hybrid / QLD Globe / MapTiler for draped imagery."
        );
      }
      layers.push({
        id: "sky",
        type: "sky",
        paint: { "sky-type": "atmosphere" }
      });
      const c = map.getCenter();
      const z = map.getZoom();
      const mbMap = new mapboxgl.Map({
        container: this._mbContainer,
        accessToken: pickMapboxToken(),
        style: {
          version: 8,
          sources,
          layers,
          // Mapbox's default font CDN — required so any symbol
          // layer we later add (distance labels, geocache code
          // pins, plane callsigns) can render text. The borrowed
          // token has access; if it ever rotates to a fonts-
          // restricted scope, the text layers silently 404 and
          // glyphs stay empty, but other layers still render.
          glyphs: "mapbox://fonts/mapbox/{fontstack}/{range}.pbf"
        },
        center: [c.lng, c.lat],
        zoom: Math.max(0, z - 1),
        // Mapbox zoom is offset 1 below Leaflet
        pitch: 60,
        // Tilt for the actual 3D effect
        bearing: 0,
        antialias: true,
        attributionControl: false,
        // Mapbox owns gestures while 3D is on: drag pans, scroll
        // zooms, right-drag (or ctrl+drag) rotates/pitches.
        // Leaflet's edit controls are hidden anyway (overlay +
        // marker panes opacity 0), so there's no conflict.
        interactive: true,
        dragRotate: true,
        touchPitch: true,
        // Bridge for GM-fetcher-backed raster sources (Stamen,
        // QLD Historical, Garmin) — intercepts our sentinel tile
        // URLs and serves blobs fetched via GM_xmlhttpRequest.
        // Replaces the dead dw:// addProtocol path on Mapbox v3.
        transformRequest: (url, resourceType) => this._dwTransformRequest(url, resourceType)
      });
      mbMap.on("style.load", () => {
        mbMap.setTerrain({ source: "mapbox-dem", exaggeration: 1.5 });
        try {
          mbMap.resize();
        } catch (_) {
        }
        this._syncOverlays(map, mbMap);
        this._renderLeafletShapes(map, mbMap);
        this._renderRoute(map, mbMap);
        this._wireHoverPopups(mapboxgl, mbMap);
        this._syncMarkersToMapbox(map, mbMap);
        this._wireMarkerObserver(map, mbMap);
        this._wireRoutePathObserver(map, mbMap);
      });
      this._mbMap = mbMap;
      this._wiredClick = /* @__PURE__ */ new Set();
      this._lastRouteSig = null;
      this._isMoving = false;
      this._markerPanePrevVis = null;
      this._syncRequested = false;
      this._patchLeafletProjection(map);
      try {
        pageWin._dwMb = mbMap;
        pageWin._dwMbBase = base;
        pageWin._dwMap = map;
        pageWin._dw3D = this;
        pageWin._dwRegistry = _dwMbLayers;
      } catch (_) {
      }
    }
    // Extract dynamic.watch's route polyline(s) + waypoint markers
    // from Leaflet, return as GeoJSON. Walks every layer on the map
    // — picks up the SVG path Leaflet uses for the route line plus
    // every L.Marker (start/end/insert points + distance labels) by
    // reading their `_latlngs` / `getLatLng()` directly. Marker
    // colour is sniffed from the icon's CSS class (`circle red` →
    // red, `circle lightgreen` → start, `dist-marker` → numbered).
    _extractRouteGeojson(map) {
      const lineFeatures = [];
      const pointFeatures = [];
      map.eachLayer((lyr) => {
        if (lyr instanceof L.Polyline && !(lyr instanceof L.Polygon)) {
          const latlngs = lyr.getLatLngs?.();
          if (!latlngs) return;
          const flat = (Array.isArray(latlngs[0]) ? latlngs.flat(Infinity) : latlngs).filter((p) => p && typeof p.lat === "number");
          if (flat.length < 2) return;
          lineFeatures.push({
            type: "Feature",
            geometry: { type: "LineString", coordinates: flat.map((p) => [p.lng, p.lat]) },
            properties: {
              color: lyr.options?.color || "#9400D3",
              weight: Math.min(lyr.options?.weight || 5, 8)
            }
          });
        } else if (lyr instanceof L.Marker) {
          const p = lyr.getLatLng?.();
          if (!p) return;
          const el = lyr.getElement?.() || lyr._icon;
          const cls = el?.className || "";
          let color = null, radius = 9, label = "";
          if (cls.includes("dist-marker")) {
            color = "#9400D3";
            radius = 7;
            label = (el.textContent || el.title || "").trim();
          } else if (cls.includes("lightgreen")) color = "#7fd14b";
          else if (cls.includes(" red")) color = "#ff3030";
          else if (cls.includes(" blue")) color = "#3b82f6";
          else if (cls.includes(" white")) color = "#ffffff";
          else if (cls.includes("transparent")) return;
          else return;
          pointFeatures.push({
            type: "Feature",
            geometry: { type: "Point", coordinates: [p.lng, p.lat] },
            properties: { color, radius, label }
          });
        }
      });
      return {
        line: { type: "FeatureCollection", features: lineFeatures },
        points: { type: "FeatureCollection", features: pointFeatures }
      };
    }
    // Run `fn` as soon as the Mapbox style is ready, guarded so a
    // callback scheduled while 3D was active never fires after
    // disable(). Mapbox flips `isStyleLoaded()` to false transiently
    // whenever a source/layer is added (base swap, overlay mirror),
    // and several of our sync entry points run right after such a
    // mutation. The OLD code guarded those entry points with an
    // early `return` on `!isStyleLoaded` — which silently DROPPED the
    // work with no retry. That was the root cause of both:
    //   • shape overlays enabled before 3D never mirroring, and
    //   • base-layer switches not updating the 3D imagery when made
    //     before the previous layer finished rendering.
    // Deferring to the next `idle` (with a timeout fallback in case
    // idle never fires) makes the work happen instead of vanish.
    _runWhenStyleReady(mb, fn) {
      const go = () => {
        if (this._active && this._mbMap === mb && mb.getStyle?.()) fn();
      };
      if (mb.isStyleLoaded && mb.isStyleLoaded()) {
        go();
        return;
      }
      let fired = false;
      const once = () => {
        if (fired) return;
        fired = true;
        go();
      };
      try {
        mb.once("idle", once);
      } catch (_) {
      }
      setTimeout(once, 1200);
    }
    // Walk every L.Path / L.Marker on the map, group by pane, and
    // render each group as one or more Mapbox GeoJSON layers. This
    // is how Geocaches, Live Flights, Marine Vessels, National
    // Parks, OIM Power / Telecoms / Water all get into 3D —
    // they're all Leaflet shapes underneath. Live-data panes
    // (Flights/Vessels) refresh by replacing their child layers,
    // which fires layeradd/layerremove → our debounced _fullResync
    // picks it up within 40 ms.
    _renderLeafletShapes(map, mbMap) {
      if (!mbMap.isStyleLoaded || !mbMap.isStyleLoaded()) {
        if (!this._shapesRetryPending) {
          this._shapesRetryPending = true;
          this._runWhenStyleReady(mbMap, () => {
            this._shapesRetryPending = false;
            this._renderLeafletShapes(map, mbMap);
          });
        }
        return;
      }
      const byPane = /* @__PURE__ */ new Map();
      const bucket = (pane) => {
        let b = byPane.get(pane);
        if (!b) {
          b = { lines: [], polygons: [], points: [] };
          byPane.set(pane, b);
        }
        return b;
      };
      const visit = (lyr) => {
        if (lyr instanceof L.LayerGroup) {
          lyr.eachLayer(visit);
          return;
        }
        handle(lyr);
      };
      const handle = (lyr) => {
        const opts = lyr.options || {};
        const pane = opts.pane;
        if (!pane) return;
        if (pane === "tilePane" || pane === "overlayPane" || pane === "markerPane" || pane === "mapPane" || pane === "tooltipPane" || pane === "popupPane" || pane === "shadowPane") return;
        if (lyr instanceof L.Polygon) {
          const ll = lyr.getLatLngs();
          if (!ll || !ll.length) return;
          const isLatLng = (x) => x && typeof x.lat === "number";
          let coordinates, type;
          if (isLatLng(ll[0])) {
            coordinates = [ll.map((p) => [p.lng, p.lat])];
            coordinates[0].push(coordinates[0][0]);
            type = "Polygon";
          } else if (isLatLng(ll[0]?.[0])) {
            coordinates = ll.map((ring) => {
              const c = ring.map((p) => [p.lng, p.lat]);
              c.push(c[0]);
              return c;
            });
            type = "Polygon";
          } else {
            coordinates = ll.map((poly) => poly.map((ring) => {
              const c = ring.map((p) => [p.lng, p.lat]);
              c.push(c[0]);
              return c;
            }));
            type = "MultiPolygon";
          }
          bucket(pane).polygons.push({
            type: "Feature",
            geometry: { type, coordinates },
            properties: {
              color: opts.color || "#888",
              fillColor: opts.fillColor || opts.color || "#888",
              fillOpacity: opts.fillOpacity != null ? opts.fillOpacity : 0.25,
              opacity: opts.opacity != null ? opts.opacity : 0.9,
              weight: opts.weight || 1
            }
          });
        } else if (lyr instanceof L.Polyline) {
          const ll = lyr.getLatLngs();
          if (!ll || !ll.length) return;
          const flat = (Array.isArray(ll[0]) ? ll.flat(Infinity) : ll).filter((p) => p && typeof p.lat === "number");
          if (flat.length < 2) return;
          bucket(pane).lines.push({
            type: "Feature",
            geometry: { type: "LineString", coordinates: flat.map((p) => [p.lng, p.lat]) },
            properties: {
              color: opts.color || "#888",
              opacity: opts.opacity != null ? opts.opacity : 1,
              weight: opts.weight || 2
            }
          });
        } else if (lyr instanceof L.CircleMarker || lyr instanceof L.Circle) {
          const p = lyr.getLatLng?.();
          if (!p) return;
          bucket(pane).points.push({
            type: "Feature",
            geometry: { type: "Point", coordinates: [p.lng, p.lat] },
            properties: {
              color: opts.fillColor || opts.color || "#888",
              radius: opts.radius || 5
            }
          });
        } else if (lyr instanceof L.Marker) {
          const p = lyr.getLatLng?.();
          if (!p) return;
          const el = lyr.getElement?.() || lyr._icon;
          const cls = el?.className || "";
          const dwData = lyr._dwData || null;
          const paneColor = {
            dwGeocachingPane: "#2da44e",
            dwFlightsPane: "#0066ff",
            dwMarinePane: "#00a3c9",
            dwWazePane: "#33ccff",
            dwInfraPane: "#F0A500",
            dwTelecomPane: "#7C3AED",
            dwWaterPane: "#0EA5E9"
          }[pane] || "#888";
          bucket(pane).points.push({
            type: "Feature",
            geometry: { type: "Point", coordinates: [p.lng, p.lat] },
            properties: {
              color: dwData?.color || paneColor,
              radius: dwData?.radius || 5,
              label: dwData?.label || "",
              url: dwData?.url || "",
              kind: dwData?.kind || "",
              // Full data for hover popups. Mapbox JSON-
              // serialises feature properties, so primitives
              // only — booleans + strings + numbers.
              name: dwData?.name || "",
              code: dwData?.code || "",
              diff: dwData?.diff,
              terr: dwData?.terr,
              favs: dwData?.favs,
              size: dwData?.size || "",
              owner: dwData?.owner || "",
              found: !!dwData?.found,
              dnf: !!dwData?.dnf,
              className: cls
            }
          });
        }
      };
      map.eachLayer(visit);
      const oldIds = this._shapeIds || [];
      for (const id of oldIds) {
        try {
          if (mbMap.getLayer(id)) mbMap.removeLayer(id);
        } catch (_) {
        }
      }
      for (const id of oldIds) {
        try {
          if (mbMap.getSource(id)) mbMap.removeSource(id);
        } catch (_) {
        }
      }
      this._shapeIds = [];
      const beforeId = mbMap.getLayer("dw-route-line") ? "dw-route-line" : mbMap.getLayer("sky") ? "sky" : void 0;
      for (const [pane, b] of byPane) {
        if (b.polygons.length) {
          const id = `dw-shapes-poly-${pane}`;
          mbMap.addSource(id, {
            type: "geojson",
            data: { type: "FeatureCollection", features: b.polygons }
          });
          mbMap.addLayer({
            id,
            type: "fill",
            source: id,
            paint: {
              "fill-color": ["coalesce", ["get", "fillColor"], "#888"],
              "fill-opacity": ["coalesce", ["get", "fillOpacity"], 0.25]
            }
          }, beforeId);
          this._shapeIds.push(id);
          const outlineId = id + "-outline";
          mbMap.addLayer({
            id: outlineId,
            type: "line",
            source: id,
            paint: {
              "line-color": ["coalesce", ["get", "color"], "#888"],
              "line-width": ["coalesce", ["get", "weight"], 1],
              "line-opacity": ["coalesce", ["get", "opacity"], 0.9],
              "line-emissive-strength": 1
            }
          }, beforeId);
          this._shapeIds.push(outlineId);
        }
        if (b.lines.length) {
          const id = `dw-shapes-line-${pane}`;
          mbMap.addSource(id, {
            type: "geojson",
            data: { type: "FeatureCollection", features: b.lines }
          });
          mbMap.addLayer({
            id,
            type: "line",
            source: id,
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
              "line-color": ["coalesce", ["get", "color"], "#888"],
              "line-width": ["coalesce", ["get", "weight"], 2],
              "line-opacity": ["coalesce", ["get", "opacity"], 1],
              "line-emissive-strength": 1
            }
          }, beforeId);
          this._shapeIds.push(id);
        }
        if (b.points.length) {
          const id = `dw-shapes-point-${pane}`;
          mbMap.addSource(id, {
            type: "geojson",
            data: { type: "FeatureCollection", features: b.points }
          });
          mbMap.addLayer({
            id,
            type: "circle",
            source: id,
            paint: {
              "circle-radius": ["coalesce", ["get", "radius"], 5],
              "circle-color": ["coalesce", ["get", "color"], "#888"],
              "circle-stroke-width": 1,
              "circle-stroke-color": "#ffffff",
              "circle-emissive-strength": 1
            }
          }, beforeId);
          this._shapeIds.push(id);
          const labelId = id + "-label";
          mbMap.addLayer({
            id: labelId,
            type: "symbol",
            source: id,
            filter: ["all", ["has", "label"], ["!=", ["get", "label"], ""]],
            layout: {
              "text-field": ["get", "label"],
              "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
              "text-size": 9,
              "text-allow-overlap": true,
              "text-ignore-placement": true
            },
            paint: {
              "text-color": "#ffffff",
              "text-halo-color": "#000",
              "text-halo-width": 1,
              "text-emissive-strength": 1
            }
          }, beforeId);
          this._shapeIds.push(labelId);
          if (!this._wiredClick) this._wiredClick = /* @__PURE__ */ new Set();
          if (!this._wiredClick.has(id)) {
            this._wiredClick.add(id);
            mbMap.on("click", id, (e) => {
              const url = e.features?.[0]?.properties?.url;
              if (url && /^https:\/\//i.test(url)) {
                window.open(url, "_blank", "noopener,noreferrer");
              }
            });
            mbMap.on("mouseenter", id, () => {
              mbMap.getCanvas().style.cursor = "pointer";
            });
            mbMap.on("mouseleave", id, () => {
              mbMap.getCanvas().style.cursor = "";
            });
          }
        }
      }
    }
    // Add Mapbox sources + layers for the route + waypoints. Idempotent
    // — safe to call multiple times; existing layers/sources are
    // dropped first. Uses `*-emissive-strength: 1` so the line and
    // points stay vivid against the 3D-lit terrain.
    // Mapbox-side hover popups for the feature layers we render —
    // INTVL territories (vector fill), geocaches / flights /
    // vessels (point circles). Wires `mousemove`/`mouseleave` per
    // layer ID; each layer's formatter pulls the right fields out
    // of the feature properties. Idempotent — if popups are
    // already set up, just rebinds the formatters.
    _wireHoverPopups(mapboxgl, mbMap) {
      if (!this._popup) {
        this._popup = new mapboxgl.Popup({
          closeButton: false,
          closeOnClick: false,
          className: "dw-mb-popup",
          offset: 12
        });
      }
      const popup = this._popup;
      const bind = (layerId, fmt) => {
        if (!mbMap.getLayer(layerId)) return;
        if (!this._hoverBound) this._hoverBound = /* @__PURE__ */ new Set();
        if (this._hoverBound.has(layerId)) return;
        this._hoverBound.add(layerId);
        mbMap.on("mousemove", layerId, (e) => {
          if (!e.features?.length) return;
          const html = fmt(e.features[0]);
          if (!html) return;
          popup.setLngLat(e.lngLat).setHTML(html).addTo(mbMap);
          mbMap.getCanvas().style.cursor = "pointer";
        });
        mbMap.on("mouseleave", layerId, () => {
          popup.remove();
          mbMap.getCanvas().style.cursor = "";
        });
      };
      bind("dw-cust-0-fill", (f) => {
        const p = f.properties || {};
        const swatch = p.colour ? `<span style="display:inline-block;width:12px;height:12px;background:${_safeColor(p.colour, "#3b82f6")};border:1px solid #888;vertical-align:middle;margin-right:6px;"></span>` : "";
        const area = p.currentArea != null ? intvlArea(p.currentArea) : "?";
        const dt = p.activityId ? intvlActivityTime(p.activityId) : null;
        const ago = dt ? intvlAgo(dt) : "";
        return `${swatch}<b>${area}</b>` + (ago ? `<br><span style="font-size:11px;color:#666">${ago}</span>` : "");
      });
      bind("dw-shapes-point-dwGeocachingPane", (f) => {
        const p = f.properties || {};
        if (!p.name && !p.code) return "";
        const lines = [`<b>${_escHtml(p.name || p.code)}</b>` + (p.found ? " ✓" : p.dnf ? " ✗" : "")];
        const meta = [];
        if (p.code) meta.push(_escHtml(p.code));
        if (p.diff != null && p.terr != null) meta.push(esc`D ${p.diff} / T ${p.terr}`);
        if (p.size) meta.push(_escHtml(String(p.size)));
        if (p.favs) meta.push(`♥ ${p.favs}`);
        if (meta.length) lines.push(
          `<span style="font-size:11px;color:#666">${meta.join(" · ")}</span>`
        );
        if (p.owner) lines.push(
          `<span style="font-size:11px;color:#666">by ${_escHtml(p.owner)}</span>`
        );
        return lines.join("<br>");
      });
      bind("dw-shapes-point-dwFlightsPane", (f) => {
        const p = f.properties || {};
        return _escHtml(p.label || p.name || "Aircraft");
      });
      bind("dw-shapes-point-dwMarinePane", (f) => {
        const p = f.properties || {};
        return _escHtml(p.label || p.name || "Vessel");
      });
      bind("dw-shapes-point-dwWazePane", (f) => {
        const p = f.properties || {};
        return _escHtml(p.name || p.label || "Waze report");
      });
    }
    _renderRoute(map, mbMap) {
      if (!mbMap.getStyle?.()) {
        requestAnimationFrame(() => this._renderRoute(map, mbMap));
        return;
      }
      const { line } = this._extractRouteGeojson(map);
      const sig = line.features.map((f) => {
        const c = f.geometry.coordinates;
        const n = c.length;
        if (!n) return "0";
        const fst = c[0], lst = c[n - 1], mid = c[n >> 1];
        return `${n}:${fst[0]},${fst[1]}|${mid[0]},${mid[1]}|${lst[0]},${lst[1]}`;
      }).join(";");
      if (sig === this._lastRouteSig) return;
      this._lastRouteSig = sig;
      for (const id of ["dw-route-line", "dw-route-points", "dw-route-labels"]) {
        try {
          if (mbMap.getLayer(id)) mbMap.removeLayer(id);
        } catch (_) {
        }
      }
      for (const id of ["dw-route-line", "dw-route-points"]) {
        try {
          if (mbMap.getSource(id)) mbMap.removeSource(id);
        } catch (_) {
        }
      }
      const beforeId = mbMap.getLayer("sky") ? "sky" : void 0;
      mbMap.addSource("dw-route-line", { type: "geojson", data: line });
      mbMap.addLayer({
        id: "dw-route-line",
        type: "line",
        source: "dw-route-line",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": ["coalesce", ["get", "color"], "#9400D3"],
          "line-width": ["coalesce", ["get", "weight"], 6],
          "line-opacity": 0.9,
          "line-emissive-strength": 1
        }
      }, beforeId);
    }
    // Hook layer-internal events that should trigger a re-sync.
    // Used by QLD Historical's `capturechange` (scrubber moved) so
    // the 3D mirror swaps to the new mosaicRule URL. Idempotent —
    // listeners are tracked per (layer, event) pair so we don't
    // double-hook on repeat syncs.
    _wireReloadEvents(map, mbMap) {
      if (!this._reloadHooks) this._reloadHooks = /* @__PURE__ */ new WeakSet();
      map.eachLayer((lyr) => {
        const events = lyr._dwMb3DReloadOn;
        if (!events || !events.length) return;
        if (this._reloadHooks.has(lyr)) return;
        this._reloadHooks.add(lyr);
        const handler = () => {
          if (!this._mbMap) return;
          this._fullResync(map, this._mbMap);
        };
        for (const evt of events) {
          try {
            lyr.on(evt, handler);
          } catch (_) {
          }
        }
      });
    }
    // Inspect a single L.TileLayer and return a Mapbox-ready
    // raster-source spec, or null if it can't be mirrored. Handles
    // subdomain substitution per the layer's own options.subdomains
    // (Google uses "0123", OSM uses "abc", etc.) and the {r} retina
    // flag MapTiler-style templates expose.
    _layerToMbSpec(lyr) {
      if (!lyr) return null;
      const opts = lyr.options || {};
      const paneEl = opts.pane ? lyr._map?.getPane(opts.pane) : null;
      const zIndex = parseInt(paneEl?.style.zIndex || "200", 10) || 200;
      let isBase = !opts.pane || opts.pane === "tilePane";
      const ctrl = this._app?._ctrl;
      if (ctrl?._layers) {
        const entry = ctrl._layers.find((l) => l.layer === lyr);
        if (entry) isBase = !entry.overlay;
      }
      const base = {
        maxzoom: opts.maxNativeZoom || opts.maxZoom || 22,
        opacity: typeof opts.opacity === "number" ? opts.opacity : 1,
        zIndex,
        isBase
      };
      if (lyr._dwMb3DStyle) return null;
      if (typeof lyr._dwMb3DGetUrl === "function") {
        const url2 = lyr._dwMb3DGetUrl();
        if (url2) return { ...base, url: url2 };
        this._hadPendingGetter = true;
        return null;
      }
      if (lyr._dwMb3DUrl) {
        return { ...base, url: lyr._dwMb3DUrl };
      }
      if (lyr._dwMbKey) {
        const url2 = hasDwMbProtocol() ? `dw://${lyr._dwMbKey}/{z}/{x}/{y}.png` : dwTileSentinel(lyr._dwMbKey);
        return { ...base, url: url2 };
      }
      if (!(lyr instanceof L.TileLayer)) return null;
      const url = lyr._url;
      if (typeof url !== "string" || url.length < 5) return null;
      if (!/\{z\}/.test(url)) return null;
      if (!/\{[xy]\}/.test(url)) return null;
      const subs = opts.subdomains;
      const sub = Array.isArray(subs) ? subs[0] : typeof subs === "string" && subs.length ? subs[0] : "a";
      let cleaned = url.replace(/\{s\}/g, sub).replace(/\{r\}/g, "@2x");
      if (/\{[^}]+\}/.test(cleaned.replace(/\{[xyz]\}/g, ""))) return null;
      return { ...base, url: cleaned };
    }
    // --- transformRequest bridge (see DW_TILE_PREFIX block) ----------
    // Called by Mapbox for every resource request. Non-sentinel URLs
    // pass through untouched; sentinel tile URLs are served from the
    // GM-fetched blob cache (or a transparent placeholder while the
    // fetch is in flight).
    _dwTransformRequest(url, resourceType) {
      if (!url || url.lastIndexOf(DW_TILE_PREFIX, 0) !== 0) {
        return { url };
      }
      const path = url.slice(DW_TILE_PREFIX.length).split("?")[0];
      const m = path.match(/^([^/]+)\/(\d+)\/(\d+)\/(\d+)/);
      if (!m) return { url: DW_TRANSPARENT_PNG };
      const key = m[1], z = +m[2], x = +m[3], y = +m[4];
      const cacheKey = `${key}/${z}/${x}/${y}`;
      const blob = _dwTileBlobs.get(cacheKey);
      if (blob) return { url: blob };
      if (!_dwTileFailedRecently(cacheKey)) this._dwWarmTile(key, z, x, y, cacheKey);
      return { url: DW_TRANSPARENT_PNG };
    }
    // Fire the registered GM fetcher for a sentinel tile, cache the
    // resulting blob, and debounce a source reload so Mapbox
    // re-requests it (now served from cache). Failures are remembered
    // so a permanently-404 tile doesn't loop.
    _dwWarmTile(key, z, x, y, cacheKey) {
      if (_dwTileInflight.has(cacheKey) || _dwTileBlobs.has(cacheKey)) return;
      const fetcher = _dwMbLayers.get(key);
      if (!fetcher) {
        _dwTileFailed.set(cacheKey, Date.now());
        return;
      }
      _dwTileInflight.add(cacheKey);
      Promise.resolve().then(() => fetcher(z, x, y)).then((ab) => {
        _dwTileInflight.delete(cacheKey);
        if (!ab) {
          _dwTileFailed.set(cacheKey, Date.now());
          return;
        }
        _dwTileFailed.delete(cacheKey);
        const blobUrl = URL.createObjectURL(
          new Blob([ab], { type: "image/png" })
        );
        _dwTileBlobs.set(cacheKey, blobUrl);
        _dwTileEvict();
        this._dwTilesDirty = true;
        this._scheduleTileReload();
      }).catch(() => {
        _dwTileInflight.delete(cacheKey);
        _dwTileFailed.set(cacheKey, Date.now());
        if (this._dwTilesDirty) this._scheduleTileReload();
      });
    }
    // Draw newly-warmed blobs by re-requesting each sentinel-backed
    // raster source's tiles (a cache-busting `?r=N` forces Mapbox to
    // treat them as new; transformRequest strips the query when
    // matching, so the blob cacheKey is stable).
    //
    // CRITICAL: a `setTiles` puts the source back into "loading", which
    // flips `isStyleLoaded()` false until the (fast, local) blobs load.
    // Other 3D sync paths gate on isStyleLoaded, so reloading on every
    // tile completion would keep the style perpetually unloaded during
    // a warm storm. So we DEFER the reload until the warm storm drains
    // (no fetches in flight), then reload once. New tiles requested
    // after that (edge pans, the reload re-requesting) warm + schedule
    // the next drain-reload, so it stays progressive across views while
    // each individual view settles cleanly.
    _scheduleTileReload() {
      clearTimeout(this._dwReloadTimer);
      this._dwReloadTimer = setTimeout(() => {
        const mb = this._mbMap;
        if (!this._active || !mb || !mb.getStyle?.()) return;
        if (_dwTileInflight.size > 0) {
          this._scheduleTileReload();
          return;
        }
        if (!this._dwTilesDirty) return;
        this._dwTilesDirty = false;
        const sources = mb.getStyle().sources || {};
        const r = this._dwReloadCounter = (this._dwReloadCounter || 0) + 1;
        for (const [id, src] of Object.entries(sources)) {
          const t = src && src.tiles && src.tiles[0];
          if (src.type !== "raster" || !t || t.lastIndexOf(DW_TILE_PREFIX, 0) !== 0) continue;
          const base = t.split("?")[0];
          const s = mb.getSource(id);
          if (s && s.setTiles) {
            try {
              s.setTiles([`${base}?r=${r}`]);
            } catch (_) {
            }
          }
        }
      }, 300);
    }
    // Find the active base layer (lowest-z TileLayer in default
    // tilePane). Used by the basemap-tracker swap path.
    _activeBaseTiles(map) {
      let found = null;
      map.eachLayer((lyr) => {
        if (found) return;
        const spec = this._layerToMbSpec(lyr);
        if (!spec || !spec.isBase) return;
        found = { tiles: [spec.url], maxzoom: spec.maxzoom };
      });
      return found;
    }
    // Walk every active TileLayer and return all that can be
    // mirrored, sorted by pane z-index (ascending = bottom-up draw
    // order in Mapbox).
    _extractOverlayLayers(map) {
      const overlays = [];
      map.eachLayer((lyr) => {
        const spec = this._layerToMbSpec(lyr);
        if (!spec || spec.isBase) return;
        overlays.push(spec);
      });
      overlays.sort((a, b) => a.zIndex - b.zIndex);
      return overlays;
    }
    // Drop every previously-mirrored overlay, then re-add the
    // currently active ones. Called on layeradd/layerremove so
    // toggling a Leaflet layer mirrors live into the 3D scene.
    _syncOverlays(map, mbMap) {
      if (!this._inFullResync) this._hadPendingGetter = false;
      return this._syncOverlaysImpl(map, mbMap);
    }
    _syncOverlaysImpl(map, mbMap) {
      if (!mbMap) return;
      if (!mbMap.getStyle?.()) {
        requestAnimationFrame(() => this._syncOverlaysImpl(map, mbMap));
        return;
      }
      this._hideHiddenable(map);
      this._wireReloadEvents(map, mbMap);
      const oldIds = this._overlayIds || [];
      for (const id of oldIds) {
        try {
          if (mbMap.getLayer(id)) mbMap.removeLayer(id);
        } catch (_) {
        }
      }
      for (const id of oldIds) {
        try {
          if (mbMap.getSource(id)) mbMap.removeSource(id);
        } catch (_) {
        }
      }
      this._overlayIds = [];
      const beforeId = mbMap.getLayer("dw-route-line") ? "dw-route-line" : mbMap.getLayer("sky") ? "sky" : void 0;
      const specs = this._extractOverlayLayers(map);
      specs.forEach((spec, i) => {
        const id = `dw-overlay-${i}`;
        try {
          mbMap.addSource(id, {
            type: "raster",
            tiles: [spec.url],
            tileSize: 256,
            maxzoom: spec.maxzoom
          });
          mbMap.addLayer({
            id,
            type: "raster",
            source: id,
            paint: {
              "raster-opacity": spec.opacity,
              "raster-fade-duration": 0,
              // Make the raster emit at full strength so
              // Mapbox's terrain-lighting model doesn't
              // dim it. Without this, an overlay with
              // the same opacity as the 2D version (0.8
              // for Strava) looks ~40% darker in 3D
              // because the terrain shader treats it
              // like an unlit surface. emissive=1 makes
              // the raster behave like a self-lit decal
              // — colors come through as designed.
              "raster-emissive-strength": 1
            }
          }, beforeId);
          this._overlayIds.push(id);
        } catch (e) {
          console.warn("[CustomTiles] 3D overlay mirror failed:", spec.url, e.message);
        }
      });
      let cIdx = 0;
      map.eachLayer((lyr) => {
        const style = lyr?._dwMb3DStyle;
        if (!style) return;
        const prefix = `dw-cust-${cIdx++}`;
        const srcMap = {};
        for (const [k, src] of Object.entries(style.sources || {})) {
          const id = `${prefix}-${k}`;
          srcMap[k] = id;
          try {
            mbMap.addSource(id, src);
            this._overlayIds.push(id);
          } catch (e) {
            console.warn("[CustomTiles] 3D custom source:", id, e.message);
          }
        }
        for (const layer of style.layers || []) {
          const layerId = `${prefix}-${layer.id}`;
          const layerSpec = { ...layer, id: layerId };
          if (layer.source && srcMap[layer.source]) {
            layerSpec.source = srcMap[layer.source];
          }
          try {
            mbMap.addLayer(layerSpec, beforeId);
            this._overlayIds.push(layerId);
          } catch (e) {
            console.warn("[CustomTiles] 3D custom layer:", layerId, e.message);
          }
        }
      });
      if (!this._hadPendingGetter) {
        this._pendingRetryCount = 0;
      } else if (!this._pendingRetry) {
        this._pendingRetryCount = (this._pendingRetryCount || 0) + 1;
        if (this._pendingRetryCount <= 5) {
          this._pendingRetry = setTimeout(() => {
            this._pendingRetry = null;
            if (this._active && this._mbMap) {
              const mb = this._mbMap;
              this._runWhenStyleReady(mb, () => this._fullResync(map, mb));
            }
          }, 3e3);
        }
      }
    }
    // Bi-directional viewport sync. The `_syncing` flag prevents the
    // ping-pong: when our handler programmatically moves one map, the
    // other map's resulting `moveend` is ignored.
    // While 3D is on, the camera can be tilted + rotated but
    // Leaflet's marker positioning is flat (north-up Mercator).
    // Without this sync, waypoints + distance labels drift away
    // from where they should land on the tilted terrain as the
    // user pitches or orbits. Override each marker's CSS
    // `transform` to whatever Mapbox would project it to, taking
    // the parent mapPane's translate into account so the position
    // is expressed in mapPane's local coordinate frame.
    //
    // Performance: this runs on every Mapbox `move` frame plus
    // MutationObserver and body-class triggers — easily 60Hz×N
    // during a zoom animation. Two optimisations:
    //   1. `_markerCache` is a Set populated on layeradd /
    //      layerremove so we don't walk `map.eachLayer` (which
    //      iterates EVERY layer, including 100s of OIM polylines)
    //      on every sync.
    //   2. `_requestMarkerSync` rAF-batches multiple triggers
    //      down to one sync per browser paint.
    _syncMarkersToMapbox(map, mbMap) {
      const mapPane = map.getPane("mapPane");
      if (!mapPane) return;
      const mapPanePos = map._getMapPanePos?.() || L.point(0, 0);
      const tx = mapPanePos.x, ty = mapPanePos.y;
      const cache = this._markerCache;
      if (!cache) return;
      const toPrune = [];
      for (const lyr of cache) {
        if (!lyr._map) {
          toPrune.push(lyr);
          continue;
        }
        const el = lyr._icon || lyr.getElement?.();
        if (!el || !el.parentNode) {
          toPrune.push(lyr);
          continue;
        }
      }
      for (const lyr of toPrune) cache.delete(lyr);
      const elevProj = (lng, lat) => mbMap.project([lng, lat]);
      this._elevProj = elevProj;
      for (const lyr of cache) {
        const el = lyr._icon || lyr.getElement?.();
        if (!el) continue;
        const latlng = lyr.getLatLng?.();
        if (!latlng) continue;
        const point = elevProj(latlng.lng, latlng.lat);
        const px = Math.round(point.x - tx);
        const py = Math.round(point.y - ty);
        el.style.transform = `translate3d(${px}px, ${py}px, 0)`;
        el._leaflet_pos = L.point(px, py);
      }
    }
    // Coalesces multiple sync triggers per frame down to one.
    // Triggered by Mapbox `move`, MutationObserver, body-class
    // observer — all can fire several times per frame during a
    // drag or zoom animation. Without batching, every trigger
    // re-walks the marker cache + Mapbox-projects each one.
    _requestMarkerSync(map, mbMap) {
      if (this._syncRequested) return;
      this._syncRequested = true;
      requestAnimationFrame(() => {
        this._syncRequested = false;
        if (this._active && this._mbMap === mbMap) {
          this._syncMarkersToMapbox(map, mbMap);
        }
      });
    }
    // Populate / maintain the marker cache. On enable: one walk
    // of `map.eachLayer` to seed. After that, layeradd / layerremove
    // listeners keep it in sync — far cheaper than re-walking the
    // whole map per Mapbox frame.
    //
    // Every add/remove also schedules a marker sync so a newly-
    // added marker gets Mapbox-projected immediately rather than
    // sitting at Leaflet's flat position until the next Mapbox
    // move event fires. This is the fix for the
    // "open an existing route, 3D auto-enables, waypoints stuck at
    // the 2D ground positions until you rotate" symptom.
    _wireMarkerCache(map) {
      this._markerCache = /* @__PURE__ */ new Set();
      map.eachLayer((lyr) => {
        if (lyr instanceof L.Marker) this._markerCache.add(lyr);
      });
      this._onMarkerAdd = (e) => {
        if (!(e.layer instanceof L.Marker)) return;
        this._markerCache.add(e.layer);
        if (this._active && this._mbMap) {
          this._requestMarkerSync(map, this._mbMap);
        }
      };
      this._onMarkerRemove = (e) => {
        if (!(e.layer instanceof L.Marker)) return;
        this._markerCache.delete(e.layer);
        if (this._active && this._mbMap) {
          this._requestMarkerSync(map, this._mbMap);
        }
      };
      map.on("layeradd", this._onMarkerAdd);
      map.on("layerremove", this._onMarkerRemove);
    }
    _unwireMarkerCache(map) {
      if (this._onMarkerAdd) map.off("layeradd", this._onMarkerAdd);
      if (this._onMarkerRemove) map.off("layerremove", this._onMarkerRemove);
      this._onMarkerAdd = this._onMarkerRemove = null;
      this._markerCache = null;
    }
    // Override Leaflet's flat (2D Mercator) `layerPointToLatLng`
    // and `containerPointToLatLng` to use Mapbox's terrain-aware
    // `unproject` while 3D is active. This is the inverse of
    // `_syncMarkersToMapbox` (which projects latLng → screen
    // pixels via Mapbox). Without it:
    //   • Tapping at the top of the 3D view places a waypoint
    //     wherever Leaflet's flat unproject lands (much closer
    //     than the terrain pixel the user actually tapped).
    //   • Dragging a marker stores `marker._latlng` via Leaflet's
    //     flat layerPointToLatLng — so the moment the drag ends
    //     and the marker re-syncs through Mapbox.project, it
    //     jumps to a different terrain position than where it
    //     was released.
    // Both fix transparently: dynamic.watch's planner reads
    // `e.latlng` from `map.click`, which chains through the
    // patched methods.
    _patchLeafletProjection(map) {
      if (this._unpatchProj) return;
      const controller = this;
      const origCPtoLL = map.containerPointToLatLng.bind(map);
      const origLPtoLL = map.layerPointToLatLng.bind(map);
      const project = (sx, sy) => {
        const mb = controller._mbMap;
        const canvas = mb.getCanvas?.();
        const w = canvas?.clientWidth || 0;
        const h = canvas?.clientHeight || 0;
        if (sx < 0 || sy < 0 || w && sx > w || h && sy > h) return null;
        const ll = mb.unproject([sx, sy]);
        if (!ll || !isFinite(ll.lat) || !isFinite(ll.lng)) return null;
        if (Math.abs(ll.lat) > 85 || Math.abs(ll.lng) > 180) return null;
        return L.latLng(ll.lat, ll.lng);
      };
      map.containerPointToLatLng = function(point) {
        if (controller._active && controller._mbMap) {
          try {
            const ll = project(point.x, point.y);
            if (ll) return ll;
          } catch (_) {
          }
        }
        return origCPtoLL(point);
      };
      map.layerPointToLatLng = function(point) {
        if (controller._active && controller._mbMap) {
          try {
            const pp = map._getMapPanePos?.() || L.point(0, 0);
            const ll = project(point.x + pp.x, point.y + pp.y);
            if (ll) return ll;
          } catch (_) {
          }
        }
        return origLPtoLL(point);
      };
      this._unpatchProj = () => {
        map.containerPointToLatLng = origCPtoLL;
        map.layerPointToLatLng = origLPtoLL;
        this._unpatchProj = null;
      };
    }
    _unpatchLeafletProjection() {
      if (this._unpatchProj) this._unpatchProj();
    }
    // MutationObserver on markerPane re-applies the Mapbox sync
    // every time Leaflet mutates a marker's `style` attribute —
    // drag, zoom, or programmatic setLatLng all trigger it.
    // Without this hook, dragging a waypoint leaves it visually
    // stranded at Leaflet's flat-projection position. The
    // `syncing` flag prevents our own override from triggering
    // the observer in an infinite loop.
    //
    // IMPORTANT exception: while Leaflet is mid-drag (`document
    // .body.leaflet-dragging` class is set), we DO NOT sync.
    // Letting our Mapbox projection win during drag makes the
    // marker follow a curved path instead of the cursor — the
    // mouse moves linearly through Leaflet's flat coordinate
    // space, but Mapbox-projecting each frame's flat-derived
    // latLng pushes the icon onto a non-linear trajectory. A
    // second observer on `document.body` re-syncs the moment
    // the drag class clears, so the marker lands in the right
    // 3D spot once the user releases.
    _wireMarkerObserver(map, mbMap) {
      if (this._markerObserver) return;
      const markerPane = map.getPane("markerPane");
      if (!markerPane) return;
      let syncing = false;
      const isDragging = () => document.body.classList.contains("leaflet-dragging");
      this._markerObserver = new MutationObserver(() => {
        if (syncing || !this._mbMap) return;
        if (isDragging()) return;
        syncing = true;
        try {
          this._requestMarkerSync(map, mbMap);
        } finally {
          requestAnimationFrame(() => {
            syncing = false;
          });
        }
      });
      this._markerObserver.observe(markerPane, {
        attributes: true,
        subtree: true,
        attributeFilter: ["style"]
      });
      this._bodyObserver = new MutationObserver((muts) => {
        if (!this._mbMap) return;
        for (const m of muts) {
          const wasDragging = m.oldValue?.includes("leaflet-dragging");
          const nowDragging = isDragging();
          if (wasDragging && !nowDragging) {
            this._requestMarkerSync(map, mbMap);
            return;
          }
        }
      });
      this._bodyObserver.observe(document.body, {
        attributes: true,
        attributeOldValue: true,
        attributeFilter: ["class"]
      });
    }
    _unwireMarkerObserver() {
      if (this._markerObserver) {
        this._markerObserver.disconnect();
        this._markerObserver = null;
      }
      if (this._bodyObserver) {
        this._bodyObserver.disconnect();
        this._bodyObserver = null;
      }
      if (this._routePathObserver) {
        this._routePathObserver.disconnect();
        this._routePathObserver = null;
      }
      if (this._routePathDebounce) {
        clearTimeout(this._routePathDebounce);
        this._routePathDebounce = null;
      }
    }
    // Watch for route SVG path mutations. Leaflet's L.Polyline
    // `setLatLngs(...)` updates the SVG path's `d` attribute in
    // place — no `layeradd` / `layerremove` event fires, so our
    // existing tracker never knows the route changed (a removed
    // waypoint leaves the Mapbox-rendered line drawn through the
    // deleted point). Observing the `d` attribute on every path
    // in overlayPane catches every in-place edit and triggers a
    // debounced re-render.
    _wireRoutePathObserver(map, mbMap) {
      if (this._routePathObserver) return;
      const overlayPane = map.getPane("overlayPane");
      if (!overlayPane) return;
      this._routePathObserver = new MutationObserver(() => {
        if (!this._mbMap || !this._active) return;
        clearTimeout(this._routePathDebounce);
        this._routePathDebounce = setTimeout(() => {
          this._routePathDebounce = null;
          if (this._active && this._mbMap === mbMap) {
            this._renderRoute(map, mbMap);
          }
        }, 80);
      });
      this._routePathObserver.observe(overlayPane, {
        attributes: true,
        subtree: true,
        attributeFilter: ["d"]
      });
    }
    _wireSync(map) {
      this._handler3DMoveStart = () => {
        this._isMoving = true;
        const p = map.getPane("markerPane");
        if (p && this._markerPanePrevVis == null) {
          this._markerPanePrevVis = p.style.visibility || "";
          p.style.visibility = "hidden";
        }
      };
      this._handler3DMove = () => {
        try {
          const c = this._mbMap.getCenter();
          const z = this._mbMap.getZoom();
          map.setView(
            [c.lat, c.lng],
            Math.round(z + 1),
            { animate: false }
          );
          if (!this._isMoving) {
            this._syncMarkersToMapbox(map, this._mbMap);
          }
        } catch (_) {
        }
      };
      this._handler3DMoveEnd = () => {
        this._isMoving = false;
        const p = map.getPane("markerPane");
        if (p && this._markerPanePrevVis != null) {
          p.style.visibility = this._markerPanePrevVis;
          this._markerPanePrevVis = null;
        }
        try {
          this._syncMarkersToMapbox(map, this._mbMap);
        } catch (_) {
        }
      };
      this._handlerResize = () => {
        if (!this._mbMap) return;
        try {
          this._mbMap.resize();
        } catch (_) {
        }
      };
      this._mbMap.on("movestart", this._handler3DMoveStart);
      this._mbMap.on("move", this._handler3DMove);
      this._mbMap.on("moveend", this._handler3DMoveEnd);
      map.on("resize", this._handlerResize);
    }
    _unwireSync(map) {
      if (this._mbMap) {
        try {
          if (this._handler3DMoveStart) this._mbMap.off("movestart", this._handler3DMoveStart);
        } catch (_) {
        }
        try {
          if (this._handler3DMove) this._mbMap.off("move", this._handler3DMove);
        } catch (_) {
        }
        try {
          if (this._handler3DMoveEnd) this._mbMap.off("moveend", this._handler3DMoveEnd);
        } catch (_) {
        }
      }
      if (this._handlerResize) {
        map.off("resize", this._handlerResize);
      }
      const p = map.getPane?.("markerPane");
      if (p && this._markerPanePrevVis != null) {
        p.style.visibility = this._markerPanePrevVis;
        this._markerPanePrevVis = null;
      }
      this._isMoving = false;
      this._handler3DMoveStart = this._handler3DMove = null;
      this._handler3DMoveEnd = this._handlerResize = null;
    }
    // Track Leaflet layer toggles. Split into two re-sync paths:
    //
    //   1. Tile/base/vector layer changes → `_fullResync` (heavy:
    //      wipes overlay raster sources and re-adds, which makes
    //      Mapbox refetch every tile). Trigger only when the
    //      changed layer is something we actually mirror as a
    //      Mapbox source — never for transient hover markers,
    //      route SVG vertex pings, or popup pane churn.
    //   2. Shape/marker layer changes (route edits, live-data
    //      poll, vector decode arriving) → lightweight
    //      `_renderLeafletShapes` + `_renderRoute` re-run. These
    //      just rebuild the GeoJSON sources; no raster reload.
    //
    // Without this split, dynamic.watch's mouseover hover-indicator
    // layer toggling on every mouse-enter/leave was triggering a
    // full overlay reload — the user-reported "tileset keeps
    // reloading whenever the mouse leaves the window" bug.
    _wireBasemapTracker(map) {
      let heavyDebounce = null, lightDebounce = null;
      const needsFullResync = (lyr) => {
        if (!lyr) return false;
        if (lyr instanceof L.TileLayer) return true;
        if (lyr._dwMb3DStyle) return true;
        if (lyr._dwMbKey) return true;
        return false;
      };
      const aliveCheck = (mb) => this._active && this._mbMap === mb && mb.getStyle?.();
      this._baseTracker = (e) => {
        const mb = this._mbMap;
        if (!mb) return;
        this._hideHiddenable(map);
        const isBase = e?.type === "baselayerchange";
        const wantsFull = isBase || needsFullResync(e?.layer);
        if (wantsFull) {
          clearTimeout(heavyDebounce);
          heavyDebounce = setTimeout(() => {
            if (!aliveCheck(mb)) return;
            this._runWhenStyleReady(mb, () => this._fullResync(map, mb));
          }, 80);
        } else {
          clearTimeout(lightDebounce);
          lightDebounce = setTimeout(() => {
            if (!aliveCheck(mb)) return;
            this._runWhenStyleReady(mb, () => {
              this._renderLeafletShapes(map, mb);
              this._renderRoute(map, mb);
            });
          }, 80);
        }
      };
      this._baseTrackerTimers = () => {
        clearTimeout(heavyDebounce);
        clearTimeout(lightDebounce);
      };
      map.on("baselayerchange layeradd layerremove", this._baseTracker);
    }
    // Swap the active base + re-mirror all overlays + redraw the
    // route. The base goes via setTiles() if available, otherwise a
    // remove-and-re-add. All wrapped in try/catch because Mapbox v3
    // throws on a stale-source mutation if the user is toggling
    // rapidly.
    _fullResync(map, mb) {
      this._hadPendingGetter = false;
      this._inFullResync = true;
      try {
        const t = this._activeBaseTiles(map);
        if (mb.getLayer("active-base")) mb.removeLayer("active-base");
        if (mb.getSource("active-base")) mb.removeSource("active-base");
        if (t) {
          mb.addSource("active-base", {
            type: "raster",
            tiles: t.tiles,
            tileSize: 256,
            maxzoom: t.maxzoom
          });
          const allLayers = mb.getStyle().layers;
          const bgIdx = allLayers.findIndex((l) => l.id === "bg");
          const afterBgId = allLayers[bgIdx + 1]?.id;
          mb.addLayer({
            id: "active-base",
            type: "raster",
            source: "active-base",
            paint: { "raster-fade-duration": 0 }
          }, afterBgId);
        }
      } catch (e) {
        console.warn("[CustomTiles] 3D basemap swap failed:", e.message);
      }
      this._syncOverlays(map, mb);
      this._renderLeafletShapes(map, mb);
      this._renderRoute(map, mb);
      try {
        const want = [
          "bg",
          "active-base",
          ...this._overlayIds || [],
          ...this._shapeIds || [],
          "dw-route-line",
          "sky"
        ];
        for (let i = 0; i < want.length - 1; i++) {
          const id = want[i], next = want[i + 1];
          if (mb.getLayer(id) && mb.getLayer(next)) {
            mb.moveLayer(id, next);
          }
        }
        if (mb.getLayer("sky")) mb.moveLayer("sky");
      } catch (_) {
      }
      this._inFullResync = false;
    }
    _unwireBasemapTracker(map) {
      if (this._baseTracker) {
        map.off("baselayerchange layeradd layerremove", this._baseTracker);
        this._baseTracker = null;
      }
      if (this._baseTrackerTimers) {
        this._baseTrackerTimers();
        this._baseTrackerTimers = null;
      }
    }
  };
  var Mode3DButton = class {
    static attach(map, controller) {
      const tryMount = () => {
        const row = document.querySelector(".leaflet-planner-controls");
        if (!row || row.querySelector(".dw-3d-btn")) return false;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "btn btn-default fixed-width dw-3d-btn";
        btn.id = "dw-3d-btn";
        btn.title = "Toggle 3D terrain";
        btn.setAttribute("aria-pressed", "false");
        btn.innerHTML = '<i class="fa fa-cube"></i>';
        const distance = row.querySelector(".distance");
        if (distance) row.insertBefore(btn, distance);
        else row.appendChild(btn);
        btn.addEventListener("click", (e) => {
          e.preventDefault();
          const turningOn = !controller.isActive();
          if (turningOn) {
            controller.enable(map);
            btn.classList.add("active");
            btn.setAttribute("aria-pressed", "true");
          } else {
            controller.disable(map);
            btn.classList.remove("active");
            btn.setAttribute("aria-pressed", "false");
          }
          GM_setValue(CFG.MODE_3D_STATE_KEY, turningOn);
        });
        if (GM_getValue(CFG.MODE_3D_STATE_KEY, false)) {
          setTimeout(() => {
            if (controller.isActive()) return;
            controller.enable(map);
            btn.classList.add("active");
            btn.setAttribute("aria-pressed", "true");
          }, 300);
        }
        return true;
      };
      if (tryMount()) return;
      const obs = new MutationObserver(() => {
        if (tryMount()) {
          obs.disconnect();
          clearTimeout(timeoutId);
        }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      const timeoutId = setTimeout(() => {
        if (document.querySelector(".dw-3d-btn")) return;
        obs.disconnect();
        console.warn(
          "[CustomTiles] 3D button not injected after 15s — couldn't find `.leaflet-planner-controls` in dynamic.watch's DOM. The site likely renamed or restructured its planner toolbar. Please file an issue at https://github.com/CalculatedCausality/dynamicWatch-Custom-Tiles/issues with a screenshot + browser version. The userscript will continue running, only the 3D toggle is affected."
        );
      }, 15e3);
    }
  };

  // src/ui/layer-manager-ui.js
  var LayerManagerUI = class {
    constructor(ctrl) {
      this._ctrl = ctrl;
    }
    // -- Archive persistence ------------------------------------------
    getArchived() {
      try {
        return new Set(
          JSON.parse(localStorage.getItem(CFG.ARCHIVE_KEY) || "[]")
        );
      } catch (e) {
        return /* @__PURE__ */ new Set();
      }
    }
    saveArchived(set) {
      localStorage.setItem(CFG.ARCHIVE_KEY, JSON.stringify([...set]));
    }
    toggleArchived(name, archive) {
      const set = this.getArchived();
      archive ? set.add(name) : set.delete(name);
      this.saveArchived(set);
    }
    // -- Leaflet control helpers --------------------------------------
    _getBaseLayers() {
      return this._ctrl._layers.filter((l) => !l.overlay);
    }
    _getActiveLayerName() {
      const m = this._ctrl._map;
      if (!m) return null;
      for (const item of this._getBaseLayers()) {
        if (m.hasLayer(item.layer)) return item.name;
      }
      return null;
    }
    _getLabelForName(name) {
      const container = this._ctrl.getContainer();
      if (!container) return null;
      const base = container.querySelector(".leaflet-control-layers-base");
      if (!base) return null;
      for (const label of base.querySelectorAll("label")) {
        if (!label.querySelector("input[type=radio]")) continue;
        if (label.dataset.dwName === name) return label;
        const span = label.querySelector("span");
        if (span && span.textContent.trim() === name) return label;
      }
      return null;
    }
    applyArchived() {
      const archived = this.getArchived();
      for (const item of this._getBaseLayers()) {
        const label = this._getLabelForName(item.name);
        if (label) label.style.display = archived.has(item.name) ? "none" : "";
      }
      const container = this._ctrl.getContainer();
      if (!container) return;
      const base = container.querySelector(".leaflet-control-layers-base");
      if (!base) return;
      for (const grp of base.querySelectorAll(".dw-layer-group")) {
        const all = [...grp.querySelectorAll("label")];
        grp.style.display = all.length && all.every((l) => l.style.display === "none") ? "none" : "";
      }
    }
    // -- Manage-layers button and panel -------------------------------
    addManageButton() {
      const container = this._ctrl.getContainer();
      if (!container) return;
      const base = container.querySelector(".leaflet-control-layers-base");
      if (!base || base.querySelector(".dw-manage-btn")) return;
      const wrap = document.createElement("div");
      wrap.className = "dw-manage-btn";
      wrap.innerHTML = '<a href="#" class="dw-manage-link">&#9881;&#160;Manage layers</a>';
      base.appendChild(wrap);
      wrap.querySelector("a").addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.openPanel();
      });
    }
    openPanel() {
      const container = this._ctrl.getContainer();
      const base = container.querySelector(".leaflet-control-layers-base");
      const titleBar = container.querySelector(".title-bar");
      if (!base) return;
      const archived = this.getArchived();
      const activeName = this._getActiveLayerName();
      const items = this._getBaseLayers();
      for (const child of base.children) {
        child.dataset.dwDisplay = child.style.display;
        child.style.display = "none";
      }
      const origTitle = titleBar ? titleBar.textContent : null;
      if (titleBar) titleBar.textContent = "Manage Layers";
      const buildRow = (item, displayName) => {
        const isActive = item.name === activeName;
        const checked = !archived.has(item.name);
        const chkId = "dw-chk-" + item.name.replace(/[^a-z0-9]/gi, "_");
        return `<label class="dw-manager-row${isActive ? " dw-manager-row--active" : ""}"><input type="checkbox" id="${_escHtml(chkId)}" data-name="${_escHtml(item.name)}"` + (checked ? " checked" : "") + (isActive ? ' disabled title="Switch to another layer before archiving this one"' : "") + `><span class="dw-manager-name">${_escHtml(displayName || item.name)}</span>` + (isActive ? '<span class="dw-badge">active</span>' : "") + "</label>";
      };
      const usedNames = /* @__PURE__ */ new Set();
      let rows = "";
      for (const group of DW_LAYER_GROUPS) {
        const groupItems = items.filter((it) => group.names.includes(it.name));
        if (!groupItems.length) continue;
        rows += `<div class="dw-manager-group-hd">${_escHtml(group.header)}</div>`;
        rows += `<div class="dw-manager-group">`;
        for (const item of groupItems) {
          usedNames.add(item.name);
          const short = group.shortLabels && group.shortLabels[item.name];
          rows += buildRow(item, short);
        }
        rows += `</div>`;
      }
      for (const item of items) {
        if (!usedNames.has(item.name)) rows += buildRow(item, null);
      }
      const panel = document.createElement("div");
      panel.className = "dw-manager-panel";
      panel.innerHTML = `<p class="dw-manager-hint">Uncheck a layer to hide it from the map&#8209;type selector.</p><div class="dw-manager-list">${rows}</div><div class="dw-manager-footer"><a href="#" class="dw-back-link">&#8592;&#160;Back</a></div>`;
      base.appendChild(panel);
      panel.querySelector(".dw-manager-list").addEventListener("change", (e) => {
        if (e.target.type !== "checkbox") return;
        const name = e.target.getAttribute("data-name");
        if (name) this.toggleArchived(name, !e.target.checked);
      });
      panel.querySelector(".dw-back-link").addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.closePanel(panel, origTitle);
      });
    }
    closePanel(panel, origTitle) {
      const container = this._ctrl.getContainer();
      const base = container.querySelector(".leaflet-control-layers-base");
      const titleBar = container.querySelector(".title-bar");
      if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
      if (titleBar && origTitle !== null) titleBar.textContent = origTitle;
      for (const child of base.children) {
        if ("dwDisplay" in child.dataset) {
          child.style.display = child.dataset.dwDisplay;
          delete child.dataset.dwDisplay;
        }
      }
      this.applyArchived();
    }
    setup() {
      setTimeout(() => {
        this.applyArchived();
        this.addManageButton();
      }, 0);
    }
  };

  // src/utils/tile-geometry.js
  function tileToBBox4326(z, x, y) {
    const n = Math.pow(2, z);
    const lon1 = x / n * 360 - 180;
    const lon2 = (x + 1) / n * 360 - 180;
    const lat1 = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI;
    const lat2 = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / n))) * 180 / Math.PI;
    return { minLon: lon1, minLat: lat2, maxLon: lon2, maxLat: lat1 };
  }
  function utfGridCellToLatLng(z, tx, ty, cx, cy) {
    const px = (cx + 0.5) / 64;
    const py = (cy + 0.5) / 64;
    const n = Math.pow(2, z);
    const lon = (tx + px) / n * 360 - 180;
    const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (ty + py) / n))) * 180 / Math.PI;
    return [lat, lon];
  }
  var _MERC_ORIGIN = 200375083428e-4;
  var _MERC_FULL = 2 * _MERC_ORIGIN;
  function tileToBBox3857(z, x, y) {
    const n = Math.pow(2, z);
    const tw = _MERC_FULL / n;
    const west = -_MERC_ORIGIN + x * tw;
    const east = west + tw;
    const north = _MERC_ORIGIN - y * tw;
    const south = north - tw;
    return { west, south, east, north };
  }

  // src/layers/provider-factories.js
  var LayerProvider = class {
    /** @returns {L.Layer} */
    create() {
      throw new Error(`${this.constructor.name}.create() not implemented`);
    }
  };
  function _overzoomPlacement(x, y, depth, size) {
    const scale = Math.pow(2, depth);
    const qx = (x % scale + scale) % scale;
    const qy = (y % scale + scale) % scale;
    return {
      scale,
      imgSize: size * scale,
      offsetX: -(qx * size),
      offsetY: -(qy * size)
    };
  }
  function _overzoomUrl(layer, x, y, z) {
    const o = layer.options;
    let ty = y;
    if (o.tms) ty = (1 << z) - 1 - y;
    const data = L.Util.extend({
      r: o.detectRetina && L.Browser.retina && o.maxZoom > 0 ? "@2x" : "",
      s: layer._getSubdomain({ x, y, z }),
      x,
      y: ty,
      z
    }, o);
    return L.Util.template(layer._url, data);
  }
  function wireOverzoomFallback(layer, fallbackOpts) {
    fallbackOpts = fallbackOpts || {};
    const minLevel = fallbackOpts.minLevel != null ? fallbackOpts.minLevel : 0;
    layer.createTile = function(coords, done) {
      const size = this.getTileSize();
      const cell = document.createElement("div");
      cell.style.width = size.x + "px";
      cell.style.height = size.y + "px";
      cell.style.overflow = "hidden";
      const img = document.createElement("img");
      img.setAttribute("role", "presentation");
      img.alt = "";
      if (this.options.crossOrigin || this.options.crossOrigin === "") {
        img.crossOrigin = this.options.crossOrigin === true ? "" : this.options.crossOrigin;
      }
      cell.appendChild(img);
      let depth = 0;
      const place = () => {
        const p = _overzoomPlacement(coords.x, coords.y, depth, size.x);
        img.style.width = p.imgSize + "px";
        img.style.height = size.y * p.scale + "px";
        img.style.marginLeft = p.offsetX + "px";
        img.style.marginTop = p.offsetY + "px";
        img.src = _overzoomUrl(
          this,
          coords.x >> depth,
          coords.y >> depth,
          coords.z - depth
        );
      };
      L.DomEvent.on(img, "load", () => {
        done(null, cell);
      });
      L.DomEvent.on(img, "error", () => {
        if (coords.z - depth <= minLevel) {
          done(null, cell);
          return;
        }
        depth += 1;
        place();
      });
      place();
      return cell;
    };
    return layer;
  }
  function tileProvider(url, opts = {}) {
    return class extends LayerProvider {
      create() {
        const { overzoom, ...rest } = opts;
        const layer = L.tileLayer(url, {
          tileSize: 256,
          maxNativeZoom: 18,
          maxZoom: 25,
          crossOrigin: true,
          ...rest
        });
        if (overzoom) wireOverzoomFallback(layer);
        return layer;
      }
    };
  }
  function arcgisExportProvider(opts) {
    return class extends LayerProvider {
      create() {
        return makeArcgisExportTileLayer(opts);
      }
    };
  }
  function tokenTileProvider(buildUrl, opts = {}) {
    return class extends LayerProvider {
      constructor(tokenMgr) {
        super();
        this._token = tokenMgr;
      }
      create() {
        const tok = this._token;
        const { overzoom, ...rest } = opts;
        const layer = L.tileLayer(
          tok.isValid() ? buildUrl(tok) : BLANK_TILE,
          {
            tileSize: 256,
            maxNativeZoom: 21,
            maxZoom: 25,
            crossOrigin: true,
            ...rest
          }
        );
        if (overzoom) wireOverzoomFallback(layer);
        if (!tok.isValid()) {
          tok.get(() => {
            if (tok.isValid()) layer.setUrl(buildUrl(tok));
          });
        }
        return layer;
      }
    };
  }
  function makeArcgisExportTileLayer(opts) {
    const tileSize = opts.tileSize || 256;
    const clickThrough = opts.clickThrough !== false;
    const Layer = L.TileLayer.extend({
      onAdd(map) {
        if (!map.getPane(opts.pane)) {
          map.createPane(opts.pane);
          const el = map.getPane(opts.pane);
          el.style.zIndex = String(opts.paneZIndex);
          if (clickThrough) el.style.pointerEvents = "none";
        }
        L.TileLayer.prototype.onAdd.call(this, map);
        if (opts.onAdd) opts.onAdd(this, map);
      },
      onRemove(map) {
        if (opts.onRemove) opts.onRemove(this, map);
        L.TileLayer.prototype.onRemove.call(this, map);
      },
      getTileUrl(coords) {
        const bb = tileToBBox4326(coords.z, coords.x, coords.y);
        return `${opts.baseUrl}/export?bbox=${bb.minLon},${bb.minLat},${bb.maxLon},${bb.maxLat}&bboxSR=4326&imageSR=4326` + (opts.showLayers != null ? `&layers=show:${opts.showLayers}` : "") + `&size=${tileSize},${tileSize}&format=png32&transparent=true&f=image`;
      }
    });
    const inst = new Layer("", {
      opacity: opts.opacity,
      attribution: opts.attribution,
      minZoom: opts.minZoom,
      maxZoom: opts.maxZoom,
      maxNativeZoom: opts.maxNativeZoom,
      tileSize,
      pane: opts.pane
    });
    const showParam = opts.showLayers != null ? `&layers=show:${opts.showLayers}` : "";
    inst._dwMb3DUrl = `${opts.baseUrl}/export?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=${tileSize},${tileSize}&format=png32&transparent=true&f=image${showParam}`;
    return inst;
  }

  // src/providers/raster-providers.js
  var QldGlobeLayerProvider = tokenTileProvider(
    (tok) => CFG.QLD_TILE_TPL + (tok.token ? "?token=" + tok.token : ""),
    {
      maxNativeZoom: 21,
      maxZoom: 25,
      overzoom: true,
      attribution: "&copy; State of Queensland (Department of Resources)"
    }
  );
  var GoogleHybridLayerProvider = tileProvider(
    CFG.GOOGLE_HYBRID_TILE,
    {
      subdomains: ["0", "1", "2", "3"],
      maxNativeZoom: 21,
      attribution: "&copy; Google"
    }
  );
  function buildAppleTileUrl(accessKey, version) {
    return CFG.APPLE_TILE_BASE + "&v=" + encodeURIComponent(version || CFG.APPLE_DEFAULT_V) + (accessKey ? "&accessKey=" + encodeURIComponent(accessKey) : "");
  }
  var AppleMapsLayerProvider = tokenTileProvider(
    (tok) => buildAppleTileUrl(tok.accessKey, tok.version),
    { maxNativeZoom: 19, maxZoom: 25, attribution: "&copy; Apple" }
  );
  var QldLabelsLayerProvider = tileProvider(CFG.QLD_LABELS_TILE, {
    maxNativeZoom: 19,
    maxZoom: 25,
    pane: "dwLabelsPane",
    attribution: "&copy; State of Queensland (Department of Resources)"
  });
  var EsriReferenceLayerProvider = class extends LayerProvider {
    create() {
      const common = {
        tileSize: 256,
        maxZoom: 25,
        crossOrigin: true,
        attribution: "Labels &copy; Esri, HERE, Garmin, OpenStreetMap contributors"
      };
      return L.layerGroup([
        L.tileLayer(
          CFG.ESRI_TRANSPORT_TILE,
          Object.assign({ pane: "dwRoadsPane", maxNativeZoom: 18 }, common)
        ),
        L.tileLayer(
          CFG.ESRI_PLACES_TILE,
          Object.assign({ pane: "dwLabelsPane", maxNativeZoom: 17 }, common)
        )
      ]);
    }
  };
  var MobileCoverageLayerProvider = arcgisExportProvider({
    baseUrl: CFG.ACCC_MOBILE_COVERAGE_SERVICE,
    showLayers: "2",
    pane: "dwMobilePane",
    paneZIndex: 380,
    opacity: 0.5,
    minZoom: 5,
    maxNativeZoom: 18,
    maxZoom: 25,
    attribution: 'Mobile coverage &copy; <a href="https://data.gov.au" target="_blank" rel="noreferrer">ACCC / Dept. of Infrastructure</a>'
  });
  var QldTopoLayerProvider = tileProvider(CFG.QLD_TOPO_TILE, {
    maxNativeZoom: 16,
    maxZoom: 25,
    attribution: "&copy; State of Queensland (Department of Resources)"
  });
  var QldReliefLayerProvider = tileProvider(CFG.QLD_RELIEF_TILE, {
    maxNativeZoom: 16,
    maxZoom: 25,
    opacity: 0.45,
    attribution: "&copy; State of Queensland (Department of Resources)"
  });
  var OpenSeaMapLayerProvider = tileProvider(
    CFG.OPENSEAMAP_TILE,
    {
      maxNativeZoom: 18,
      maxZoom: 25,
      attribution: '&copy; <a href="https://www.openseamap.org/" target="_blank" rel="noreferrer">OpenSeaMap</a> contributors'
    }
  );

  // src/providers/stamen-terrain.js
  var StamenTerrainLayerProvider = class extends LayerProvider {
    create() {
      const TILE_PX = 256;
      const TILE_BASE = "https://tiles.stadiamaps.com/tiles/stamen_terrain/";
      const spoofOrigin = CFG.STADIA_SPOOF_ORIGIN;
      const TerrainGrid = L.GridLayer.extend({
        createTile(coords, done) {
          const img = document.createElement("img");
          img.setAttribute("role", "presentation");
          const url = TILE_BASE + coords.z + "/" + coords.x + "/" + coords.y + ".png";
          img._dwHandle = gmGet(url, {
            responseType: "arraybuffer",
            headers: {
              Origin: spoofOrigin,
              Referer: spoofOrigin + "/",
              Accept: "image/png,image/*,*/*;q=0.8"
            }
          }, (err, r) => {
            img._dwHandle = null;
            if (err) {
              done(new Error("Stamen " + err.message), img);
              return;
            }
            if (r.status !== 200) {
              done(new Error("Stamen HTTP " + r.status), img);
              return;
            }
            const blob = new Blob([r.response], { type: "image/png" });
            const objUrl = URL.createObjectURL(blob);
            img.onload = () => {
              URL.revokeObjectURL(objUrl);
              done(null, img);
            };
            img.onerror = () => {
              URL.revokeObjectURL(objUrl);
              done(new Error("Stamen decode failed"), img);
            };
            img.src = objUrl;
          });
          return img;
        }
      });
      const layer = new TerrainGrid({
        tileSize: TILE_PX,
        maxNativeZoom: 18,
        maxZoom: 25,
        attribution: '&copy; <a href="https://stadiamaps.com/" target="_blank" rel="noreferrer">Stadia Maps</a> &copy; <a href="https://stamen.com/" target="_blank" rel="noreferrer">Stamen Design</a> &copy; <a href="https://openmaptiles.org/" target="_blank" rel="noreferrer">OpenMapTiles</a> &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors'
      });
      wireTileAbort(layer);
      dwRegisterMbLayer(layer, (z, x, y) => dwMbGmFetchAB(
        TILE_BASE + z + "/" + x + "/" + y + ".png",
        {
          headers: {
            Origin: spoofOrigin,
            Referer: spoofOrigin + "/",
            Accept: "image/png,image/*,*/*;q=0.8"
          }
        }
      ));
      return layer;
    }
  };

  // src/providers/vexcel.js
  function _vexcelParseToken(raw) {
    const s = String(raw || "").trim();
    const m = s.match(/token=([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/) || s.match(/^([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/);
    return m ? m[1] : "";
  }
  function _vexcelTokenExp(token) {
    try {
      const b64 = String(token).split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      const payload = JSON.parse(atob(b64));
      return (Number(payload.exp) || 0) * 1e3;
    } catch (_) {
      return 0;
    }
  }
  function _vexcelTokenValid(token) {
    return !!token && _vexcelTokenExp(token) > Date.now() + 60 * 1e3;
  }
  function _vexcelTileTpl(token) {
    return CFG.VEXCEL_WMTS_BASE + "?service=wmts&request=getTile&layer=urban&Style=RGB&TileMatrixSet=urban&TileMatrix={z}&TileRow={y}&TileCol={x}&format=image/jpeg&token=" + encodeURIComponent(token);
  }
  var VEXCEL_DIRECTIONS = [
    { key: "oblique-north", label: "N" },
    { key: "oblique-east", label: "E" },
    { key: "oblique-south", label: "S" },
    { key: "oblique-west", label: "W" },
    { key: "nadir", label: "Top" }
  ];
  function _vexcelCollectionYear(collection) {
    const m = String(collection || "").match(/(\d{4})(?!.*\d{4})/);
    return m ? m[1] : String(collection || "");
  }
  function _vexcelBand(name) {
    return /_irg$/i.test(String(name || "")) ? "irg" : "rgb";
  }
  function _vexcelParseObliques(data) {
    const images = {};
    const captureMeta = /* @__PURE__ */ new Map();
    const dirSet = /* @__PURE__ */ new Set();
    for (const f of data && Array.isArray(data.features) ? data.features : []) {
      const p = f.properties || {};
      const dir = p["product-type"];
      const coll = p.collection;
      const name = p["image-name"];
      if (!dir || !coll || !name) continue;
      const key = dir + "@" + coll;
      const band = _vexcelBand(name);
      if (!images[key]) images[key] = {};
      if (!images[key][band]) {
        images[key][band] = {
          name,
          layer: p["source-layer"] || p.layer || "urban",
          w: Number(p["raster-size-width"]) || 0,
          h: Number(p["raster-size-height"]) || 0,
          corners: _vexcelFootprint(f.geometry)
        };
      }
      if (!captureMeta.has(coll)) {
        const date = String(p["capture-date"] || "").slice(0, 10) || _vexcelCollectionYear(coll);
        captureMeta.set(coll, { year: _vexcelCollectionYear(coll), date });
      }
      dirSet.add(dir);
    }
    const captures = [...captureMeta.entries()].map(([collection, meta]) => ({ collection, year: meta.year, date: meta.date })).sort((a, b) => b.date.localeCompare(a.date));
    const directions = VEXCEL_DIRECTIONS.filter((d) => dirSet.has(d.key));
    return { images, captures, directions };
  }
  function _vexcelObliqueExtractUrl(imageName, layer, lat, lng, token) {
    if (!imageName || !_vexcelTokenValid(token)) return "";
    const wkt = `POINT(${Number(lng)} ${Number(lat)})`;
    return CFG.VEXCEL_API_BASE + "/v2/oriented/extract?wkt=" + encodeURIComponent(wkt) + "&srid=4326&layer=" + encodeURIComponent(layer || "urban") + "&image-name=" + encodeURIComponent(imageName) + "&token=" + encodeURIComponent(token);
  }
  function _vexcelObliqueTileBase(imageName, layer, token) {
    if (!imageName || !_vexcelTokenValid(token)) return "";
    return CFG.VEXCEL_API_BASE + "/v2/oriented/tile?layer=" + encodeURIComponent(layer || "urban") + "&image-name=" + encodeURIComponent(imageName) + "&token=" + encodeURIComponent(token);
  }
  function _vexcelMaxDownsample(w, h) {
    const px = Math.max(Number(w) || 256, Number(h) || 256);
    return Math.max(0, Math.ceil(Math.log2(px / 256)));
  }
  function _vexcelFootprint(geometry) {
    const ring = geometry && geometry.coordinates && geometry.coordinates[0];
    if (!Array.isArray(ring) || ring.length < 4) return null;
    const c = ring.slice(0, 4).map((p) => [Number(p[0]), Number(p[1])]);
    return c.every((p) => isFinite(p[0]) && isFinite(p[1])) ? c : null;
  }
  function _vexcelBilinear(corners, u, v) {
    const a = (1 - u) * (1 - v), b = u * (1 - v), d = u * v, e = (1 - u) * v;
    return [
      a * corners[0][0] + b * corners[1][0] + d * corners[2][0] + e * corners[3][0],
      a * corners[0][1] + b * corners[1][1] + d * corners[2][1] + e * corners[3][1]
    ];
  }
  function _vexcelInvBilinear(corners, lng, lat) {
    let u = 0.5, v = 0.5;
    for (let i = 0; i < 15; i++) {
      const p = _vexcelBilinear(corners, u, v);
      const fx = p[0] - lng, fy = p[1] - lat;
      const du = 1e-4, dv = 1e-4;
      const pu = _vexcelBilinear(corners, u + du, v);
      const pv = _vexcelBilinear(corners, u, v + dv);
      const j00 = (pu[0] - p[0]) / du, j01 = (pv[0] - p[0]) / dv;
      const j10 = (pu[1] - p[1]) / du, j11 = (pv[1] - p[1]) / dv;
      const det = j00 * j11 - j01 * j10;
      if (!det) break;
      u -= (j11 * fx - j01 * fy) / det;
      v -= (-j10 * fx + j00 * fy) / det;
      u = Math.max(0, Math.min(1, u));
      v = Math.max(0, Math.min(1, v));
    }
    return [u, v];
  }
  function _getStoredToken() {
    try {
      return GM_getValue(CFG.VEXCEL_TOKEN_KEY, "") || "";
    } catch (_) {
      return "";
    }
  }
  function _storeToken(t) {
    try {
      GM_setValue(CFG.VEXCEL_TOKEN_KEY, t);
    } catch (_) {
    }
  }
  function _getStoredCreds() {
    try {
      return {
        user: GM_getValue(CFG.VEXCEL_USER_KEY, "") || "",
        pass: GM_getValue(CFG.VEXCEL_PASS_KEY, "") || ""
      };
    } catch (_) {
      return { user: "", pass: "" };
    }
  }
  function _storeCreds(user, pass) {
    try {
      GM_setValue(CFG.VEXCEL_USER_KEY, user || "");
      GM_setValue(CFG.VEXCEL_PASS_KEY, pass || "");
    } catch (_) {
    }
  }
  function _hasCreds() {
    const c = _getStoredCreds();
    return !!(c.user && c.pass);
  }
  function _vexcelIsCredString(s) {
    s = String(s || "").trim();
    const i = s.indexOf(":");
    return i > 0 && s.slice(0, i).indexOf("@") > 0 && !/^https?:/i.test(s);
  }
  var _loginInFlight = null;
  var _loginCooldownUntil = 0;
  function _vexcelLogin(cb) {
    cb = cb || function() {
    };
    const creds = _getStoredCreds();
    if (!creds.user || !creds.pass) {
      cb(null, "nocreds");
      return;
    }
    if (_loginInFlight) {
      _loginInFlight.push(cb);
      return;
    }
    const now = typeof Date !== "undefined" && Date.now ? Date.now() : 0;
    if (now && now < _loginCooldownUntil) {
      cb(null, "cooldown");
      return;
    }
    _loginCooldownUntil = now + 15e3;
    _loginInFlight = [cb];
    const done = (tok, reason) => {
      const waiters = _loginInFlight;
      _loginInFlight = null;
      for (const w of waiters) {
        try {
          w(tok, reason);
        } catch (_) {
        }
      }
    };
    gmJsonGet(
      CFG.VEXCEL_ADMIN_BASE + "/api/auth/authenticate",
      {
        method: "POST",
        data: JSON.stringify({
          username: creds.user,
          password: creds.pass,
          application: CFG.VEXCEL_APP_KEY
        }),
        headers: {
          "Content-Type": "application/json",
          "X-App-Key": CFG.VEXCEL_APP_HDR
        }
      },
      (err, data, raw) => {
        const status = raw ? raw.status : 0;
        if (status === 401 || status === 403) {
          _storeCreds("", "");
          done(null, "badcreds");
          return;
        }
        if (err || !data) {
          done(null, "neterr");
          return;
        }
        const tok = data.data && data.data.token;
        if (!_vexcelTokenValid(tok)) {
          _storeCreds("", "");
          done(null, "badcreds");
          return;
        }
        _storeToken(tok);
        _loginCooldownUntil = 0;
        done(tok, null);
      }
    );
  }
  function _ensureTokenSilent(cb) {
    const tok = _getStoredToken();
    if (_vexcelTokenValid(tok)) {
      cb(tok);
      return;
    }
    if (_hasCreds()) {
      _vexcelLogin((t) => cb(t || null));
      return;
    }
    cb(null);
  }
  function _ensureAuthedToken(lead, cb) {
    const tok = _getStoredToken();
    if (_vexcelTokenValid(tok)) {
      cb(tok);
      return;
    }
    if (_hasCreds()) {
      _vexcelLogin((newTok, reason) => {
        if (newTok) {
          cb(newTok);
          return;
        }
        if (reason === "neterr" || reason === "cooldown") {
          cb(null, reason);
          return;
        }
        _promptForVexcelAuth(lead, (t2) => cb(t2 || null));
      });
      return;
    }
    _promptForVexcelAuth(lead, (t2) => cb(t2 || null));
  }
  function _promptForVexcelAuth(lead, cb) {
    cb = cb || function() {
    };
    const raw = window.prompt(
      (lead || "Vexcel Aerial sign-in.") + "\n\nEnter your Vexcel login as  email:password  — stored on THIS device only and used to auto-refresh the daily token.\n\n…or paste a one-off api.vexcelgroup.com token/URL instead (log in at " + CFG.VEXCEL_VIEWER_URL + ").",
      ""
    );
    if (raw == null) {
      cb(null);
      return;
    }
    const s = raw.trim();
    if (_vexcelIsCredString(s)) {
      const i = s.indexOf(":");
      _storeCreds(s.slice(0, i).trim(), s.slice(i + 1).trim());
      _vexcelLogin((tok2) => cb(_vexcelTokenValid(tok2) ? tok2 : null));
      return;
    }
    const tok = _vexcelParseToken(s);
    if (tok) _storeToken(tok);
    cb(_vexcelTokenValid(tok) ? tok : null);
  }
  function fetchVexcelObliques(lat, lng, cb) {
    _ensureTokenSilent((token) => _fetchVexcelObliques(lat, lng, token, cb));
  }
  function _fetchVexcelObliques(lat, lng, token, cb) {
    if (!_vexcelTokenValid(token)) {
      cb(null);
      return;
    }
    gmJsonGet(
      CFG.VEXCEL_API_BASE + "/v2/oriented/query?token=" + encodeURIComponent(token),
      {
        method: "POST",
        data: JSON.stringify({
          wkt: `POINT(${Number(lng)} ${Number(lat)})`,
          srid: "4326",
          layer: "wide-area,urban",
          // Both bands (rgb + irg) so the viewer can offer an IR
          // toggle; parse buckets them by the image-name suffix.
          // image-center-distance-asc → the first image per cell is
          // the one whose frame is centred nearest the clicked point,
          // so the user's spot sits near the middle of the oblique.
          "order-by": "image-center-distance-asc",
          include: "collection,capture-date,product-type,image-name,source-layer,raster-size-width,raster-size-height,geometry"
        }),
        headers: { "Content-Type": "application/json" }
      },
      (err, data, raw) => {
        if (raw && (raw.status === 401 || raw.status === 403)) {
          cb(null, "auth");
          return;
        }
        if (err || !data) {
          cb(null);
          return;
        }
        const parsed = _vexcelParseObliques(data);
        cb(parsed.directions.length ? parsed : null);
      }
    );
  }
  function _dirLabel(key) {
    const d = VEXCEL_DIRECTIONS.find((x) => x.key === key);
    return d ? d.label : key;
  }
  function fetchVexcelFrame(lng, lat, collection, dir, band, cb) {
    _ensureTokenSilent((token) => _fetchVexcelFrame(lng, lat, collection, dir, band, token, cb));
  }
  function _fetchVexcelFrame(lng, lat, collection, dir, band, token, cb) {
    if (!_vexcelTokenValid(token)) {
      cb(null);
      return;
    }
    gmJsonGet(
      CFG.VEXCEL_API_BASE + "/v2/oriented/query?token=" + encodeURIComponent(token),
      {
        method: "POST",
        data: JSON.stringify({
          wkt: `POINT(${Number(lng)} ${Number(lat)})`,
          srid: "4326",
          layer: "wide-area,urban",
          collection,
          "product-type": dir,
          bands: band || "rgb",
          "order-by": "image-center-distance-asc",
          "total-records": 1,
          include: "image-name,source-layer,raster-size-width,raster-size-height,geometry"
        }),
        headers: { "Content-Type": "application/json" }
      },
      (err, data) => {
        const f = !err && data && Array.isArray(data.features) && data.features[0];
        if (!f) {
          cb(null);
          return;
        }
        const p = f.properties || {};
        cb({
          name: p["image-name"],
          layer: p["source-layer"] || "urban",
          w: Number(p["raster-size-width"]) || 0,
          h: Number(p["raster-size-height"]) || 0,
          corners: _vexcelFootprint(f.geometry)
        });
      }
    );
  }
  var _vexCtl = null;
  function createVexcelControl() {
    if (_vexCtl) return _vexCtl;
    const el = document.createElement("div");
    el.className = "dw-vex-ctl";
    el.innerHTML = '<div class="dw-vex-rose"><button type="button" class="dw-vex-dir dw-vex-n" data-dir="oblique-north" title="Look from the north">N</button><button type="button" class="dw-vex-dir dw-vex-w" data-dir="oblique-west" title="Look from the west">W</button><button type="button" class="dw-vex-dir dw-vex-c" data-dir="nadir" title="Straight down (dated)">⊙</button><button type="button" class="dw-vex-dir dw-vex-e" data-dir="oblique-east" title="Look from the east">E</button><button type="button" class="dw-vex-dir dw-vex-s" data-dir="oblique-south" title="Look from the south">S</button></div><button type="button" class="dw-vex-ir" title="Toggle near-infrared (vegetation shows red)">IR</button><div class="dw-vex-basemsg" style="display:none"></div>';
    const overlay = document.createElement("div");
    overlay.className = "dw-vex-overlay";
    overlay.style.display = "none";
    overlay.innerHTML = '<button type="button" class="dw-vex-close" title="Back to map">✕ Map</button><div class="dw-vex-hint">drag to pan · scroll to zoom</div><div class="dw-vex-msg"></div><div class="dw-vex-tilemap"></div>';
    for (const node of [el, overlay]) {
      L.DomEvent.disableClickPropagation(node);
      L.DomEvent.disableScrollPropagation(node);
    }
    const listeners = {};
    const ctl = {
      el,
      overlay,
      _map: null,
      lat: 0,
      lng: 0,
      atKey: "",
      model: null,
      // Default to the straight-down nadir (⊙) — it matches the flat
      // basemap orientation, so entering the dated viewer feels like
      // "the same view, but through time". Falls back to an oblique
      // angle on dates/areas without nadir (SCC: nadir is 2025 only).
      dir: "nadir",
      band: "rgb",
      // "rgb" | "irg" (near-infrared)
      capIdx: 0,
      // index into model.captures (0 = newest)
      queried: false,
      // has the capture query at the current point resolved?
      gen: 0,
      on(ev, fn) {
        (listeners[ev] = listeners[ev] || []).push(fn);
        return ctl;
      },
      off(ev, fn) {
        listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn);
        return ctl;
      },
      _fire(ev) {
        for (const f of listeners[ev] || []) {
          try {
            f();
          } catch (_) {
          }
        }
      },
      // Surface a base-layer status note under the compass (e.g. the
      // account is quota-capped). Empty/falsy hides it.
      setBaseMsg(text) {
        const n = el.querySelector(".dw-vex-basemsg");
        if (!n) return;
        n.textContent = text || "";
        n.style.display = text ? "block" : "none";
      }
    };
    const mapEl = overlay.querySelector(".dw-vex-tilemap");
    const msgEl = overlay.querySelector(".dw-vex-msg");
    const dirBtns = [...el.querySelectorAll(".dw-vex-dir")];
    const irBtn = el.querySelector(".dw-vex-ir");
    const cellFor = (dir) => {
      const cap = ctl.model && ctl.model.captures[ctl.capIdx];
      return cap ? ctl.model.images[dir + "@" + cap.collection] : null;
    };
    const curImage = () => {
      const cell = cellFor(ctl.dir);
      return cell ? cell[ctl.band] || cell.rgb : null;
    };
    const irAvail = () => {
      const cell = cellFor(ctl.dir);
      return !!(cell && cell.irg);
    };
    const setMsg = (t) => {
      const wasClosed = overlay.style.display === "none";
      overlay.style.display = "";
      msgEl.textContent = t;
      msgEl.style.display = t ? "" : "none";
      if (wasClosed) ctl._fire("overlaytoggle");
    };
    ctl.isOverlayOpen = () => overlay.style.display !== "none";
    const dirHasPhoto = (dir) => {
      const cell = cellFor(dir);
      return !!(cell && (cell.rgb || cell.irg));
    };
    const availDirs = () => {
      if (!ctl.model) return [];
      return ctl.model.directions.filter((d) => dirHasPhoto(d.key));
    };
    const updateIrBtn = () => {
      if (!irBtn) return;
      const avail = irAvail();
      if (!avail && ctl.band === "irg") ctl.band = "rgb";
      irBtn.disabled = !avail;
      irBtn.classList.toggle("dw-vex-dir--off", !avail);
      irBtn.classList.toggle("dw-vex-ir--on", ctl.band === "irg" && avail);
    };
    const markActiveDir = () => {
      dirBtns.forEach((b) => {
        const has = dirHasPhoto(b.dataset.dir);
        b.classList.toggle(
          "dw-vex-dir--on",
          ctl.isOverlayOpen() && b.dataset.dir === ctl.dir && has
        );
        b.classList.toggle("dw-vex-dir--off", !!ctl.model && !has);
        b.disabled = !!ctl.model && !has;
      });
      updateIrBtn();
    };
    ctl._imgMap = null;
    ctl._tileLayer = null;
    const ensureImgMap = () => {
      if (ctl._imgMap) return ctl._imgMap;
      ctl._imgMap = L.map(mapEl, {
        crs: L.CRS.Simple,
        attributionControl: false,
        zoomControl: true,
        minZoom: 0
      });
      ctl._imgMap.on("moveend", onInnerMove);
      return ctl._imgMap;
    };
    const dropTiles = () => {
      if (ctl._tileLayer && ctl._imgMap) {
        ctl._imgMap.removeLayer(ctl._tileLayer);
        ctl._tileLayer = null;
      }
    };
    ctl._frame = null;
    ctl._suppressMove = false;
    const loadFrame = (frame, opts) => {
      opts = opts || {};
      const base = _vexcelObliqueTileBase(
        frame.name,
        frame.layer,
        _getStoredToken()
      );
      if (!base) {
        setMsg("Vexcel token expired — reselect the base to refresh it.");
        return;
      }
      setMsg("");
      const w = frame.w || 10560, h = frame.h || 14144;
      const TS = 256;
      const sizes = [];
      let s = L.point(w, h);
      sizes.push(s);
      while (s.x > TS || s.y > TS) {
        s = s.divideBy(2).ceil();
        sizes.push(s);
      }
      sizes.reverse();
      const maxZ = sizes.length - 1;
      const grids = sizes.map((p) => L.point(Math.ceil(p.x / TS), Math.ceil(p.y / TS)));
      const map = ensureImgMap();
      map.setMinZoom(0);
      map.setMaxZoom(maxZ);
      map.invalidateSize();
      dropTiles();
      const TileCls = L.TileLayer.extend({
        getTileUrl(coords) {
          const ds = maxZ - coords.z;
          return base + "&downsample=" + ds + "&tile-x=" + coords.x + "&tile-y=" + coords.y;
        },
        _isValidTile(coords) {
          const g = grids[coords.z];
          return !!g && coords.x >= 0 && coords.y >= 0 && coords.x < g.x && coords.y < g.y;
        }
      });
      ctl._tileLayer = new TileCls("", {
        tileSize: TS,
        minZoom: 0,
        maxZoom: maxZ,
        noWrap: true,
        crossOrigin: true,
        errorTileUrl: BLANK_TILE
      }).addTo(map);
      const bounds = L.latLngBounds(
        map.unproject([0, h], maxZ),
        map.unproject([w, 0], maxZ)
      );
      map.setMaxBounds(bounds.pad(0.1));
      ctl._frame = Object.assign({ collection: frame.collection, maxZ, w, h }, frame);
      const keepZ = opts.keepZoom && map.getZoom();
      let center = bounds.getCenter(), z;
      if (opts.center && frame.corners) {
        const [u, v] = _vexcelInvBilinear(frame.corners, opts.center[0], opts.center[1]);
        center = map.unproject([u * w, v * h], maxZ);
        z = keepZ || Math.min(maxZ, Math.max(map.getBoundsZoom(bounds, false), maxZ - 1));
      } else {
        z = Math.min(maxZ, Math.max(map.getBoundsZoom(bounds, false), maxZ - 1));
      }
      ctl._suppressMove = true;
      map.setView(center, z, { animate: false });
      markActiveDir();
    };
    const load = () => {
      if (!ctl.model) return;
      const cap = ctl.model.captures[ctl.capIdx];
      const img = curImage();
      if (!img) {
        dropTiles();
        setMsg("No " + _dirLabel(ctl.dir) + " photo for " + (cap ? cap.date : "this date") + " here.");
        ctl._frame = null;
        return;
      }
      loadFrame(Object.assign({ collection: cap.collection }, img));
    };
    let panTimer = null;
    const onInnerMove = () => {
      if (ctl._suppressMove) {
        ctl._suppressMove = false;
        return;
      }
      const f = ctl._frame;
      if (!f || !f.corners || !ctl.model) return;
      clearTimeout(panTimer);
      panTimer = setTimeout(() => {
        const map = ctl._imgMap;
        if (!map || !ctl.isOverlayOpen()) return;
        const pt = map.project(map.getCenter(), f.maxZ);
        const u = Math.max(0, Math.min(1, pt.x / f.w));
        const v = Math.max(0, Math.min(1, pt.y / f.h));
        const ground = _vexcelBilinear(f.corners, u, v);
        const cap = ctl.model.captures[ctl.capIdx];
        if (!cap) return;
        fetchVexcelFrame(ground[0], ground[1], cap.collection, ctl.dir, ctl.band, (fr) => {
          if (!fr || !fr.name || !ctl.isOverlayOpen()) return;
          if (fr.name === f.name) return;
          loadFrame(
            Object.assign({ collection: cap.collection }, fr),
            { center: ground, keepZoom: true }
          );
        });
      }, 300);
    };
    let refreshTimer = null;
    const refreshCaptures = () => {
      if (!ctl._map) return;
      const c = ctl._map.getCenter();
      const key = c.lat.toFixed(5) + "," + c.lng.toFixed(5);
      if (ctl.atKey === key) return;
      ctl.lat = c.lat;
      ctl.lng = c.lng;
      ctl.atKey = key;
      if (!_vexcelTokenValid(_getStoredToken()) && !_hasCreds()) {
        ctl.model = null;
        ctl.queried = true;
        ctl._fire("capturechange");
        return;
      }
      ctl.queried = false;
      ctl._fire("capturechange");
      const gen = ++ctl.gen;
      fetchVexcelObliques(ctl.lat, ctl.lng, (model, reason) => {
        if (gen !== ctl.gen && model == null) {
        }
        ctl.model = model || null;
        ctl.queried = true;
        if (reason === "auth") {
          ctl._fire("capturechange");
          if (ctl.isOverlayOpen()) setMsg("Vexcel token was refused — reselect the base to paste a fresh one.");
          return;
        }
        if (model) {
          if (!model.directions.some((d) => d.key === ctl.dir)) ctl.dir = model.directions[0].key;
          if (ctl.capIdx >= model.captures.length) ctl.capIdx = 0;
          markActiveDir();
        }
        ctl._fire("capturechange");
        if (overlay.style.display !== "none" && model) load();
      });
    };
    const scheduleRefresh = () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(refreshCaptures, 500);
    };
    dirBtns.forEach((b) => b.addEventListener("click", () => {
      if (b.disabled) return;
      if (!_vexcelTokenValid(_getStoredToken())) {
        setMsg("Paste a Vexcel token (reselect the base) to load imagery.");
        return;
      }
      if (!ctl.model) {
        setMsg("No Vexcel oblique here — recentre over a flown area.");
        return;
      }
      ctl.dir = b.dataset.dir;
      markActiveDir();
      load();
    }));
    if (irBtn) irBtn.addEventListener("click", () => {
      if (irBtn.disabled || !irAvail()) return;
      ctl.band = ctl.band === "irg" ? "rgb" : "irg";
      updateIrBtn();
      if (ctl.isOverlayOpen()) load();
    });
    overlay.querySelector(".dw-vex-close").addEventListener("click", () => {
      overlay.style.display = "none";
      ctl.gen++;
      markActiveDir();
      ctl._fire("overlaytoggle");
    });
    ctl.getCaptureCount = () => ctl.model && ctl.model.captures.length || 0;
    ctl.getCaptureIdx = () => ctl.capIdx;
    ctl.getCaptureState = () => !ctl.queried ? "loading" : ctl.getCaptureCount() ? "ready" : "empty";
    ctl.getCaptureDate = (i) => {
      const caps = ctl.model && ctl.model.captures || [];
      return caps[i] ? caps[i].date || caps[i].year : "";
    };
    ctl.setCapture = (i) => {
      ctl.capIdx = i;
      if (!ctl.model) return;
      if (!dirHasPhoto(ctl.dir)) {
        const avail = availDirs();
        if (avail.length) ctl.dir = avail[0].key;
      }
      markActiveDir();
      load();
    };
    ctl.addTo = (m) => {
      if (ctl._map) return ctl;
      ctl._map = m;
      m.getContainer().appendChild(overlay);
      m.getContainer().appendChild(el);
      m.on("moveend", scheduleRefresh);
      markActiveDir();
      refreshCaptures();
      return ctl;
    };
    ctl.remove = () => {
      if (!ctl._map) return ctl;
      ctl._map.off("moveend", scheduleRefresh);
      clearTimeout(refreshTimer);
      ctl.gen++;
      if (ctl._imgMap) {
        try {
          ctl._imgMap.remove();
        } catch (_) {
        }
        ctl._imgMap = null;
        ctl._tileLayer = null;
      }
      if (el.parentNode) el.parentNode.removeChild(el);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      ctl._map = null;
      return ctl;
    };
    _vexCtl = ctl;
    return ctl;
  }
  var VexcelLayerProvider = class extends LayerProvider {
    create() {
      const stored = _getStoredToken();
      const layer = L.tileLayer(
        _vexcelTokenValid(stored) ? _vexcelTileTpl(stored) : BLANK_TILE,
        {
          tileSize: 256,
          maxNativeZoom: 21,
          maxZoom: 25,
          crossOrigin: true,
          // Urban program tiles 404 outside flown areas — render
          // those as blank rather than broken-image icons.
          errorTileUrl: BLANK_TILE,
          attribution: '&copy; <a href="https://www.vexcelgroup.com/" target="_blank" rel="noreferrer">Vexcel Imaging</a>'
        }
      );
      layer.on("add", (e) => {
        layer._dwAuthTries = 0;
        layer._dwAuthGaveUp = false;
        const apply = (tok) => {
          if (!_vexcelTokenValid(tok)) return;
          const tpl = _vexcelTileTpl(tok);
          if (layer._url !== tpl) {
            layer.setUrl(tpl);
            layer.redraw();
          }
        };
        const cur = _getStoredToken();
        if (_vexcelTokenValid(cur)) apply(cur);
        else _ensureAuthedToken(void 0, apply);
        const map = e && e.target && e.target._map;
        if (map) createVexcelControl().addTo(map);
      });
      layer.on("remove", () => {
        if (_vexCtl) _vexCtl.remove();
      });
      layer.on("tileload", (e) => {
        const src = e && e.tile && e.tile.src || "";
        if (src.slice(0, 5) === "data:") return;
        layer._dwAuthTries = 0;
        layer._dwAuthGaveUp = false;
        if (_vexCtl && _vexCtl.setBaseMsg) _vexCtl.setBaseMsg("");
      });
      let errBurst = 0, errTimer = null;
      layer.on("tileerror", () => {
        if (!layer._map || layer._dwReprompt) return;
        errBurst++;
        clearTimeout(errTimer);
        errTimer = setTimeout(() => {
          errBurst = 0;
        }, 3e3);
        if (errBurst < 8) return;
        errBurst = 0;
        if (layer._dwAuthGaveUp) return;
        if (layer._dwAuthTries >= 1 && _vexcelTokenValid(_getStoredToken())) {
          layer._dwAuthGaveUp = true;
          layer.setUrl(BLANK_TILE);
          if (_vexCtl && _vexCtl.setBaseMsg) {
            _vexCtl.setBaseMsg(
              "No Vexcel imagery loaded here — either this area isn't covered, or the account hit its usage limit. Try another area, or again later."
            );
          }
          console.warn("[CustomTiles] Vexcel: fresh token still errors — no coverage or account quota-capped; stopping retries.");
          return;
        }
        layer._dwReprompt = true;
        _storeToken("");
        _ensureAuthedToken(
          "Vexcel refused the current token (expired or usage limit).",
          (tok) => {
            layer._dwReprompt = false;
            if (_vexcelTokenValid(tok)) {
              layer._dwAuthTries++;
              layer.setUrl(_vexcelTileTpl(tok));
              layer.redraw();
              if (_vexCtl) {
                _vexCtl.atKey = "";
              }
            } else {
              layer.setUrl(BLANK_TILE);
            }
          }
        );
      });
      layer._dwMb3DGetUrl = () => {
        const tok = _getStoredToken();
        return _vexcelTokenValid(tok) ? _vexcelTileTpl(tok) : "";
      };
      return layer;
    }
  };

  // src/providers/wayback.js
  var WaybackLayerProvider = class extends LayerProvider {
    constructor() {
      super();
      this._releases = null;
      this._idx = 0;
      this._fetching = false;
      this._layerRef = null;
    }
    _tileUrl(releaseNum) {
      return "https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/default028mm/MapServer/tile/" + releaseNum + "/{z}/{y}/{x}";
    }
    _fetchCatalog() {
      if (this._fetching || this._releases) return;
      this._fetching = true;
      cachedFetch(
        "wayback_catalog",
        24 * 3600 * 1e3,
        (done) => gmJsonGet(CFG.WAYBACK_CONFIG_URL, (err, data) => {
          if (err) {
            done(err, null);
            return;
          }
          const releases = Object.entries(data).filter(([, item]) => item.itemTitle).map(([key, item]) => ({
            releaseNum: parseInt(key, 10),
            label: item.itemTitle.replace(/^World Imagery \(Wayback /, "").replace(/\)$/, "")
          }));
          releases.sort((a, b) => a.label < b.label ? 1 : a.label > b.label ? -1 : 0);
          done(null, releases);
        }),
        (err, releases) => {
          this._fetching = false;
          if (err || !releases) {
            console.error("[CustomTiles] Wayback catalog:", err && err.message);
            return;
          }
          this._releases = releases.map((r) => ({
            ...r,
            url: this._tileUrl(r.releaseNum)
          }));
          console.info(
            "[CustomTiles] Wayback:",
            this._releases.length,
            "releases loaded"
          );
          this._idx = 0;
          if (this._layerRef) {
            this._layerRef.setUrl(this._releases[0].url);
            this._layerRef.fire("histchange");
          }
        }
      );
    }
    create() {
      const provider = this;
      const layer = L.tileLayer(BLANK_TILE, {
        maxNativeZoom: 19,
        maxZoom: 25,
        tileSize: 256,
        attribution: "&copy; Esri, Maxar, Earthstar Geographics"
      });
      wireOverzoomFallback(layer);
      this._layerRef = layer;
      layer.getHistCount = () => provider._releases ? provider._releases.length : 0;
      layer.getHistIdx = () => provider._idx;
      layer.getHistLabel = (i) => {
        if (!provider._releases) return null;
        return (provider._releases[i ?? provider._idx] || {}).label || null;
      };
      layer.setHistIdx = (i) => {
        if (!provider._releases) return;
        if (i < 0 || i >= provider._releases.length || i === provider._idx)
          return;
        provider._idx = i;
        layer.setUrl(provider._releases[i].url);
        layer.fire("histchange");
      };
      layer.on("add", () => provider._fetchCatalog());
      return layer;
    }
  };

  // src/providers/qld-imagery.js
  var QldRoadsLayerProvider = class extends LayerProvider {
    constructor(qldToken) {
      super();
      this._token = qldToken;
    }
    create() {
      const TILE_PX = 256;
      const token = this._token;
      const DYN_LAYERS = encodeURIComponent(JSON.stringify(
        [21, 22, 23, 10].map((id) => ({
          id,
          source: { type: "mapLayer", mapLayerId: id },
          drawingInfo: { showLabels: true }
        }))
      ));
      const QldRoadsGrid = L.GridLayer.extend({
        createTile(coords, done) {
          const img = document.createElement("img");
          img.setAttribute("role", "presentation");
          const b = tileToBBox3857(coords.z, coords.x, coords.y);
          const bbox = encodeURIComponent(
            `${b.west},${b.south},${b.east},${b.north}`
          );
          const tok = token.token ? "&token=" + encodeURIComponent(token.token) : "";
          img.onload = () => done(null, img);
          img.onerror = () => done(new Error("Roads tile failed"), img);
          img.src = CFG.QLD_ROADS_EXPORT + `?bbox=${bbox}&bboxSR=102100&imageSR=102100&size=${TILE_PX}%2C${TILE_PX}&dpi=192&format=png32&transparent=true&dynamicLayers=${DYN_LAYERS}&f=image${tok}`;
          return img;
        }
      });
      const layer = new QldRoadsGrid({
        tileSize: TILE_PX,
        maxNativeZoom: 19,
        maxZoom: 25,
        pane: "dwRoadsPane",
        attribution: "&copy; State of Queensland (Department of Resources)"
      });
      layer._dwMb3DGetUrl = () => {
        if (!token.token) return null;
        const tok = "&token=" + encodeURIComponent(token.token);
        return CFG.QLD_ROADS_EXPORT + `?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=${TILE_PX},${TILE_PX}&dpi=192&format=png32&transparent=true&dynamicLayers=${DYN_LAYERS}&f=image${tok}`;
      };
      return layer;
    }
  };
  var QldHistoricalLayerProvider = class extends LayerProvider {
    constructor(qldToken) {
      super();
      this._qldToken = qldToken || null;
      this._captures = [];
      this._captureIdx = 0;
      this._currentOid = null;
      this._captureGeneration = 0;
      this._redrawTimer = null;
      this._fetching = false;
      this._fetchPending = [];
      this._lastCenter = null;
      this._gridLayerRef = null;
    }
    _queryCatalog(map, cb) {
      if (this._currentOid !== null) {
        cb(this._currentOid);
        return;
      }
      this._fetchPending.push(cb);
      if (this._fetching) return;
      this._fetching = true;
      const c = map.getCenter();
      this._lastCenter = c;
      const geomParam = "?geometry=" + encodeURIComponent(
        JSON.stringify({
          x: c.lng,
          y: c.lat,
          spatialReference: { wkid: 4326 }
        })
      ) + "&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=objectid,name,year,title,capturestart&returnGeometry=false&orderByFields=capturestart+DESC&f=json";
      const parseCaptures = (data, service, needsToken, mosaicWhere) => (data && data.features || []).map((f) => ({
        objectid: f.attributes.objectid,
        title: f.attributes.title || f.attributes.name || String(f.attributes.year || ""),
        captureDate: f.attributes.capturestart ? new Date(f.attributes.capturestart).toISOString().slice(0, 10) : f.attributes.year ? String(f.attributes.year) : null,
        service,
        needsToken,
        mosaicWhere
      })).filter((f) => f.objectid);
      let orthoCaptures = null;
      let photosCaptures = null;
      const finish = () => {
        this._fetching = false;
        const all = [...orthoCaptures || [], ...photosCaptures || []];
        all.sort((a, b) => {
          const da = a.captureDate || "";
          const db = b.captureDate || "";
          return db < da ? -1 : db > da ? 1 : 0;
        });
        this._captures = all;
        if (this._captures.length) {
          console.info(
            "[CustomTiles] QLD Historical:",
            this._captures.length,
            "captures, latest:",
            this._captures[0].captureDate || this._captures[0].title
          );
        } else {
          console.warn(
            "[CustomTiles] QLD Historical: no coverage at",
            c.lng.toFixed(4),
            c.lat.toFixed(4)
          );
        }
        this._captureIdx = 0;
        this._currentOid = this._captures[0] && this._captures[0].objectid || null;
        this._fetchPending.splice(0).forEach((fn) => fn(this._currentOid));
        if (this._gridLayerRef) this._gridLayerRef.fire("capturechange");
      };
      const tryFinish = () => {
        if (orthoCaptures !== null && photosCaptures !== null) finish();
      };
      gmJsonGet(
        CFG.QLD_HIST_SERVICE + "/query" + geomParam + "&where=category%3D1",
        { headers: { Origin: "https://qldglobe.information.qld.gov.au" } },
        (err, data) => {
          if (err) {
            console.error(
              "[CustomTiles] QLD Historical ortho query:",
              err.message
            );
            orthoCaptures = [];
          } else {
            orthoCaptures = parseCaptures(
              data,
              CFG.QLD_HIST_SERVICE,
              false,
              "category=1"
            );
          }
          tryFinish();
        }
      );
      const doPhotosQuery = (tok) => {
        const tokenParam = tok ? "&token=" + encodeURIComponent(tok) : "";
        const url = CFG.QLD_HIST_PHOTOS_SERVICE + "/query" + geomParam + "&where=1%3D1" + tokenParam;
        gmJsonGet(url, {
          headers: {
            Origin: "https://qldglobe.information.qld.gov.au",
            Referer: "https://qldglobe.information.qld.gov.au/"
          }
        }, (err, data, raw) => {
          if (err) {
            const body = raw && raw.responseText ? ` ${raw.responseText.slice(0, 200)}` : "";
            console.warn(
              "[CustomTiles] QLD Historical photos",
              err.message,
              tok ? "(token sent)" : "(no token)",
              body
            );
            photosCaptures = [];
          } else if (!data || data.error) {
            const e = data && data.error || {};
            console.warn(
              "[CustomTiles] QLD Historical photos service error:",
              e.code,
              e.message || (data ? "" : "null response body"),
              tok ? "(token sent — may be expired or wrong scope)" : "(no token)"
            );
            photosCaptures = [];
          } else {
            photosCaptures = parseCaptures(
              data,
              CFG.QLD_HIST_PHOTOS_SERVICE,
              !!tok,
              null
            );
            const total = (data.features || []).length;
            const limited = !!data.exceededTransferLimit;
            console.info(
              "[CustomTiles] QLD Historical photos:",
              total,
              "features",
              limited ? "(LIMITED — older captures cut off, see maxRecordCount)" : ""
            );
          }
          tryFinish();
        });
      };
      if (this._qldToken) {
        this._qldToken.get((err, tok) => doPhotosQuery(err ? null : tok));
      } else {
        doPhotosQuery(null);
      }
    }
    create() {
      const provider = this;
      const TILE_PX = 256;
      const QldHistGrid = L.GridLayer.extend({
        createTile(coords, done) {
          const img = document.createElement("img");
          img.setAttribute("role", "presentation");
          const map = this._map;
          const b = tileToBBox3857(coords.z, coords.x, coords.y);
          const bbox = encodeURIComponent(
            `${b.west},${b.south},${b.east},${b.north}`
          );
          const myGen = provider._captureGeneration;
          provider._queryCatalog(map, (oid) => {
            if (!oid || provider._captureGeneration !== myGen) {
              done(null, img);
              return;
            }
            const cap = provider._captures[provider._captureIdx];
            const svc = cap ? cap.service : CFG.QLD_HIST_SERVICE;
            const mosaicWhere = cap ? cap.mosaicWhere : "category=1";
            const needsToken = cap && cap.needsToken;
            const tokenStr = needsToken && provider._qldToken && provider._qldToken.token ? "&token=" + encodeURIComponent(provider._qldToken.token) : "";
            const mosaicRuleObj = {
              mosaicMethod: "esriMosaicLockRaster",
              lockRasterIds: [oid],
              ascending: true
            };
            if (mosaicWhere) mosaicRuleObj.where = mosaicWhere;
            const mosaicRule = encodeURIComponent(
              JSON.stringify(mosaicRuleObj)
            );
            img.onload = () => done(null, img);
            img.onerror = () => done(new Error("QLD Hist tile failed"), img);
            img.src = svc + "/exportImage?bbox=" + bbox + "&bboxSR=102100&imageSR=102100&size=" + TILE_PX + "%2C" + TILE_PX + "&format=jpg&mosaicRule=" + mosaicRule + "&f=image" + tokenStr;
          });
          return img;
        }
      });
      const gridLayer = new QldHistGrid({
        maxNativeZoom: 21,
        maxZoom: 25,
        tileSize: TILE_PX,
        keepBuffer: 2,
        attribution: "&copy; State of Queensland (Department of Resources) " + (/* @__PURE__ */ new Date()).getFullYear()
      });
      this._gridLayerRef = gridLayer;
      gridLayer.getCaptureCount = function() {
        return provider._captures.length;
      };
      gridLayer.getCaptureIdx = function() {
        return provider._captureIdx;
      };
      gridLayer.getCaptureDate = function(idx) {
        const c = provider._captures[idx !== void 0 ? idx : provider._captureIdx];
        return c ? c.captureDate || null : null;
      };
      gridLayer.setCapture = function(idx) {
        if (idx < 0 || idx >= provider._captures.length || idx === provider._captureIdx)
          return;
        provider._captureIdx = idx;
        provider._currentOid = provider._captures[idx].objectid;
        provider._captureGeneration++;
        this.fire("capturechange");
        if (provider._redrawTimer) clearTimeout(provider._redrawTimer);
        const self = this;
        provider._redrawTimer = setTimeout(() => {
          provider._redrawTimer = null;
          self.redraw();
        }, 300);
      };
      gridLayer._dwMb3DGetUrl = () => {
        if (provider._currentOid == null) {
          const map = gridLayer._map;
          if (map && !provider._fetching) {
            provider._queryCatalog(map, () => {
            });
          }
          return null;
        }
        const cap = provider._captures[provider._captureIdx];
        const svc = cap ? cap.service : CFG.QLD_HIST_SERVICE;
        const mosaicWhere = cap ? cap.mosaicWhere : "category=1";
        const needsToken = cap && cap.needsToken;
        const tokStr = needsToken && provider._qldToken && provider._qldToken.token ? "&token=" + encodeURIComponent(provider._qldToken.token) : "";
        const mosaicRuleObj = {
          mosaicMethod: "esriMosaicLockRaster",
          lockRasterIds: [provider._currentOid],
          ascending: true
        };
        if (mosaicWhere) mosaicRuleObj.where = mosaicWhere;
        const mosaicRule = encodeURIComponent(
          JSON.stringify(mosaicRuleObj)
        );
        return svc + "/exportImage?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=" + TILE_PX + "," + TILE_PX + "&format=jpg&mosaicRule=" + mosaicRule + "&f=image" + tokStr;
      };
      gridLayer._dwMb3DReloadOn = ["capturechange"];
      const EMPTY_PNG_AB = (() => {
        const b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
        const bin = atob(b64);
        const ab = new ArrayBuffer(bin.length);
        const u8 = new Uint8Array(ab);
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        return ab;
      })();
      dwRegisterMbLayer(gridLayer, (z, x, y) => new Promise((resolve, reject) => {
        const map = gridLayer._map;
        if (!map) return resolve(EMPTY_PNG_AB);
        const myGen = provider._captureGeneration;
        provider._queryCatalog(map, (oid) => {
          if (!oid || provider._captureGeneration !== myGen) {
            return resolve(EMPTY_PNG_AB);
          }
          const b = tileToBBox3857(z, x, y);
          const bbox = encodeURIComponent(
            `${b.west},${b.south},${b.east},${b.north}`
          );
          const cap = provider._captures[provider._captureIdx];
          const svc = cap ? cap.service : CFG.QLD_HIST_SERVICE;
          const mosaicWhere = cap ? cap.mosaicWhere : "category=1";
          const needsToken = cap && cap.needsToken;
          const tokenStr = needsToken && provider._qldToken && provider._qldToken.token ? "&token=" + encodeURIComponent(provider._qldToken.token) : "";
          const mosaicRuleObj = {
            mosaicMethod: "esriMosaicLockRaster",
            lockRasterIds: [oid],
            ascending: true
          };
          if (mosaicWhere) mosaicRuleObj.where = mosaicWhere;
          const mosaicRule = encodeURIComponent(
            JSON.stringify(mosaicRuleObj)
          );
          const url = svc + "/exportImage?bbox=" + bbox + "&bboxSR=102100&imageSR=102100&size=" + TILE_PX + "%2C" + TILE_PX + "&format=jpg&mosaicRule=" + mosaicRule + "&f=image" + tokenStr;
          dwMbFetchAB(url).then(resolve, reject);
        });
      }));
      gridLayer.on("add", function() {
        const m = this._map;
        const onMoveEnd = () => {
          if (!provider._lastCenter) return;
          const c = m.getCenter();
          const dist = Math.abs(c.lng - provider._lastCenter.lng) + Math.abs(c.lat - provider._lastCenter.lat);
          if (dist > 0.1) {
            provider._currentOid = null;
            provider._captures = [];
            provider._captureIdx = 0;
            provider._fetching = false;
            provider._fetchPending = [];
            provider._lastCenter = null;
            if (provider._gridLayerRef) {
              provider._gridLayerRef.fire("capturechange");
              provider._gridLayerRef.redraw();
            }
          }
        };
        m.on("moveend", onMoveEnd);
        this.once("remove", () => m.off("moveend", onMoveEnd));
      });
      return gridLayer;
    }
  };

  // src/layers/polling-data-layer.js
  function pollingDataLayer(opts) {
    return L.Layer.extend({
      initialize() {
        this._group = null;
        this._timer = null;
        this._debounce = null;
      },
      onAdd(map) {
        if (!map.getPane(opts.pane)) {
          map.createPane(opts.pane);
          map.getPane(opts.pane).style.zIndex = String(opts.paneZIndex);
        }
        this._group = L.layerGroup().addTo(map);
        this._startPoll();
        map.on("moveend zoomend", this._onViewChange, this);
      },
      onRemove(map) {
        clearInterval(this._timer);
        clearTimeout(this._debounce);
        this._timer = this._debounce = null;
        map.off("moveend zoomend", this._onViewChange, this);
        if (this._group) {
          this._group.remove();
          this._group = null;
        }
      },
      _startPoll() {
        clearInterval(this._timer);
        this._fetchGuarded();
        if (opts.pollMs) {
          this._timer = setInterval(() => this._fetchGuarded(), opts.pollMs);
        }
      },
      _onViewChange() {
        clearInterval(this._timer);
        clearTimeout(this._debounce);
        this._timer = null;
        this._debounce = setTimeout(() => this._startPoll(), opts.debounceMs || 400);
      },
      _fetchGuarded() {
        const map = this._map;
        if (!map || !this._group) return;
        if (map.getZoom() < opts.minZoom) {
          this._group.clearLayers();
          return;
        }
        opts.fetch(map, this._group, this);
      },
      getAttribution() {
        return opts.attribution;
      }
    });
  }

  // src/providers/waze-token.js
  var WAZE_RECAPTCHA_SITE_KEY = "6Lf4WdUqAAAAAEUYUvzyLYIkO3PoFAqi8ZHGiDLW";
  var WAZE_RECAPTCHA_ACTION = "api";
  var SHARED_KEY = "dw_waze_token_shared";
  var MANUAL_KEY = "dw_waze_token_manual";
  var BROKER_REMINT_MS = 75 * 1e3;
  var SHARED_MAX_AGE_MS = 3 * 60 * 1e3;
  var EMBED_URL = "https://embed.waze.com/iframe?zoom=12&lat=0&lon=0";
  var pageWin2 = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
  function isWazeTokenFrame() {
    try {
      return location.hostname === "embed.waze.com";
    } catch (_) {
      return false;
    }
  }
  function mintFromPage() {
    return new Promise((resolve) => {
      const g = pageWin2.grecaptcha && pageWin2.grecaptcha.enterprise;
      if (!g || typeof g.execute !== "function") {
        resolve(null);
        return;
      }
      try {
        g.ready(() => {
          try {
            g.execute(
              WAZE_RECAPTCHA_SITE_KEY,
              { action: WAZE_RECAPTCHA_ACTION }
            ).then((t) => resolve(t || null), () => resolve(null));
          } catch (_) {
            resolve(null);
          }
        });
      } catch (_) {
        resolve(null);
      }
    });
  }
  function publishToken(token) {
    if (!token) return;
    try {
      GM_setValue(SHARED_KEY, JSON.stringify({ token, ts: Date.now() }));
    } catch (_) {
    }
  }
  function startWazeTokenBroker() {
    if (startWazeTokenBroker._started) return;
    startWazeTokenBroker._started = true;
    let tries = 0;
    const kick = () => {
      const g = pageWin2.grecaptcha && pageWin2.grecaptcha.enterprise;
      if (g && typeof g.execute === "function") {
        const cycle = () => mintFromPage().then(publishToken);
        cycle();
        setInterval(cycle, BROKER_REMINT_MS);
        return;
      }
      if (tries++ < 120) setTimeout(kick, 500);
      else console.warn("[CustomTiles] Waze embed grecaptcha never appeared");
    };
    kick();
  }
  var _iframe = null;
  var _directMintPromise = null;
  var _directGrecaptcha = null;
  function ensureBrokerFrame() {
    if (_iframe || isWazeTokenFrame()) return;
    if (document.getElementById("dw-waze-token-frame")) {
      _iframe = true;
      return;
    }
    try {
      const f = document.createElement("iframe");
      f.id = "dw-waze-token-frame";
      f.setAttribute("aria-hidden", "true");
      f.setAttribute("tabindex", "-1");
      f.style.cssText = "position:absolute;left:-9999px;top:-9999px;width:1px;height:1px;border:0;opacity:0;pointer-events:none;visibility:hidden;";
      f.src = EMBED_URL;
      (document.body || document.documentElement).appendChild(f);
      _iframe = f;
    } catch (e) {
      console.warn("[CustomTiles] Waze token iframe failed:", e.message);
    }
  }
  function readSharedToken() {
    try {
      const raw = GM_getValue(SHARED_KEY, "");
      if (!raw) return null;
      const o = JSON.parse(raw);
      if (o && o.token && Date.now() - o.ts < SHARED_MAX_AGE_MS) {
        return o.token;
      }
    } catch (_) {
    }
    return null;
  }
  function directMint() {
    try {
      const manual = GM_getValue(MANUAL_KEY, "");
      if (manual) return Promise.resolve(String(manual));
    } catch (_) {
    }
    if (_directGrecaptcha && _directGrecaptcha.enterprise) {
      return _directGrecaptcha.enterprise.execute(WAZE_RECAPTCHA_SITE_KEY, { action: WAZE_RECAPTCHA_ACTION }).then((t) => t || null, () => null);
    }
    if (!_directMintPromise) {
      _directMintPromise = new Promise((resolve, reject) => {
        if (pageWin2.grecaptcha && pageWin2.grecaptcha.enterprise) {
          resolve(pageWin2.grecaptcha);
          return;
        }
        const existing = document.getElementById("dw-waze-recaptcha");
        if (existing) {
          existing.addEventListener(
            "load",
            () => resolve(pageWin2.grecaptcha),
            { once: true }
          );
          return;
        }
        const s = document.createElement("script");
        s.id = "dw-waze-recaptcha";
        s.src = "https://www.google.com/recaptcha/enterprise.js?render=" + WAZE_RECAPTCHA_SITE_KEY;
        s.async = true;
        s.onload = () => resolve(pageWin2.grecaptcha);
        s.onerror = () => reject(new Error("recaptcha load failed"));
        (document.head || document.documentElement).appendChild(s);
      }).catch(() => null);
    }
    return _directMintPromise.then((gr) => {
      if (!gr || !gr.enterprise) return null;
      _directGrecaptcha = gr;
      return new Promise((resolve) => {
        try {
          gr.enterprise.ready(() => {
            gr.enterprise.execute(
              WAZE_RECAPTCHA_SITE_KEY,
              { action: WAZE_RECAPTCHA_ACTION }
            ).then((t) => resolve(t || null), () => resolve(null));
          });
        } catch (_) {
          resolve(null);
        }
      });
    });
  }
  function getWazeToken() {
    try {
      const manual = GM_getValue(MANUAL_KEY, "");
      if (manual) return Promise.resolve(String(manual));
    } catch (_) {
    }
    const cached = readSharedToken();
    if (cached) return Promise.resolve(cached);
    ensureBrokerFrame();
    return new Promise((resolve) => {
      let waited = 0;
      const iv = setInterval(() => {
        const t = readSharedToken();
        if (t) {
          clearInterval(iv);
          resolve(t);
          return;
        }
        waited += 500;
        if (waited >= 15e3) {
          clearInterval(iv);
          directMint().then(resolve, () => resolve(null));
        }
      }, 500);
    });
  }

  // src/providers/live-data.js
  var FlightsLayerProvider = class extends LayerProvider {
    create() {
      const OPENSKY = "https://opensky-network.org/api/states/all";
      const renderStates = (group, states) => {
        const prev = group._dwFlights instanceof Map ? group._dwFlights : /* @__PURE__ */ new Map();
        const next = /* @__PURE__ */ new Map();
        for (const s of states) {
          const lon = s[5], lat = s[6];
          if (lon == null || lat == null) continue;
          const id = s[0];
          if (!id || next.has(id)) continue;
          const callsign = (s[1] || "").trim() || s[0];
          const track = s[10] || 0;
          const onGround = s[8];
          const altM = s[7];
          const speedMs = s[9];
          const country = s[2] || "";
          const altStr = altM != null ? Math.round(altM) + " m" : "—";
          const spdStr = speedMs != null ? Math.round(speedMs * 1.944) + " kts" : "—";
          const fill = onGround ? "#aaa" : "#FFE066";
          const stroke = onGround ? "#666" : "#444";
          const plane = `<svg viewBox="0 0 20 20" width="20" height="20" xmlns="http://www.w3.org/2000/svg"><g transform="translate(10,10) rotate(${track})"><ellipse rx="1.5" ry="7" fill="${fill}" stroke="${stroke}" stroke-width="0.6"/><polygon points="0,-2 -9,4 -8,5.5 0,2 8,5.5 9,4" fill="${fill}" stroke="${stroke}" stroke-width="0.6"/><polygon points="0,5 -4,8 -3.5,9 0,7 3.5,9 4,8" fill="${fill}" stroke="${stroke}" stroke-width="0.6"/></g></svg>`;
          const icon = L.divIcon({
            className: "dw-flight-icon",
            html: plane,
            iconSize: [20, 20],
            iconAnchor: [10, 10]
          });
          const tip = esc`<b>${callsign}</b><br>Alt: ${altStr}&nbsp; Speed: ${spdStr}<br>${country}`;
          let m = prev.get(id);
          if (m && group.hasLayer(m)) {
            m.setLatLng([lat, lon]);
            if (m._dwIconKey !== plane) {
              m.setIcon(icon);
              m._dwIconKey = plane;
            }
            m.setTooltipContent(tip);
            prev.delete(id);
          } else {
            m = L.marker([lat, lon], {
              icon,
              pane: "dwFlightsPane",
              interactive: true
            }).bindTooltip(tip, { className: "dw-flight-tip", sticky: true }).addTo(group);
            m._dwIconKey = plane;
          }
          next.set(id, m);
        }
        for (const m of prev.values()) {
          if (group.hasLayer(m)) group.removeLayer(m);
        }
        group._dwFlights = next;
      };
      const FlightsLayer = pollingDataLayer({
        pane: "dwFlightsPane",
        paneZIndex: 450,
        minZoom: 6,
        pollMs: 1e4,
        attribution: 'Flights © <a href="https://opensky-network.org" target="_blank" rel="noreferrer">OpenSky Network</a>',
        fetch: (map, group) => {
          const b = map.getBounds();
          const url = OPENSKY + "?lamin=" + b.getSouth().toFixed(3) + "&lomin=" + b.getWest().toFixed(3) + "&lamax=" + b.getNorth().toFixed(3) + "&lomax=" + b.getEast().toFixed(3);
          gmJsonGet(url, (err, data) => {
            if (err || !data || !group._map) return;
            renderStates(group, data.states || []);
          });
        }
      });
      return new FlightsLayer();
    }
  };
  var WazeLayerProvider = class extends LayerProvider {
    create() {
      const GEORSS = "https://www.waze.com/live-map/api/georss";
      function wazeEnv(lat, lon) {
        if (lat >= 29 && lat <= 34 && lon >= 34 && lon <= 36) return "il";
        if (lat >= 12 && lat <= 76 && lon >= -170 && lon <= -48) return "na";
        return "row";
      }
      const ALERT_STYLE = {
        POLICE: { glyph: "👮", color: "#4A89F3" },
        ACCIDENT: { glyph: "💥", color: "#E74C3C" },
        HAZARD: { glyph: "⚠️", color: "#F0A500" },
        WEATHERHAZARD: { glyph: "⚠️", color: "#F0A500" },
        ROAD_CLOSED: { glyph: "⛔", color: "#C0392B" },
        JAM: { glyph: "🚗", color: "#E67E22" },
        CONSTRUCTION: { glyph: "🚧", color: "#E67E22" },
        CHIT_CHAT: { glyph: "💬", color: "#90A4AE" }
      };
      const DEFAULT_STYLE = { glyph: "📍", color: "#90A4AE" };
      const JAM_COLORS = ["#7CB342", "#C0CA33", "#F0A500", "#E67E22", "#D9534F", "#7F1D1D"];
      const MOOD_EMOJI = {
        1: "🙂",
        14: "🙂",
        // HAPPY
        2: "😢",
        15: "😢",
        // SAD
        3: "😠",
        16: "😠",
        // MAD
        4: "😐",
        17: "😐",
        // BORED
        5: "💨",
        18: "💨",
        // SPEEDY
        6: "😋",
        19: "😋",
        // STARVING
        7: "😴",
        20: "😴",
        // SLEEPY
        8: "😎",
        21: "😎",
        // COOL
        9: "😍",
        22: "😍",
        // IN_LOVE
        10: "😂",
        23: "😂",
        // LOL
        11: "😌",
        24: "😌",
        // PEACEFUL
        12: "🎤",
        25: "🎤",
        // SINGING
        13: "🤔",
        26: "🤔",
        // WONDERING
        27: "🤖",
        28: "👾",
        29: "🦕",
        // ROBOT, BIT, DINO
        30: "😫",
        31: "😫",
        // BUSY
        32: "🏃",
        33: "🏃",
        // IN_A_HURRY
        34: "👶",
        35: "👹",
        // BABY, MONSTER
        36: "🦆",
        37: "🦆",
        // DUCK
        38: "🤓",
        39: "🤓",
        // GEEK
        40: "😏",
        41: "😏",
        // SARCASTIC
        42: "😊",
        43: "😊",
        // SHY
        44: "🤒",
        45: "🤒",
        // SICK
        46: "🥷",
        47: "🥷",
        // NINJA
        48: "🐶",
        49: "🐱",
        // DOG, CAT
        50: "🌻",
        51: "🧟",
        52: "😤",
        53: "😤",
        // SUNFLOWER, ZOMBIE, PROUD
        54: "🗑️",
        55: "❄️",
        56: "👨‍🔬",
        57: "🐛",
        // GARBAGE, SNOW, ALBERT, BUG_BUSTER
        58: "🏍️",
        59: "🏍️"
        // BIKER_RED, BIKER_DARK
      };
      const moodEmoji = (m) => MOOD_EMOJI[m] || "🙂";
      const wazerIcon = (emoji) => L.divIcon({
        className: "dw-waze-user-icon",
        html: `<div style="background:#33ccff;width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;line-height:1;border:2px solid #fff;box-shadow:0 0 3px rgba(0,0,0,.5);">${emoji}</div>`,
        iconSize: [20, 20],
        iconAnchor: [10, 10]
      });
      const agoStr = (ms) => {
        if (!ms) return "";
        const s = Math.max(0, (Date.now() - ms) / 1e3);
        if (s < 90) return Math.round(s) + "s ago";
        if (s < 5400) return Math.round(s / 60) + " min ago";
        return (s / 3600).toFixed(1) + " h ago";
      };
      const titleCase = (s) => String(s || "").replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
      const alertTitle = (a) => titleCase(a.subtype || a.type) || "Report";
      const placeStr = (o) => [o.street, o.city].filter(Boolean).join(", ");
      const thumbsCount = (a) => {
        if (typeof a.nThumbsUp === "number") return a.nThumbsUp;
        if (Array.isArray(a.comments))
          return a.comments.filter((c) => c && c.isThumbsUp).length;
        return 0;
      };
      const clip = (s, n) => {
        const t = String(s || "").trim().replace(/\s+/g, " ");
        return t.length > n ? t.slice(0, n - 1) + "…" : t;
      };
      const render = (group, data) => {
        const prev = group._dwWaze instanceof Map ? group._dwWaze : /* @__PURE__ */ new Map();
        const next = /* @__PURE__ */ new Map();
        const keep = (key, make, update) => {
          if (next.has(key)) return;
          let lyr = prev.get(key);
          if (lyr && group.hasLayer(lyr)) {
            update(lyr);
            prev.delete(key);
          } else {
            lyr = make();
            if (!lyr) return;
            lyr.addTo(group);
          }
          next.set(key, lyr);
        };
        for (const a of data.alerts || []) {
          const loc = a.location;
          if (!a.id || !loc || loc.x == null || loc.y == null) continue;
          const style = ALERT_STYLE[a.type] || DEFAULT_STYLE;
          const title = alertTitle(a);
          const meta = [placeStr(a), agoStr(a.pubMillis)].filter(Boolean).join(" · ");
          const thumbs = thumbsCount(a);
          const thumbStr = thumbs ? ` · 👍 ${thumbs}` : "";
          const desc = clip(a.reportDescription, 160);
          const descStr = desc ? esc`<br><i>${desc}</i>` : "";
          const by = clip(a.reportBy || a.provider, 48);
          const byStr = by ? esc`<br><span class="dw-cad-sub">via ${by}</span>` : "";
          const metaStr = meta || thumbStr ? esc`<br><span class="dw-cad-sub">${meta}${thumbStr}</span>` : "";
          const tip = esc`<b>${style.glyph} ${title}</b>` + descStr + metaStr + byStr;
          keep("a:" + a.id, () => {
            const icon = L.divIcon({
              className: "dw-waze-icon",
              html: `<div style="background:${style.color};width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;border:2px solid #fff;box-shadow:0 0 3px rgba(0,0,0,.6);">${style.glyph}</div>`,
              iconSize: [22, 22],
              iconAnchor: [11, 11]
            });
            const m = L.marker([loc.y, loc.x], {
              icon,
              pane: "dwWazePane",
              interactive: true
            }).bindTooltip(tip, { className: "dw-waze-tip", sticky: true });
            m._dwData = {
              color: style.color,
              name: title + (a.street ? " — " + a.street : "")
            };
            return m;
          }, (m) => m.setTooltipContent(tip));
        }
        for (const j of data.jams || []) {
          if (j.id == null || !Array.isArray(j.line) || j.line.length < 2)
            continue;
          const pts = j.line.filter((p) => p && p.x != null && p.y != null).map((p) => [p.y, p.x]);
          if (pts.length < 2) continue;
          const level = Math.max(0, Math.min(5, j.level || 0));
          const color = JAM_COLORS[level];
          const kmh = j.speed != null ? Math.round(j.speed * 3.6) : null;
          const spdStr = kmh != null ? kmh + " km/h" : "";
          const delayStr = j.delay > 0 ? "+" + Math.round(j.delay / 60) + " min" : "";
          const lenStr = j.length != null ? (j.length / 1e3).toFixed(1) + " km" : "";
          const place = placeStr(j);
          const endTo = clip(j.endNode, 40);
          const head = "Traffic" + (place ? " — " + place : "") + (endTo ? " → " + endTo : "");
          const meta = [spdStr, delayStr, lenStr, agoStr(j.updateMillis)].filter(Boolean).join(" · ");
          const ca = j.causeAlert;
          const cause = ca ? clip(alertTitle(ca) + (ca.reportDescription ? " — " + ca.reportDescription : ""), 140) : "";
          const causeStr = cause ? esc`<br><span class="dw-cad-sub">Cause: ${cause}</span>` : "";
          const tip = esc`<b>\u{1F697} ${head}</b>` + (meta ? esc`<br><span class="dw-cad-sub">${meta}</span>` : "") + causeStr;
          keep(
            "j:" + j.id,
            () => L.polyline(pts, {
              pane: "dwWazePane",
              color,
              weight: 5,
              opacity: 0.8,
              interactive: true
            }).bindTooltip(tip, { className: "dw-waze-tip", sticky: true }),
            (pl) => {
              pl.setLatLngs(pts);
              pl.setStyle({ color });
              pl.setTooltipContent(tip);
            }
          );
        }
        for (const u of data.users || []) {
          const loc = u.location;
          if (u.id == null || loc == null || loc.x == null || loc.y == null)
            continue;
          const named = u.userName && u.userName !== "guest" ? u.userName : "";
          const title = named || "Active Waze driver";
          const spd = u.speed != null && u.speed > 0 ? Math.round(u.speed * 3.6) + " km/h" : "";
          const coords = loc.y.toFixed(5) + ", " + loc.x.toFixed(5);
          const meta = [spd, coords].filter(Boolean).join(" · ");
          const emoji = moodEmoji(u.mood);
          const tip = esc`<b>${emoji} ${title}</b><br>` + esc`<span class="dw-cad-sub">${meta}</span>`;
          keep("u:" + u.id, () => {
            const m = L.marker([loc.y, loc.x], {
              icon: wazerIcon(emoji),
              pane: "dwWazePane",
              interactive: true
            }).bindTooltip(tip, { className: "dw-waze-tip", sticky: true });
            m._dwEmoji = emoji;
            m._dwData = { color: "#33ccff", name: title };
            return m;
          }, (m) => {
            m.setLatLng([loc.y, loc.x]);
            if (m._dwEmoji !== emoji) {
              m.setIcon(wazerIcon(emoji));
              m._dwEmoji = emoji;
            }
            m.setTooltipContent(tip);
          });
        }
        for (const lyr of prev.values()) {
          if (group.hasLayer(lyr)) group.removeLayer(lyr);
        }
        group._dwWaze = next;
      };
      const WazeLayer = pollingDataLayer({
        pane: "dwWazePane",
        paneZIndex: 445,
        minZoom: 9,
        pollMs: 3e4,
        attribution: 'Traffic © <a href="https://www.waze.com/live-map" target="_blank" rel="noreferrer">Waze</a>',
        fetch: (map, group) => {
          const b = map.getBounds();
          const c = map.getCenter();
          const url = GEORSS + "?top=" + b.getNorth().toFixed(6) + "&bottom=" + b.getSouth().toFixed(6) + "&left=" + b.getWest().toFixed(6) + "&right=" + b.getEast().toFixed(6) + "&env=" + wazeEnv(c.lat, c.lng) + "&types=alerts,traffic,users";
          getWazeToken().then((token) => {
            if (!token || !group._map) return;
            gmJsonGet(url, {
              headers: {
                Referer: "https://www.waze.com/live-map",
                "X-Recaptcha-Token": token
              }
            }, (err, data) => {
              if (err || !data || !group._map) return;
              render(group, data);
            });
          });
        }
      });
      return new WazeLayer();
    }
  };
  var MarineTrafficLayerProvider = class extends LayerProvider {
    create() {
      const MAX_TILES = 25;
      const MT_BASE = "https://www.marinetraffic.com/getData/get_data_json_4";
      function latLonToTile(lat, lon, z) {
        lat = Math.max(-85.0511, Math.min(85.0511, lat));
        const n = Math.pow(2, z);
        const x = Math.floor((lon + 180) / 360 * n);
        const rad = lat * Math.PI / 180;
        const y = Math.floor(
          (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * n
        );
        return {
          x: Math.max(0, Math.min(n - 1, x)),
          y: Math.max(0, Math.min(n - 1, y))
        };
      }
      function shipColor(type) {
        const t = parseInt(type) || 0;
        if (t === 7) return "#5B9BD5";
        if (t === 8) return "#D9534F";
        if (t === 6) return "#9B59B6";
        if (t === 4) return "#F0A500";
        if (t === 3) return "#2ECC71";
        if (t === 5) return "#2980B9";
        if (t >= 70 && t < 80) return "#5B9BD5";
        if (t >= 80 && t < 90) return "#D9534F";
        if (t >= 60 && t < 70) return "#9B59B6";
        if (t >= 40 && t < 50) return "#F0A500";
        if (t === 30) return "#2ECC71";
        if (t >= 36 && t <= 37) return "#2980B9";
        return "#90A4AE";
      }
      function renderShip(group, v) {
        const fill = shipColor(v.type);
        const svg = `<svg viewBox="0 0 14 20" width="14" height="20" xmlns="http://www.w3.org/2000/svg"><g transform="translate(7,10) rotate(${v.hdg})"><polygon points="0,-9 4.5,8 0,5 -4.5,8" fill="${fill}" stroke="#333" stroke-width="0.7"/></g></svg>`;
        const icon = L.divIcon({
          className: "dw-marine-icon",
          html: svg,
          iconSize: [14, 20],
          iconAnchor: [7, 10]
        });
        L.marker([v.lat, v.lon], { icon, pane: "dwMarinePane", interactive: true }).bindTooltip(
          esc`<b>${v.name}</b><br>MMSI: ${v.mmsi}<br>Speed: ${v.spdKts} kts Hdg: ${Math.round(v.hdg)}°`,
          { className: "dw-marine-tip", sticky: true }
        ).addTo(group);
      }
      function renderCluster(group, map, lat, lon, vessels) {
        const count = vessels.length;
        const size = count < 6 ? 22 : count < 21 ? 28 : 36;
        const fontPx = Math.round(size * 0.42);
        const fill = count < 6 ? "#5b9bd5" : count < 21 ? "#2e6a98" : "#1c4870";
        const icon = L.divIcon({
          className: "dw-marine-cluster",
          html: `<div style="background:${fill};color:#fff;width:${size}px;height:${size}px;border-radius:50%;display:flex;align-items:center;justify-content:center;font:bold ${fontPx}px/1 sans-serif;border:2px solid rgba(255,255,255,0.85);box-shadow:0 0 4px rgba(0,0,0,.5);">${count}</div>`,
          iconSize: [size, size],
          iconAnchor: [size / 2, size / 2]
        });
        const sample = vessels.slice(0, 5).map((v) => _escHtml(v.name)).join("<br>");
        const more = vessels.length > 5 ? `<br><i>+${vessels.length - 5} more</i>` : "";
        L.marker([lat, lon], { icon, pane: "dwMarinePane", interactive: true }).bindTooltip(
          `<b>${count} vessels</b><br><span class="dw-cad-sub">${sample}${more}</span>`,
          { className: "dw-marine-tip", sticky: true }
        ).on("click", () => {
          const zoom = Math.min(map.getZoom() + 2, map.getMaxZoom());
          const noMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
          if (noMotion) map.setView([lat, lon], zoom, { animate: false });
          else map.flyTo([lat, lon], zoom, { duration: 0.5 });
        }).addTo(group);
      }
      function renderRows(group, map, rows) {
        group.clearLayers();
        const pick = (obj, ...keys) => {
          for (const k of keys) {
            const v = obj[k];
            if (v !== void 0 && v !== null && v !== "") return v;
          }
          return "";
        };
        const vessels = [];
        for (const v of rows) {
          const lat = parseFloat(pick(v, "LAT", "lat"));
          const lon = parseFloat(pick(v, "LON", "lon"));
          if (!isFinite(lat) || !isFinite(lon)) continue;
          const name = String(pick(v, "SHIPNAME", "shipname", "NAME", "name", "MMSI") || "").trim() || "Unknown";
          const mmsi = pick(v, "MMSI", "mmsi") || "";
          const type = parseInt(pick(v, "SHIPTYPE", "shiptype", "TYPE", "type") || "0") || 0;
          const hdg = parseFloat(pick(v, "HEADING", "heading", "COURSE", "course") || "0") || 0;
          const rawSpd = parseFloat(pick(v, "SPEED", "speed") || "0") || 0;
          const spdKts = rawSpd > 102 ? (rawSpd / 10).toFixed(1) : rawSpd.toFixed(1);
          vessels.push({ lat, lon, name, mmsi, type, hdg, spdKts });
        }
        if (!vessels.length) return;
        const CELL_PX = 50;
        const zoom = map.getZoom();
        const cells = /* @__PURE__ */ new Map();
        for (const v of vessels) {
          const pt = map.project([v.lat, v.lon], zoom);
          const key = Math.floor(pt.x / CELL_PX) + "/" + Math.floor(pt.y / CELL_PX);
          let cell = cells.get(key);
          if (!cell) {
            cell = { vessels: [], sumLat: 0, sumLon: 0 };
            cells.set(key, cell);
          }
          cell.vessels.push(v);
          cell.sumLat += v.lat;
          cell.sumLon += v.lon;
        }
        for (const cell of cells.values()) {
          if (cell.vessels.length === 1) {
            renderShip(group, cell.vessels[0]);
          } else {
            renderCluster(
              group,
              map,
              cell.sumLat / cell.vessels.length,
              cell.sumLon / cell.vessels.length,
              cell.vessels
            );
          }
        }
      }
      const MTLayer = pollingDataLayer({
        pane: "dwMarinePane",
        paneZIndex: 440,
        minZoom: 6,
        pollMs: 2e4,
        attribution: 'Vessels © <a href="https://www.marinetraffic.com" target="_blank" rel="noreferrer">MarineTraffic</a>',
        fetch: (map, group) => {
          const tileZ = Math.max(4, Math.min(map.getZoom(), 8));
          const apiZ = tileZ + 1;
          const b = map.getBounds();
          const center = map.getCenter();
          const nw = latLonToTile(b.getNorth(), b.getWest(), tileZ);
          const se = latLonToTile(b.getSouth(), b.getEast(), tileZ);
          const tiles = [];
          for (let y = nw.y; y <= se.y && tiles.length < MAX_TILES; y++) {
            for (let x = nw.x; x <= se.x && tiles.length < MAX_TILES; x++) {
              tiles.push({ x, y });
            }
          }
          if (!tiles.length) return;
          const vessels = /* @__PURE__ */ new Map();
          let remaining = tiles.length;
          const referer = `https://www.marinetraffic.com/en/ais/home/centerx:${center.lng.toFixed(1)}/centery:${center.lat.toFixed(1)}/zoom:${tileZ}`;
          const done = () => {
            if (--remaining === 0 && group._map) {
              renderRows(group, map, [...vessels.values()]);
            }
          };
          for (const { x, y } of tiles) {
            const url = `${MT_BASE}/z:${apiZ}/X:${x}/Y:${y}/station:0`;
            gmJsonGet(url, {
              headers: {
                "Accept": "*/*",
                "X-Requested-With": "XMLHttpRequest",
                "Referer": referer
              }
            }, (err, parsed) => {
              if (err) {
                done();
                return;
              }
              const raw = parsed.data && parsed.data.rows || (Array.isArray(parsed.data) ? parsed.data : null) || (Array.isArray(parsed) ? parsed : null);
              if (!Array.isArray(raw)) {
                done();
                return;
              }
              let rows = raw;
              if (rows.length && Array.isArray(rows[0])) {
                const hdrs = rows[0];
                rows = rows.slice(1).map((row) => {
                  const obj = {};
                  hdrs.forEach((h, i) => {
                    obj[h] = row[i];
                  });
                  return obj;
                });
              }
              for (const v of rows) {
                const key = v.MMSI || v.mmsi || String(v.LAT || v.lat) + "," + String(v.LON || v.lon);
                if (key && !vessels.has(key)) vessels.set(key, v);
              }
              done();
            });
          }
        }
      });
      return new MTLayer();
    }
  };

  // src/providers/heatmaps.js
  var StravaHeatmapLayerProvider = class extends LayerProvider {
    create() {
      const layer = L.tileLayer(CFG.STRAVA_HEATMAP_TILE, {
        tileSize: 256,
        maxNativeZoom: 10,
        maxZoom: 25,
        opacity: 0.8,
        crossOrigin: false,
        attribution: "© Strava"
      });
      dwRegisterMbLayer(layer, (z, x, y) => dwMbGmFetchAB(
        CFG.STRAVA_HEATMAP_TILE.replace("{z}", z).replace("{x}", x).replace("{y}", y)
      ));
      return layer;
    }
  };
  var GarminHeatmapLayerProvider = class extends LayerProvider {
    create() {
      const ACTIVITIES = [
        "RUNNING",
        "HIKING",
        "TRAIL_RUNNING",
        "ROAD_CYCLING",
        "MOUNTAIN_BIKING"
      ];
      const garminMiss = /* @__PURE__ */ new Set();
      const GARMIN_MISS_MAX = 4096;
      const garminMissKey = (a, z, x, y) => a + "/" + z + "/" + x + "/" + y;
      const garminNoteMiss = (key) => {
        if (garminMiss.size < GARMIN_MISS_MAX) garminMiss.add(key);
      };
      const GarminHeatGrid = L.GridLayer.extend({
        createTile(coords, done) {
          const canvas = document.createElement("canvas");
          canvas.width = 256;
          canvas.height = 256;
          const ctx = canvas.getContext("2d");
          let remaining = ACTIVITIES.length;
          let failed = 0;
          canvas._dwHandles = [];
          const finish = () => {
            remaining--;
            if (remaining === 0) {
              canvas._dwHandles = null;
              if (failed === ACTIVITIES.length) {
                done(new Error("All Garmin activity tiles failed"), canvas);
              } else {
                done(null, canvas);
              }
            }
          };
          for (const activity of ACTIVITIES) {
            const missKey = garminMissKey(activity, coords.z, coords.x, coords.y);
            if (garminMiss.has(missKey)) {
              failed++;
              finish();
              continue;
            }
            const url = "https://connecttile.garmin.com/" + activity + "/" + coords.z + "/" + coords.x + "/" + coords.y + ".png";
            canvas._dwHandles.push(
              gmGet(url, { responseType: "arraybuffer" }, (err, r) => {
                if (err || r.status !== 200) {
                  garminNoteMiss(missKey);
                  failed++;
                  finish();
                  return;
                }
                const blob = new Blob([r.response], { type: "image/png" });
                const objUrl = URL.createObjectURL(blob);
                const img = new Image();
                img.onload = () => {
                  ctx.globalCompositeOperation = "lighter";
                  ctx.drawImage(img, 0, 0);
                  URL.revokeObjectURL(objUrl);
                  finish();
                };
                img.onerror = () => {
                  URL.revokeObjectURL(objUrl);
                  garminNoteMiss(missKey);
                  failed++;
                  finish();
                };
                img.src = objUrl;
              })
            );
          }
          return canvas;
        }
      });
      const layer = new GarminHeatGrid({
        tileSize: 256,
        minZoom: 4,
        maxNativeZoom: 17,
        maxZoom: 25,
        opacity: 0.8,
        attribution: "© Garmin"
      });
      wireTileAbort(layer);
      dwRegisterMbLayer(layer, async (z, x, y) => {
        const urls = ACTIVITIES.map((a) => "https://connecttile.garmin.com/" + a + "/" + z + "/" + x + "/" + y + ".png");
        const blobs = await Promise.all(urls.map((u) => dwMbGmFetchAB(u).then((ab) => new Blob([ab], { type: "image/png" })).catch(() => null)));
        const bitmaps = await Promise.all(blobs.map((b) => b ? createImageBitmap(b).catch(() => null) : null));
        const alive = bitmaps.filter(Boolean);
        if (!alive.length) throw new Error("All Garmin activity tiles failed");
        const canvas = new OffscreenCanvas(256, 256);
        const ctx = canvas.getContext("2d");
        ctx.globalCompositeOperation = "lighter";
        for (const bm of alive) ctx.drawImage(bm, 0, 0);
        const out = await canvas.convertToBlob({ type: "image/png" });
        return await out.arrayBuffer();
      });
      return layer;
    }
  };

  // src/providers/light-pollution.js
  var LightPollutionLayerProvider = class extends LayerProvider {
    create() {
      const TILE_PX = 256;
      const wmsParams = "?REQUEST=GetMap&SERVICE=WMS&VERSION=1.3.0&FORMAT=image%2Fpng&STYLES=" + encodeURIComponent(CFG.LIGHTPOL_WMS_STYLE) + "&TRANSPARENT=TRUE&LAYERS=" + encodeURIComponent(CFG.LIGHTPOL_WMS_LAYER) + "&TILED=true&SRS=EPSG%3A3857&CRS=EPSG%3A3857&WIDTH=" + TILE_PX + "&HEIGHT=" + TILE_PX;
      const LightPolWmsLayer = L.TileLayer.extend({
        getTileUrl(coords) {
          const bb = tileToBBox3857(coords.z, coords.x, coords.y);
          return CFG.LIGHTPOL_WMS_BASE + wmsParams + "&BBOX=" + bb.west + "," + bb.south + "," + bb.east + "," + bb.north;
        }
      });
      const layer = new LightPolWmsLayer("", {
        tileSize: TILE_PX,
        minZoom: 0,
        maxNativeZoom: 12,
        maxZoom: 25,
        opacity: 0.65,
        attribution: 'Light pollution © <a href="https://www.lightpollutionmap.info/" target="_blank" rel="noreferrer">lightpollutionmap.info</a>'
      });
      layer._dwMb3DUrl = CFG.LIGHTPOL_WMS_BASE + wmsParams + "&BBOX={bbox-epsg-3857}";
      return layer;
    }
  };

  // src/providers/qld-cadastre.js
  function _cadVal(v) {
    if (v === null || v === void 0) return "";
    const s = String(v).trim();
    return s && s !== "Null" ? s : "";
  }
  function _formatCadastreTooltip(attrs, addressInfo, omitSalesLink) {
    const lotPlan = _cadVal(attrs["Lot/plan"]) || (_cadVal(attrs.Lot) && _cadVal(attrs.Plan) ? attrs.Lot + attrs.Plan : "");
    const lines = [];
    if (lotPlan) lines.push(esc`<b>${lotPlan}</b>`);
    const name = _cadVal(attrs.Name);
    const alias = _cadVal(attrs.Alias);
    if (name) lines.push(_escHtml(name));
    else if (alias) lines.push(_escHtml(alias));
    if (addressInfo && addressInfo.primary) {
      let addrLine = _escHtml(addressInfo.primary);
      if (addressInfo.extra) addrLine += esc` <span class="dw-cad-sub">${addressInfo.extra}</span>`;
      lines.push(addrLine);
    }
    const bits = [];
    const tenure = _cadVal(attrs.Tenure);
    if (tenure) bits.push(tenure);
    const parcelType = _cadVal(attrs["Parcel type"]);
    if (parcelType && parcelType.toLowerCase() !== "lot") bits.push(parcelType);
    const area = parseFloat(attrs["Lot area (m²)"]);
    if (isFinite(area) && area > 0) {
      bits.push(
        area >= 1e4 ? (area / 1e4).toFixed(2) + " ha" : Math.round(area) + " m²"
      );
    }
    if (bits.length) lines.push(bits.join(" · "));
    const locality = _cadVal(attrs.Locality);
    const lga = _cadVal(attrs["Local authority"]);
    if (locality) lines.push(_escHtml(locality));
    if (lga) lines.push(esc`<span class="dw-cad-sub">${lga}</span>`);
    const links = [];
    const smis = _cadVal(attrs["SmartMap link"]);
    if (smis && /^https?:\/\//i.test(smis) && !/["'<>]/.test(smis)) {
      links.push(
        `<a class="dw-cad-link" href="${_escHtml(smis)}" target="_blank" rel="noreferrer">SmartMap ↗</a>`
      );
    }
    if (!omitSalesLink && addressInfo && isFinite(addressInfo.lat) && isFinite(addressInfo.lon) && addressInfo.streetName && addressInfo.streetNumber) {
      links.push(
        `<a class="dw-cad-link dw-cad-sales-link" href="#" data-lat="${addressInfo.lat}" data-lon="${addressInfo.lon}" data-lotplan="${(_cadVal(attrs["Lot/plan"]) || "").replace(/"/g, "&quot;")}">Sales ↗</a>`
      );
    }
    if (links.length) lines.push(links.join(" &nbsp; "));
    return lines.join("<br>") || "Parcel";
  }
  var _dwSalesHookInstalled = false;
  var _dwSalesMap = null;
  var _dwSalesGen = 0;
  function _renderSalesContent(result) {
    if (!result || !result.property) {
      const fallback = result && result.fallbackUrl ? `<div class="dw-sales-row"><a href="${_escHtml(result.fallbackUrl)}" target="_blank" rel="noreferrer">Open OnTheHouse search ↗</a></div>` : "";
      return `<div class="dw-sales-pop">
			<div class="dw-sales-err">${_escHtml(result && result.error || "No sales data.")}</div>
			${fallback}
		</div>`;
    }
    const p = result.property;
    const addr = p.address || {};
    const sale = p.lastSale || {};
    const guess = p.guesstimate || null;
    const headerAddr = addr.shortAddress || addr.formattedAddress || "";
    const stats = [];
    if (p.beds != null) stats.push(`<b>${p.beds}</b> bd`);
    if (p.baths != null) stats.push(`<b>${p.baths}</b> ba`);
    if (p.carSpaces != null) stats.push(`<b>${p.carSpaces}</b> car`);
    if (p.landSize) stats.push(`${p.landSize} m²`);
    if (p.yearBuilt) stats.push(`built ${p.yearBuilt}`);
    const statsLine = stats.length ? `<div class="dw-sales-stats">${stats.join(" · ")}${p.type ? ` <span class="dw-sales-sub">${_escHtml(p.type)}</span>` : ""}</div>` : "";
    let saleBlock = "";
    if (sale.salePrice || sale.eventDate) {
      const price = sale.salePrice ? _fmtPrice(sale.salePrice) : "";
      const when = _fmtDate(sale.eventDate);
      const ag = sale.sellingAgency && sale.sellingAgency.name;
      saleBlock = `<div class="dw-sales-row"><span class="dw-sales-k">Last sale</span>
			<span class="dw-sales-v"><b>${_escHtml(price || "—")}</b> · ${_escHtml(when || "?")}
			${ag ? `<span class="dw-sales-sub">${_escHtml(ag)}</span>` : ""}</span></div>`;
    }
    let avmBlock = "";
    if (guess && guess.price) {
      const lo = guess.fromPrice ? _fmtPrice(guess.fromPrice) : "";
      const hi = guess.toPrice ? _fmtPrice(guess.toPrice) : "";
      const range = lo && hi ? ` <span class="dw-sales-sub">(${lo}–${hi})</span>` : "";
      avmBlock = `<div class="dw-sales-row"><span class="dw-sales-k">Estimate</span>
			<span class="dw-sales-v"><b>${_escHtml(_fmtPrice(guess.price))}</b>${range}</span></div>`;
    }
    let eventsBlock = "";
    const events = Array.isArray(p.events) ? p.events.filter((e) => e && e.type === "SoldEvent") : [];
    if (events.length > 1) {
      const rows = events.slice(0, 6).map((e) => {
        const px = e.salePrice ? _fmtPrice(e.salePrice) : "—";
        const dt = _fmtDate(e.eventDate);
        const ag = e.agencyName || "";
        return `<li><b>${_escHtml(px)}</b> <span class="dw-sales-sub">${_escHtml(dt)}${ag ? " · " + _escHtml(ag) : ""}</span></li>`;
      }).join("");
      eventsBlock = `<div class="dw-sales-row"><span class="dw-sales-k">History</span>
			<ul class="dw-sales-events">${rows}</ul></div>`;
    }
    const lotplan = p.legalAttributes && p.legalAttributes["Lot/Plan"] || "";
    const lotBlock = lotplan ? `<div class="dw-sales-row"><span class="dw-sales-k">Lot/Plan</span><span class="dw-sales-v">${_escHtml(lotplan)}</span></div>` : "";
    const sourceLink = result.sourceUrl ? `<a class="dw-sales-source" href="${_escHtml(result.sourceUrl)}" target="_blank" rel="noreferrer">Open on OnTheHouse ↗</a>` : "";
    return `<div class="dw-sales-pop">
		<div class="dw-sales-hd">${_escHtml(headerAddr)}</div>
		${statsLine}
		${saleBlock}
		${avmBlock}
		${eventsBlock}
		${lotBlock}
		${sourceLink}
	</div>`;
  }
  function _openSalesPopup(latlng, addrInfo, lotplan) {
    if (!_dwSalesMap) return;
    const map = _dwSalesMap;
    const popup = L.popup({
      minWidth: 280,
      maxWidth: 360,
      autoPan: true,
      autoClose: true,
      closeOnClick: false,
      className: "dw-sales-pop-wrap"
    }).setLatLng(latlng).setContent(`<div class="dw-sales-pop"><div class="dw-sales-loading">Loading OnTheHouse data…</div></div>`).openOn(map);
    const gen = ++_dwSalesGen;
    const finish = (result) => {
      if (gen !== _dwSalesGen) return;
      if (!popup.isOpen()) return;
      popup.setContent(_renderSalesContent(result));
    };
    if (!lotplan) {
      fetchOthSales(addrInfo, finish);
      return;
    }
    cachedFetch(
      "oth_sales_" + lotplan,
      _CACHE_TTL.OTH_PROPERTY,
      (done) => fetchOthSales(addrInfo, (result) => {
        const persistable = result && (result.ok === true || result.ok === false && !/rate-limit|status \d{3}/.test(result.error || ""));
        done(null, persistable ? result : null);
        if (!persistable) finish(result);
      }),
      (err, cached) => {
        if (cached) finish(cached);
      }
    );
  }
  function _onSalesLinkClick(e) {
    const a = e.target && e.target.closest && e.target.closest(".dw-cad-sales-link");
    if (!a) return;
    e.preventDefault();
    e.stopPropagation();
    const lat = parseFloat(a.dataset.lat);
    const lon = parseFloat(a.dataset.lon);
    const lotplan = a.dataset.lotplan || "";
    if (!isFinite(lat) || !isFinite(lon)) return;
    const cached = getCachedCadastreAddress(lotplan);
    if (cached) {
      _openSalesPopup(L.latLng(lat, lon), cached, lotplan);
      return;
    }
    fetchCadastreAddress(lotplan, (info) => {
      if (!info) return;
      _openSalesPopup(L.latLng(lat, lon), info, lotplan);
    });
  }
  function _ensureSalesHook(map) {
    _dwSalesMap = map;
    if (_dwSalesHookInstalled) return;
    _dwSalesHookInstalled = true;
    document.addEventListener("click", _onSalesLinkClick, true);
  }
  function _formatAddressLine(rec) {
    if (!rec) return "";
    const unit = (rec.unit_number || "").trim();
    const unitType = (rec.unit_type || "").trim();
    const street = (rec.street_full || "").trim();
    const propName = (rec.property_name || "").trim();
    const parts = [];
    if (unit) parts.push(unitType ? `${unitType} ${unit}` : unit);
    if (street) parts.push(street);
    let line = parts.join(" / ");
    if (!line && propName) line = propName;
    else if (propName && !line.toLowerCase().includes(propName.toLowerCase()))
      line = line ? `${line} (${propName})` : propName;
    return line;
  }
  function fetchCadastreAddress(lotplan, cb) {
    if (!lotplan) {
      cb(null);
      return;
    }
    cachedFetch(
      "cad_addr_" + lotplan,
      _CACHE_TTL.CAD_ADDRESS,
      (done) => {
        const url = `${CFG.QLD_CADASTRE_SERVICE}/0/query?where=${encodeURIComponent(`lotplan='${lotplan.replace(/'/g, "''")}'`)}&outFields=street_full,unit_number,unit_type,property_name,street_number,street_name,street_type,locality,latitude,longitude&returnGeometry=false&f=json`;
        gmJsonGet(url, (err, data) => {
          if (err) {
            done(null, null);
            return;
          }
          const feats = (data.features || []).map((f) => f.attributes || {});
          const primaryRec = feats.find((a) => (a.street_full || "").trim()) || feats[0];
          const primary = _formatAddressLine(primaryRec);
          if (!primary) {
            done(null, null);
            return;
          }
          const extraCount = Math.max(0, feats.length - 1);
          done(null, {
            primary,
            extra: extraCount ? `+${extraCount} more` : "",
            // Structured bits the OnTheHouse lookup needs. Lat/lon
            // also anchors the sales popup at the parcel point.
            lat: parseFloat(primaryRec.latitude),
            lon: parseFloat(primaryRec.longitude),
            streetNumber: (primaryRec.street_number || "").trim(),
            streetName: (primaryRec.street_name || "").trim(),
            streetType: (primaryRec.street_type || "").trim(),
            locality: (primaryRec.locality || "").trim()
          });
        });
      },
      (err, info) => cb(err ? null : info)
    );
  }
  function getCachedCadastreAddress(lotplan) {
    if (!lotplan) return null;
    try {
      const raw = GM_getValue("dw_cache_cad_addr_" + lotplan, null);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.e !== 0 && parsed.e <= Date.now()) return null;
      return parsed.v || null;
    } catch (_) {
      return null;
    }
  }
  function _slugify(s) {
    return String(s || "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }
  var _OTH_STREET_TYPE = {
    STREET: "st",
    ROAD: "rd",
    AVENUE: "ave",
    DRIVE: "dr",
    LANE: "la",
    CRESCENT: "cres",
    PLACE: "pl",
    TERRACE: "tce",
    COURT: "ct",
    BOULEVARD: "bvd",
    BOULEVARDE: "bvd",
    CIRCUIT: "cct",
    HIGHWAY: "hwy",
    PARADE: "pde",
    CLOSE: "cl",
    WAY: "way",
    ESPLANADE: "esp",
    QUAY: "qy",
    CIRCLE: "cir",
    LINK: "lnk",
    MEWS: "mews",
    SQUARE: "sq",
    WALK: "wlk",
    ARCADE: "arc",
    ALLEY: "al",
    ROW: "row",
    VIEW: "vw",
    RIDGE: "rdge",
    RISE: "ri",
    BEND: "bend",
    LOOP: "loop",
    TRACK: "trk",
    TRAIL: "trl"
  };
  function _othStreetTypeSlug(type) {
    const up = String(type || "").trim().toUpperCase();
    return _OTH_STREET_TYPE[up] || _slugify(type);
  }
  function _othCanonicalUrlFromLocation(loc) {
    const suburbSlug = _slugify(loc.suburb);
    const streetSlug = _slugify(
      `${loc.streetNumber} ${loc.streetName} ${_othStreetTypeSlug(loc.streetType)}`
    );
    const tail = `${streetSlug}-${suburbSlug}-qld-${loc.postCode}`;
    return `${CFG.OTH_BASE}/property/qld/${suburbSlug}-${loc.postCode}/${tail}-${loc.propertyId}`;
  }
  function fetchOthLocations(query, cb) {
    cachedFetch(
      "oth_loc_" + query.toLowerCase().replace(/\s+/g, "_"),
      _CACHE_TTL.OTH_LOCATIONS,
      (done) => {
        const url = `${CFG.OTH_BASE}/odin/api/locations?query=` + encodeURIComponent(query);
        gmJsonGet(url, (err, data, raw) => {
          if (err) {
            done(null, { error: err.message, status: raw && raw.status });
            return;
          }
          done(null, { content: Array.isArray(data.content) ? data.content : [] });
        });
      },
      (_err, result) => cb(result || { error: "cache miss" })
    );
  }
  function fetchOthSales(addrInfo, cb) {
    if (!addrInfo.streetNumber) {
      cb({
        ok: false,
        error: "This parcel has no street number in QLD's cadastre — OnTheHouse can't look it up."
      });
      return;
    }
    const qParts = [];
    if (addrInfo.streetNumber) qParts.push(addrInfo.streetNumber);
    if (addrInfo.streetName) qParts.push(addrInfo.streetName);
    if (addrInfo.streetType) qParts.push(addrInfo.streetType);
    if (addrInfo.locality) qParts.push(addrInfo.locality);
    qParts.push("QLD");
    const query = qParts.join(" ").trim();
    fetchOthLocations(query, (locResult) => {
      if (locResult && locResult.error) {
        cb({
          ok: false,
          error: locResult.status === 429 ? "OnTheHouse is rate-limiting us — try again in a minute." : `Couldn't reach OnTheHouse (${locResult.error}).`
        });
        return;
      }
      const candidates = (locResult.content || []).filter(
        (p) => p && /^\d+$/.test(String(p.propertyId || ""))
      );
      const wantNum = String(addrInfo.streetNumber || "").toUpperCase();
      const wantName = String(addrInfo.streetName || "").toUpperCase();
      const match = candidates.find(
        (p) => String(p.streetNumber || "").toUpperCase() === wantNum && String(p.streetName || "").toUpperCase() === wantName
      ) || candidates.find(
        (p) => String(p.streetNumber || "").toUpperCase() === wantNum
      ) || candidates[0];
      if (!match) {
        cb({
          ok: false,
          error: "OnTheHouse doesn't have a record for this address."
        });
        return;
      }
      const pid = match.propertyId;
      const sourceUrl = _othCanonicalUrlFromLocation(match);
      let coreRes = null, eventsRes = null, done = false;
      const finish = () => {
        if (done) return;
        if (coreRes === null || eventsRes === null) return;
        done = true;
        if (coreRes.error) {
          cb({
            ok: false,
            error: "Couldn't fetch OnTheHouse property data.",
            fallbackUrl: sourceUrl
          });
          return;
        }
        const property = Object.assign({}, coreRes.data, {
          events: eventsRes.data && eventsRes.data.content || []
        });
        cb({ ok: true, property, sourceUrl });
      };
      cachedFetch(
        "oth_prop_" + pid,
        _CACHE_TTL.OTH_PROPERTY,
        (d) => gmJsonGet(
          `${CFG.OTH_BASE}/odin/api/properties/${pid}`,
          (err, data) => d(err, err ? void 0 : { data })
        ),
        (e, r) => {
          coreRes = r || { error: e ? e.message : "cache miss" };
          finish();
        }
      );
      cachedFetch(
        "oth_evt_" + pid,
        _CACHE_TTL.OTH_EVENTS,
        (d) => gmJsonGet(
          `${CFG.OTH_BASE}/odin/api/properties/${pid}/events`,
          (err, data) => d(err, err ? void 0 : { data })
        ),
        (e, r) => {
          eventsRes = r || { error: e ? e.message : "cache miss" };
          finish();
        }
      );
    });
  }
  function installCadastreHover(layer, map) {
    _ensureSalesHook(map);
  }
  var QldCadastreLayerProvider = arcgisExportProvider({
    baseUrl: CFG.QLD_CADASTRE_SERVICE,
    showLayers: String(CFG.QLD_CADASTRE_LAYER_ID),
    pane: "dwCadastrePane",
    paneZIndex: 385,
    opacity: 0.75,
    minZoom: 11,
    maxZoom: 25,
    attribution: 'Cadastre &copy; <a href="https://www.qld.gov.au/dnrme" target="_blank" rel="noreferrer">State of Queensland (DCDB)</a>',
    onAdd: (layer, map) => installCadastreHover(layer, map),
    onRemove: (layer) => {
      if (layer._dwHoverOff) {
        layer._dwHoverOff();
        layer._dwHoverOff = null;
      }
    }
  });

  // src/utils/mvt.js
  function mvtDecode(buf) {
    const layers = [];
    const view = new Uint8Array(buf);
    let off = 0;
    while (off < view.length) {
      const tag = readVarint(view, off);
      off = tag.end;
      const fn = tag.v >>> 3, wt = tag.v & 7;
      if (fn === 3 && wt === 2) {
        const len = readVarint(view, off);
        off = len.end;
        layers.push(parseLayer(view.subarray(off, off + len.v)));
        off += len.v;
      } else {
        off = skipField(view, off, wt);
      }
    }
    return layers;
  }
  function readVarint(buf, off) {
    let result = 0, shift = 0, b;
    do {
      b = buf[off++];
      result |= (b & 127) << shift;
      shift += 7;
    } while (b & 128);
    return { v: result >>> 0, end: off };
  }
  function skipField(buf, off, wireType) {
    if (wireType === 0) {
      return readVarint(buf, off).end;
    } else if (wireType === 1) {
      return off + 8;
    } else if (wireType === 2) {
      const r = readVarint(buf, off);
      return r.end + r.v;
    } else if (wireType === 5) {
      return off + 4;
    }
    return off;
  }
  function parseLayer(buf) {
    const info = { name: "", extent: 4096, keys: [], values: [], features: [] };
    let off = 0;
    while (off < buf.length) {
      const tag = readVarint(buf, off);
      off = tag.end;
      const fn = tag.v >>> 3, wt = tag.v & 7;
      if (fn === 1 && wt === 2) {
        const r = readVarint(buf, off);
        off = r.end;
        info.name = utf8(buf, off, r.v);
        off += r.v;
      } else if (fn === 5 && wt === 0) {
        const r = readVarint(buf, off);
        off = r.end;
        info.extent = r.v;
      } else if (fn === 3 && wt === 2) {
        const r = readVarint(buf, off);
        off = r.end;
        info.keys.push(utf8(buf, off, r.v));
        off += r.v;
      } else if (fn === 4 && wt === 2) {
        const r = readVarint(buf, off);
        off = r.end;
        info.values.push(parseValue(buf.subarray(off, off + r.v)));
        off += r.v;
      } else if (fn === 2 && wt === 2) {
        const r = readVarint(buf, off);
        off = r.end;
        info.features.push(parseFeature(buf.subarray(off, off + r.v)));
        off += r.v;
      } else {
        off = skipField(buf, off, wt);
      }
    }
    return info;
  }
  function parseValue(buf) {
    let off = 0;
    while (off < buf.length) {
      const tag = readVarint(buf, off);
      off = tag.end;
      const fn = tag.v >>> 3, wt = tag.v & 7;
      if (fn === 1 && wt === 2) {
        const r = readVarint(buf, off);
        off = r.end;
        return utf8(buf, off, r.v);
      }
      if (fn === 2 && wt === 5) {
        return new DataView(buf.buffer, buf.byteOffset + off).getFloat32(0, true);
      }
      if (fn === 3 && wt === 1) {
        return new DataView(buf.buffer, buf.byteOffset + off).getFloat64(0, true);
      }
      if ((fn === 4 || fn === 5) && wt === 0) {
        return readVarint(buf, off).v;
      }
      if (fn === 6 && wt === 0) {
        const v = readVarint(buf, off).v;
        return v >>> 1 ^ -(v & 1);
      }
      if (fn === 7 && wt === 0) {
        return readVarint(buf, off).v !== 0;
      }
      off = skipField(buf, off, wt);
    }
    return null;
  }
  function parseFeature(buf) {
    const f = { tags: [], type: 0, geom: [] };
    let off = 0;
    while (off < buf.length) {
      const tag = readVarint(buf, off);
      off = tag.end;
      const fn = tag.v >>> 3, wt = tag.v & 7;
      if (fn === 2 && wt === 2) {
        const r = readVarint(buf, off);
        off = r.end;
        const end = off + r.v;
        while (off < end) {
          const x = readVarint(buf, off);
          off = x.end;
          f.tags.push(x.v);
        }
      } else if (fn === 3 && wt === 0) {
        const r = readVarint(buf, off);
        off = r.end;
        f.type = r.v;
      } else if (fn === 4 && wt === 2) {
        const r = readVarint(buf, off);
        off = r.end;
        const end = off + r.v;
        while (off < end) {
          const x = readVarint(buf, off);
          off = x.end;
          f.geom.push(x.v);
        }
      } else {
        off = skipField(buf, off, wt);
      }
    }
    return f;
  }
  function decodeGeometry(geom) {
    const rings = [];
    let ring = null;
    let i = 0, x = 0, y = 0;
    while (i < geom.length) {
      const cmd = geom[i] & 7;
      const count = geom[i] >>> 3;
      i++;
      if (cmd === 1) {
        for (let k = 0; k < count; k++) {
          x += zig(geom[i++]);
          y += zig(geom[i++]);
          if (ring && ring.length) rings.push(ring);
          ring = [[x, y]];
        }
      } else if (cmd === 2) {
        for (let k = 0; k < count; k++) {
          x += zig(geom[i++]);
          y += zig(geom[i++]);
          ring.push([x, y]);
        }
      } else if (cmd === 7) {
        if (ring) {
          rings.push(ring);
          ring = null;
        }
      }
    }
    if (ring && ring.length) rings.push(ring);
    return rings;
  }
  function zig(n) {
    return n >>> 1 ^ -(n & 1);
  }
  function utf8(buf, off, len) {
    let s = "";
    let allAscii = true;
    for (let i = 0; i < len; i++) {
      const b = buf[off + i];
      if (b > 127) {
        allAscii = false;
        break;
      }
      s += String.fromCharCode(b);
    }
    return allAscii ? s : new TextDecoder().decode(buf.subarray(off, off + len));
  }
  function prepareLayers(layers, fillAlpha) {
    const out = [];
    const fillCache = /* @__PURE__ */ new Map();
    for (const layer of layers) {
      if (layer.name !== "territories") continue;
      const features = [];
      for (const f of layer.features) {
        if (f.type !== 3) continue;
        const props = {};
        for (let i = 0; i < f.tags.length; i += 2) {
          props[layer.keys[f.tags[i]]] = layer.values[f.tags[i + 1]];
        }
        const colour = props.colour || "#3b82f6";
        let fillStyle = fillCache.get(colour);
        if (!fillStyle) {
          fillStyle = hexAlpha(colour, fillAlpha);
          fillCache.set(colour, fillStyle);
        }
        const rings = decodeGeometry(f.geom);
        let mnX = Infinity, mnY = Infinity, mxX = -Infinity, mxY = -Infinity;
        for (const ring of rings) {
          for (const p of ring) {
            const x = p[0], y = p[1];
            if (x < mnX) mnX = x;
            if (x > mxX) mxX = x;
            if (y < mnY) mnY = y;
            if (y > mxY) mxY = y;
          }
        }
        features.push({
          props,
          colour,
          fillStyle,
          startTime: typeof props.startTime === "number" ? props.startTime : 0,
          rings,
          mnX,
          mnY,
          mxX,
          mxY
        });
      }
      features.sort((a, b) => a.startTime - b.startTime);
      out.push({ name: layer.name, extent: layer.extent, features });
    }
    return out;
  }

  // src/providers/intvl-global.js
  var tileKey = (z, x, y) => `${z}/${x}/${y}`;
  var IntvlGlobalTilesLayerProvider = class extends LayerProvider {
    create() {
      const TILE_PX = 256;
      const FILL_ALPHA = 0.55;
      const IntvlGlobalGrid = L.GridLayer.extend({
        onAdd(map) {
          if (!map.getPane("dwIntvlGlobalPane")) {
            map.createPane("dwIntvlGlobalPane");
            map.getPane("dwIntvlGlobalPane").style.zIndex = "404";
            map.getPane("dwIntvlGlobalPane").style.pointerEvents = "none";
          }
          L.GridLayer.prototype.onAdd.call(this, map);
          this._tooltip = L.tooltip({
            sticky: true,
            opacity: 0.95,
            className: "dw-intvl-tip",
            direction: "right",
            offset: [12, 0]
          });
          this._hoverDebounce = null;
          this._lastFeatKey = null;
          const noHover = L.Browser.mobile || window.matchMedia && window.matchMedia("(hover: none)").matches;
          if (!noHover) {
            this._onMove = (e) => {
              if (!e?.latlng) return;
              clearTimeout(this._hoverDebounce);
              const latlng = e.latlng;
              this._hoverDebounce = setTimeout(
                () => this._identifyHover(latlng),
                60
              );
            };
            this._onLeave = () => {
              clearTimeout(this._hoverDebounce);
              this._clearTooltip();
            };
            map.on("mousemove", this._onMove);
            map.on("mouseout", this._onLeave);
          }
          this._onTileUnload = (e) => {
            if (e.tile && e.tile._dwHandle) {
              gmCancel(e.tile._dwHandle);
              e.tile._dwHandle = null;
            }
            if (!this._tileFeatures) return;
            const c = e.coords;
            this._tileFeatures.delete(tileKey(c.z, c.x, c.y));
          };
          this.on("tileunload", this._onTileUnload);
        },
        onRemove(map) {
          clearTimeout(this._hoverDebounce);
          if (this._onMove) {
            map.off("mousemove", this._onMove);
            map.off("mouseout", this._onLeave);
          }
          this.off("tileunload", this._onTileUnload);
          this._clearTooltip();
          this._tooltip = null;
          this._tileFeatures && this._tileFeatures.clear();
          L.GridLayer.prototype.onRemove.call(this, map);
        },
        _clearTooltip() {
          if (this._tooltip && this._tooltip._map) this._tooltip.remove();
          this._lastFeatKey = null;
        },
        createTile(coords, done) {
          const canvas = L.DomUtil.create("canvas", "leaflet-tile");
          const dpr = Math.max(1, window.devicePixelRatio || 1);
          canvas.width = TILE_PX * dpr;
          canvas.height = TILE_PX * dpr;
          canvas.style.width = TILE_PX + "px";
          canvas.style.height = TILE_PX + "px";
          const ctx = canvas.getContext("2d");
          ctx.scale(dpr, dpr);
          const url = `${CFG.INTVL_TILES_BASE}/${coords.z}/${coords.x}/${coords.y}.pbf`;
          canvas._dwHandle = gmGet(url, {
            responseType: "arraybuffer",
            timeout: 15e3
          }, (err, r) => {
            canvas._dwHandle = null;
            if (err || r.status !== 200 || !r.response) {
              safeDone();
              return;
            }
            try {
              const layers = mvtDecode(r.response);
              const prepared = prepareLayers(layers, FILL_ALPHA);
              this._renderTile(ctx, prepared, TILE_PX);
              if (!this._tileFeatures) this._tileFeatures = /* @__PURE__ */ new Map();
              this._tileFeatures.set(
                tileKey(coords.z, coords.x, coords.y),
                prepared
              );
            } catch (e) {
              console.warn("[CustomTiles] INTVL global decode:", e);
            }
            safeDone();
          });
          function safeDone() {
            try {
              done(null, canvas);
            } catch (e) {
              if (!String(e?.message || "").includes("style")) throw e;
            }
          }
          return canvas;
        },
        _renderTile(ctx, prepared, tilePx) {
          ctx.clearRect(0, 0, tilePx, tilePx);
          for (const layer2 of prepared) {
            const scale = tilePx / layer2.extent;
            for (const f of layer2.features) {
              ctx.beginPath();
              for (const ring of f.rings) {
                if (ring.length < 3) continue;
                let started = false;
                for (const [tx, ty] of ring) {
                  const px = tx * scale, py = ty * scale;
                  if (!started) {
                    ctx.moveTo(px, py);
                    started = true;
                  } else ctx.lineTo(px, py);
                }
                ctx.closePath();
              }
              ctx.fillStyle = f.fillStyle;
              ctx.fill();
            }
          }
        },
        _identifyHover(latlng) {
          if (!this._tileFeatures || !this._tileFeatures.size) return;
          const map = this._map;
          if (!map || !this._tooltip) return;
          const z = map.getZoom();
          const cappedZ = Math.min(z, CFG.INTVL_TILES_MAX_NATIVE_Z);
          const proj = map.project(latlng, cappedZ);
          const tileX = Math.floor(proj.x / TILE_PX);
          const tileY = Math.floor(proj.y / TILE_PX);
          const prepared = this._tileFeatures.get(
            tileKey(cappedZ, tileX, tileY)
          );
          if (!prepared) {
            this._clearTooltip();
            return;
          }
          for (const layer2 of prepared) {
            const scaleInv = layer2.extent / TILE_PX;
            const ex = (proj.x - tileX * TILE_PX) * scaleInv;
            const ey = (proj.y - tileY * TILE_PX) * scaleInv;
            for (let fi = layer2.features.length - 1; fi >= 0; fi--) {
              const f = layer2.features[fi];
              if (ex < f.mnX || ex > f.mxX || ey < f.mnY || ey > f.mxY) continue;
              let inside = false;
              for (const ring of f.rings) {
                if (ring.length < 3) continue;
                if (pointInRing(ex, ey, ring)) inside = !inside;
              }
              if (!inside) continue;
              const featKey = tileKey(cappedZ, tileX, tileY) + "/" + fi;
              if (featKey === this._lastFeatKey) {
                this._tooltip.setLatLng(latlng);
                return;
              }
              this._lastFeatKey = featKey;
              const area = intvlArea(f.props.currentArea);
              let dayDate = null;
              if (typeof f.props.startTime === "number") {
                const unixDay = f.props.startTime + CFG.INTVL_START_TIME_EPOCH_OFFSET_DAYS;
                dayDate = new Date(unixDay * 86400 * 1e3);
              }
              const actDate = intvlActivityTime(f.props.activityId);
              const fmtDay = (d) => d.toLocaleDateString(
                void 0,
                { day: "numeric", month: "short", year: "numeric" }
              );
              const fmtDateTime = (d) => d.toLocaleString(void 0, {
                day: "numeric",
                month: "short",
                year: "numeric",
                hour: "numeric",
                minute: "2-digit"
              });
              let whenLine;
              if (actDate) {
                whenLine = `Recorded ${fmtDateTime(actDate)} <span class="dw-cad-sub">(${intvlAgo(actDate)})</span>`;
              } else if (dayDate) {
                whenLine = `Captured ${fmtDay(dayDate)} <span class="dw-cad-sub">(${intvlAgo(dayDate)})</span>`;
              } else {
                whenLine = "Capture date unknown";
              }
              const swatch = `<span style="display:inline-block;width:10px;height:10px;background:${_safeColor(f.colour, "#3b82f6")};border:1px solid #444;vertical-align:middle"></span>`;
              const html = `<b>${swatch} ${area}</b> territory<br>${whenLine}`;
              this._tooltip.setLatLng(latlng).setContent(html);
              if (!this._tooltip._map) this._tooltip.addTo(map);
              return;
            }
          }
          this._clearTooltip();
        },
        getAttribution() {
          return 'Global territories © <a href="https://www.intvl.com.au" target="_blank" rel="noreferrer">INTVL</a>';
        }
      });
      const layer = new IntvlGlobalGrid({
        tileSize: TILE_PX,
        minZoom: 4,
        maxNativeZoom: CFG.INTVL_TILES_MAX_NATIVE_Z,
        maxZoom: 25,
        opacity: 1,
        pane: "dwIntvlGlobalPane"
      });
      layer._dwMb3DStyle = {
        sources: {
          src: {
            type: "vector",
            tiles: [`${CFG.INTVL_TILES_BASE}/{z}/{x}/{y}.pbf`],
            minzoom: 0,
            maxzoom: CFG.INTVL_TILES_MAX_NATIVE_Z
          }
        },
        layers: [{
          id: "fill",
          type: "fill",
          source: "src",
          "source-layer": "territories",
          paint: {
            // INTVL features already store `#RRGGBB` (with the
            // leading hash). Mapbox's `to-color` reads that
            // directly; do NOT concat another `#` or every
            // feature comes back as `##RRGGBB` and the entire
            // expression throws "could not parse color".
            "fill-color": [
              "case",
              ["has", "colour"],
              ["to-color", ["get", "colour"]],
              "#888"
            ],
            "fill-opacity": 0.55,
            "fill-emissive-strength": 0.85
          }
        }]
      };
      return layer;
    }
  };

  // src/providers/qld-environment.js
  function makeArcgisQueryLayer(opts, gmJsonGet2) {
    const debounceMs = opts.debounceMs || 400;
    const timeoutMs = opts.timeoutMs || 3e4;
    const padBounds = opts.padBounds || 0;
    const Layer = L.Layer.extend({
      initialize() {
        this._group = null;
        this._debounce = null;
        this._lastBbox = null;
        this._gen = 0;
        this._byKey = /* @__PURE__ */ new Map();
      },
      onAdd(map) {
        if (!map.getPane(opts.pane)) {
          map.createPane(opts.pane);
          map.getPane(opts.pane).style.zIndex = String(opts.paneZIndex);
        }
        this._group = L.layerGroup().addTo(map);
        this._fetch();
        map.on("moveend zoomend", this._onViewChange, this);
      },
      onRemove(map) {
        clearTimeout(this._debounce);
        this._debounce = null;
        this._gen++;
        map.off("moveend zoomend", this._onViewChange, this);
        if (this._group) {
          this._group.remove();
          this._group = null;
        }
        this._byKey.clear();
      },
      _onViewChange() {
        clearTimeout(this._debounce);
        this._debounce = setTimeout(() => this._fetch(), debounceMs);
      },
      _fetch() {
        const map = this._map;
        if (!map || !this._group) return;
        const z = map.getZoom();
        if (z < opts.minZoom) {
          this._group.clearLayers();
          this._byKey.clear();
          this._lastBbox = null;
          return;
        }
        const b = padBounds ? map.getBounds().pad(padBounds) : map.getBounds();
        const bbox = `${b.getWest().toFixed(4)},${b.getSouth().toFixed(4)},${b.getEast().toFixed(4)},${b.getNorth().toFixed(4)}`;
        if (bbox === this._lastBbox) return;
        this._lastBbox = bbox;
        const myGen = ++this._gen;
        const offset = 360 / (256 * Math.pow(2, z)) * 2;
        let url, gmOpts = { timeout: timeoutMs };
        if (opts.buildRequest) {
          const req = opts.buildRequest(bbox, z);
          url = req.url;
          Object.assign(gmOpts, req.gmOpts || {});
        } else {
          url = opts.queryUrl + "?f=geojson&returnGeometry=true&geometryType=esriGeometryEnvelope&inSR=4326&outSR=4326&spatialRel=esriSpatialRelIntersects&geometryPrecision=5&where=" + encodeURIComponent(opts.where) + "&outFields=" + encodeURIComponent(opts.outFields) + "&geometry=" + encodeURIComponent(bbox) + "&maxAllowableOffset=" + offset + // Deterministic order matters when the server truncates
          // at maxRecordCount — newest applications survive the cut.
          (opts.orderBy ? "&orderByFields=" + encodeURIComponent(opts.orderBy) : "");
        }
        gmJsonGet2(url, gmOpts, (err, raw) => {
          const geojson = !err && opts.transform ? opts.transform(raw) : raw;
          if (myGen !== this._gen || !this._group) return;
          if (err || geojson && geojson.error) {
            console.warn(
              `[CustomTiles] ${opts.label} request error`,
              err ? err.message : JSON.stringify(geojson.error)
            );
            return;
          }
          const geoOpts = {
            pane: opts.pane,
            style: () => opts.style,
            onEachFeature: (f, lyr) => {
              const tip = opts.tooltip && opts.tooltip(f.properties || {});
              if (tip) lyr.bindTooltip(tip, {
                className: opts.tipClass || "dw-park-tip",
                sticky: true
              });
              const pop = opts.popup && opts.popup(f.properties || {});
              if (pop) lyr.bindPopup(pop, opts.popupOpts || {});
            }
          };
          if (opts.pointToLayer) {
            geoOpts.pointToLayer = (f, latlng) => opts.pointToLayer(f, latlng);
          }
          if (!opts.featureKey) {
            this._group.clearLayers();
            L.geoJSON(geojson, geoOpts).addTo(this._group);
            return;
          }
          const next = /* @__PURE__ */ new Map();
          for (const f of geojson && geojson.features || []) {
            const k = opts.featureKey(f);
            if (k != null) next.set(String(k), f);
          }
          for (const [k, lyr] of this._byKey) {
            if (next.has(k)) continue;
            this._group.removeLayer(lyr);
            this._byKey.delete(k);
          }
          for (const [k, f] of next) {
            if (this._byKey.has(k)) continue;
            const lyr = L.geoJSON(f, geoOpts);
            this._byKey.set(k, lyr);
            this._group.addLayer(lyr);
          }
        });
      },
      getAttribution() {
        return opts.attribution;
      }
    });
    return new Layer();
  }
  function createQldEnvironmentProviders({ makeHoverIdentify: makeHoverIdentify2, gmJsonGet: gmJsonGet2 }) {
    const installQpwsHover = makeHoverIdentify2({
      baseUrl: CFG.QLD_QPWS_SERVICE,
      layers: "all:10",
      tolerance: 5,
      minZoom: CFG.QLD_QPWS_HOVER_MIN_ZOOM,
      tipClass: "dw-qpws-tip",
      formatTooltip: (a) => {
        const name = a.NAME || a.name || a.PARK_NAME || a.park_name || "";
        const type = a.FEAT_TYPE || a.feat_type || a.MANAGE_TYPE || a.manage_type || "";
        const lines = [];
        if (name) lines.push(esc`<b>${name}</b>`);
        if (type) lines.push(_escHtml(type));
        return lines.join("<br>") || "Protected area";
      }
    });
    const QpwsLayerProvider2 = arcgisExportProvider({
      baseUrl: CFG.QLD_QPWS_SERVICE,
      showLayers: CFG.QLD_QPWS_LAYER_IDS,
      pane: "dwQpwsPane",
      paneZIndex: 396,
      opacity: 0.85,
      minZoom: 9,
      maxZoom: 25,
      attribution: 'QPWS &copy; <a href="https://parks.qld.gov.au/" target="_blank" rel="noreferrer">State of Queensland (DETSI)</a>',
      onAdd: (layer, map) => installQpwsHover(layer, map),
      onRemove: (layer) => {
        if (layer._dwHoverOff) {
          layer._dwHoverOff();
          layer._dwHoverOff = null;
        }
      }
    });
    class NationalParksLayerProvider2 extends LayerProvider {
      create() {
        return makeArcgisQueryLayer({
          label: "National Parks",
          pane: "dwNationalParksPane",
          paneZIndex: 397,
          minZoom: 8,
          queryUrl: CFG.QLD_QPWS_SERVICE + "/10/query",
          where: "esttype IN ('NP','NS','NY','NA')",
          outFields: "estatename,esttype",
          style: {
            color: "#166534",
            weight: 1,
            opacity: 0.9,
            fillColor: "#22c55e",
            fillOpacity: 0.22
          },
          tipClass: "dw-park-tip",
          tooltip: (p) => {
            const name = p.estatename || p.ESTATENAME || p.NAME || "National Park";
            const type = p.esttype || p.ESTTYPE || "";
            return esc`<b>${name}</b>` + (type ? `<br>${_escHtml(type)}` : "");
          },
          attribution: 'QPWS &copy; <a href="https://parks.qld.gov.au/" target="_blank" rel="noreferrer">State of Queensland (DETSI)</a>'
        }, gmJsonGet2);
      }
    }
    return { QpwsLayerProvider: QpwsLayerProvider2, NationalParksLayerProvider: NationalParksLayerProvider2 };
  }

  // src/providers/scc-applications.js
  var PANE = "dwSccAppsPane";
  var PANE_Z = 398;
  var _KIND = {
    DA: { liveId: 0, pastId: 1, label: "Development", color: "#8b5cf6", param: "DANumber" },
    BA: { liveId: 2, pastId: 3, label: "Building", color: "#f59e0b", param: "BANumber" },
    PL: { liveId: 4, pastId: 5, label: "Plumbing", color: "#0ea5e9", param: "PlumbNumber" }
  };
  var _APP_FIELDS = "ram_id,group_desc,category_desc,description,decision,progress,assessment_level,d_date_rec,d_decision_made";
  var _touchCached = null;
  function _isTouch() {
    if (_touchCached === null) {
      _touchCached = !!(typeof L !== "undefined" && L.Browser && L.Browser.mobile) || !!(typeof window !== "undefined" && window.matchMedia && window.matchMedia("(hover: none)").matches);
    }
    return _touchCached;
  }
  function _fmtSccDate(ms) {
    const n = Number(ms);
    if (!isFinite(n) || n <= 0) return "";
    const d = new Date(n);
    const months = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec"
    ];
    return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
  }
  var _clip = (s, n) => {
    const t = String(s || "").trim().replace(/\s+/g, " ");
    return t.length > n ? t.slice(0, n - 1) + "…" : t;
  };
  function _deviAppUrl(kind, ramId) {
    const meta = _KIND[kind];
    const id = String(ramId || "").trim();
    if (!meta || !id || !/^[A-Za-z0-9/\-. ]+$/.test(id)) return "";
    return CFG.SCC_DEVI_BASE + "/Home/FilterDirect?filters=" + encodeURIComponent(meta.param + "=" + id);
  }
  function _formatSccTooltip(p, kind, live) {
    const meta = _KIND[kind];
    const status = live ? p.progress || "In Progress" : p.decision || "Decided";
    const chip = live ? "dw-scc-chip--live" : "dw-scc-chip--past";
    const lines = [];
    lines.push(
      esc`<span class="dw-scc-tip-hd"><b>${p.ram_id || "Application"}</b>` + `<span class="dw-scc-chip ${chip}">${_escHtml(status)}</span></span>`
    );
    const cat = String(p.category_desc || "").trim();
    const catLine = [meta.label, cat && cat !== meta.label ? cat : ""].filter(Boolean).join(" · ");
    if (catLine) lines.push(esc`<span class="dw-scc-tip-cat">${catLine}</span>`);
    const desc = _clip(p.description, 90);
    if (desc) lines.push(esc`<span class="dw-scc-sub">${desc}</span>`);
    const when = live ? p.d_date_rec ? "Lodged " + _fmtSccDate(p.d_date_rec) : "" : p.d_decision_made ? "Decided " + _fmtSccDate(p.d_decision_made) : "";
    if (when) lines.push(esc`<span class="dw-scc-sub">${when}</span>`);
    return lines.join("<br>");
  }
  var _DEVI_TYPE = {
    DA: "plan_scc_development_apps_unique",
    BA: "plan_scc_building_apps_unique",
    PL: "plan_scc_plumbing_apps_unique"
  };
  var _DEVI_APPTYPE = { DA: "development", BA: "building", PL: "plumbing" };
  function _validRamId(ramId) {
    const id = String(ramId || "").trim();
    return id && /^[A-Za-z0-9/\-. ]+$/.test(id) ? id : "";
  }
  function _deviDetailUrl(kind, ramId) {
    const type = _DEVI_TYPE[kind];
    const id = _validRamId(ramId);
    if (!type || !id) return "";
    return CFG.SCC_DEVI_BASE + "/Home/ApplicationDetail?type=" + type + "&id=" + encodeURIComponent(id);
  }
  function _deviAppByIdUrl(kind, ramId) {
    const appType = _DEVI_APPTYPE[kind];
    const id = _validRamId(ramId);
    if (!appType || !id) return "";
    return CFG.SCC_DEVI_BASE + "/Geo/GetApplicationById?applicationId=" + encodeURIComponent(id) + "&appType=" + appType;
  }
  function _deviReportUrl(kind, ramId) {
    const appType = _DEVI_TYPE[kind];
    const id = _validRamId(ramId);
    if (!appType || !id) return "";
    return CFG.SCC_DEVI_BASE + "/Home/ApplicationDetailsView?appNo=" + encodeURIComponent(id) + "&type=" + appType.replace(/_unique$/, "") + "&do=pdf";
  }
  function _sccDocsSearchUrl(ramId) {
    const id = _validRamId(ramId);
    if (!id) return "";
    const q = `ApplicationNumberList:"${id}" And NOT recType:"Folder" And NOT recType:"Sub Folder"`;
    return CFG.SCC_DOCS_BASE + "/HPECMWebDrawer/Record?q=" + encodeURIComponent(q) + "&format=json&pageSize=100";
  }
  function _sccDocDownloadUrl(uri) {
    const n = Number(uri);
    if (!Number.isFinite(n) || n <= 0) return "";
    return CFG.SCC_DOCS_BASE + "/HPECMWebDrawer/Record/" + n + "/file/document";
  }
  function _parseSccDocs(data) {
    const out = [];
    for (const r of data && Array.isArray(data.Results) ? data.Results : []) {
      const uri = Number(r && r.Uri);
      const title = String(((r || {}).RecordTitle || {}).Value || "").trim();
      if (!Number.isFinite(uri) || uri <= 0 || !title) continue;
      out.push({
        uri,
        title,
        ext: String(((r || {}).RecordExtension || {}).Value || "").trim(),
        dateMs: Date.parse(
          ((r || {}).RecordDateRegistered || {}).DateTime || ""
        ) || 0
      });
    }
    out.sort((a, b) => b.dateMs - a.dateMs);
    return out;
  }
  function _deviFilterBody(o) {
    o = o || {};
    return {
      Progress: o.progress || "all",
      StartDateUnixEpochNumber: null,
      EndDateUnixEpochNumber: null,
      DateRangeField: "submitted",
      DateRangeDescriptor: null,
      LotPlan: null,
      LandNumber: o.landNumber != null ? o.landNumber : null,
      PropNumber: null,
      DANumber: null,
      BANumber: null,
      PlumbNumber: null,
      IncludeDA: true,
      IncludeBA: o.includeBA !== false,
      IncludePlumb: o.includePlumb !== false,
      LocalityId: null,
      DivisionId: null,
      ApplicationTypeId: null,
      SubCategoryUseId: null,
      ShowCode: true,
      ShowImpact: true,
      ShowOther: true,
      PagingStartIndex: 0,
      MaxRecords: o.maxRecords || 200,
      Boundary: null,
      ViewPort: null,
      IncludeAroundMe: false,
      SortField: "submitted",
      SortAscending: false,
      BBox: o.bbox || null,
      PixelWidth: 800,
      PixelHeight: 800
    };
  }
  function _dedupeDeviFeatures(data) {
    if (!data) return [];
    const all = (Array.isArray(data.features) ? data.features : []).slice();
    const ms = data.multiSpot;
    if (ms && typeof ms === "object") {
      for (const key of Object.keys(ms)) {
        if (Array.isArray(ms[key])) all.push(...ms[key]);
      }
    }
    const seen = /* @__PURE__ */ new Set();
    const out = [];
    for (const f of all) {
      const p = f && f.properties || {};
      const num = p.application_number;
      if (!num) continue;
      const coords = f.geometry && f.geometry.coordinates || [];
      const key = num + "@" + coords.join(",");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(f);
    }
    return out;
  }
  function _sccFeatureKey(f) {
    if (!f) return null;
    if (f.id != null) return f.id;
    const p = f.properties || {};
    const num = p.ram_id || p.application_number;
    if (!num) return null;
    return num + "@" + JSON.stringify((f.geometry || {}).coordinates || []);
  }
  function _deviKindFromCategory(category) {
    const c = String(category || "").toLowerCase();
    if (c === "building") return "BA";
    if (c === "plumbing") return "PL";
    return "DA";
  }
  function _histFromFilterResults(data, excludeNum) {
    const seen = new Set(excludeNum ? [excludeNum] : []);
    const hist = [];
    for (const f of _dedupeDeviFeatures(data)) {
      const p = f.properties || {};
      const num = p.application_number;
      if (seen.has(num)) continue;
      seen.add(num);
      hist.push({
        num,
        kind: _deviKindFromCategory(p.category),
        desc: String(p.description || ""),
        progress: String(p.progress || ""),
        decision: String(p.decision_desc || "").trim(),
        dateMs: Date.parse(p.date_received || "") || 0,
        decidedMs: Date.parse(p.date_determined || "") || 0
      });
    }
    hist.sort((a, b) => b.dateMs - a.dateMs);
    return hist;
  }
  function _decisionClass(decision) {
    const d = String(decision || "").toLowerCase();
    if (/refus|withdraw|not proceed|returned/.test(d)) return "dw-scc-dec--bad";
    if (/approv|permit|agree|finalis|accept|compl/.test(d)) return "dw-scc-dec--ok";
    return "";
  }
  function _histRowHtml(h, focalBase) {
    const url = _deviAppUrl(h.kind, h.num);
    const numHtml = url ? `<a href="${_escHtml(url)}" target="_blank" rel="noreferrer"><b>${_escHtml(h.num)}</b></a>` : esc`<b>${h.num}</b>`;
    const related = focalBase && String(h.num).split(".")[0] === focalBase ? '<span class="dw-scc-chip dw-scc-chip--rel">same approval</span>' : "";
    const inProgress = /in progress/i.test(h.progress);
    let meta, metaCls = "";
    if (!inProgress && h.decision) {
      meta = h.decision + (h.decidedMs > 0 ? " · " + _fmtSccDate(h.decidedMs) : "");
      metaCls = _decisionClass(h.decision);
    } else if (inProgress) {
      meta = "In Progress" + (h.dateMs > 0 ? " · lodged " + _fmtSccDate(h.dateMs) : "");
    } else {
      meta = [h.progress, h.dateMs > 0 ? _fmtSccDate(h.dateMs) : ""].filter(Boolean).join(" · ");
    }
    return `<div class="dw-scc-stage"><span class="dw-scc-stage-desc">${numHtml}${related} ${_escHtml(_clip(h.desc, 56))}</span>` + (meta ? `<span class="dw-scc-stage-val ${metaCls}">${_escHtml(meta)}</span>` : "") + "</div>";
  }
  function fetchSccPropertyHistory(lat, lng, cb) {
    if (!isFinite(lat) || !isFinite(lng)) {
      cb(null);
      return;
    }
    gmJsonGet(
      CFG.SCC_DEVI_BASE + "/Geo/GetPropertyDetailsByLatLng?lat=" + lat.toFixed(6) + "&lng=" + lng.toFixed(6),
      (err, d) => {
        const f = !err && d && Array.isArray(d.features) && d.features[0] || null;
        const p = f && f.properties;
        if (!p || p.land_no == null) {
          cb(null);
          return;
        }
        const prop = {
          landNo: p.land_no,
          address: String(p.address_format || p.address_short || "").trim(),
          lotPlan: String(p.lot_plan || "").trim()
        };
        cachedFetch(
          "scc_prophist_" + prop.landNo,
          _CACHE_TTL.SCC_DETAIL,
          (done) => gmJsonGet(
            CFG.SCC_DEVI_BASE + "/Geo/GetApplicationFilterResults",
            {
              method: "POST",
              data: JSON.stringify(_deviFilterBody({ landNumber: prop.landNo })),
              headers: { "Content-Type": "application/json" }
            },
            (err2, data) => {
              if (err2 || !data) {
                done(err2 || new Error("no data"), void 0);
                return;
              }
              done(null, _histFromFilterResults(data));
            }
          ),
          (err2, hist) => cb(err2 ? null : { prop, hist: hist || [] })
        );
      }
    );
  }
  function _renderSccPropertyHistory(res) {
    if (!res || !res.hist.length) {
      return res && res.prop.address ? '<b>SCC applications</b><br><span class="dw-scc-sub">None found.</span>' : "";
    }
    const rows = res.hist.map((h) => _histRowHtml(h, "")).join("");
    return esc`<b>SCC applications (${res.hist.length})</b>` + `<div class="dw-scc-stages">${rows}</div>`;
  }
  function _deviText(s) {
    return String(s || "").replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
  }
  function _parseSccDetailHtml(html) {
    const h = String(html || "");
    const out = { properties: [], stages: [] };
    const propRe = /PropertyDetailsView\?landNumber=\d+'[^>]*>([^<]+)</g;
    let m;
    while (m = propRe.exec(h)) {
      const addr = _deviText(m[1]);
      if (addr) out.properties.push(addr);
    }
    const cell = "((?:(?!<\\/tr>)[\\s\\S])*?)";
    const rowRe = new RegExp(
      "<tr>\\s*<td>" + cell + "<\\/td>\\s*<td>" + cell + '<\\/td>\\s*<td>(?:(?!<\\/tr>)[\\s\\S])*?data-date-number="(\\d+)"',
      "g"
    );
    while (m = rowRe.exec(h)) {
      const desc = _deviText(m[1]);
      if (!desc) continue;
      out.stages.push({
        desc,
        decision: _deviText(m[2]),
        dateMs: Number(m[3]) || 0
      });
    }
    return out;
  }
  function _renderSccDetail(d) {
    if (!d || !d.properties.length && !d.stages.length && !(d.history || []).length && !d.officer && !d.statusDesc && !(d.docs || []).length) {
      return '<span class="dw-scc-sub">No further detail available.</span>';
    }
    const bits = [];
    const facts = [];
    if (d.statusDesc) facts.push(esc`${d.statusDesc}`);
    if (d.appType) facts.push(esc`Type: ${d.appType}`);
    if (d.officer) facts.push(esc`Officer: ${d.officer}`);
    if (d.appeal) facts.push(esc`Appeal: ${d.appeal}`);
    if (facts.length) {
      bits.push(
        `<div class="dw-scc-det-sec dw-scc-sub">${facts.join("<br>")}</div>`
      );
    }
    if (d.properties.length) {
      const shown = d.properties.slice(0, 3).map(_escHtml).join("<br>");
      const extra = d.properties.length > 3 ? esc`<br><span class="dw-scc-sub">+${d.properties.length - 3} more</span>` : "";
      bits.push(
        `<div class="dw-scc-det-sec"><b>Properties</b><br>${shown}${extra}</div>`
      );
    }
    if (d.stages.length) {
      const rows = d.stages.map((s) => {
        const when = s.dateMs > 0 ? _fmtSccDate(s.dateMs) : "";
        const right = [s.decision, when].filter(Boolean).join(" · ");
        return esc`<div class="dw-scc-stage"><span class="dw-scc-stage-desc">${s.desc}</span>` + (right ? esc`<span class="dw-scc-stage-val">${right}</span>` : "") + "</div>";
      }).join("");
      bits.push(
        `<div class="dw-scc-det-sec"><b>Assessment stages</b><div class="dw-scc-stages">${rows}</div></div>`
      );
    }
    const docs = d.docs || [];
    if (docs.length) {
      const rows = docs.map((doc) => {
        const dl = _sccDocDownloadUrl(doc.uri);
        const title = _clip(doc.title, 64);
        const name = dl ? `<a href="${_escHtml(dl)}" target="_blank" rel="noreferrer">${_escHtml(title)}</a>` : _escHtml(title);
        const meta = [doc.ext, doc.dateMs > 0 ? _fmtSccDate(doc.dateMs) : ""].filter(Boolean).join(" · ");
        return `<div class="dw-scc-stage"><span class="dw-scc-stage-desc">${name}</span>` + (meta ? esc`<span class="dw-scc-stage-val">${meta}</span>` : "") + "</div>";
      }).join("");
      bits.push(
        `<div class="dw-scc-det-sec"><b>Documents (${docs.length})</b><div class="dw-scc-stages">${rows}</div></div>`
      );
    }
    const hist = d.history || [];
    if (hist.length) {
      const focalBase = d.focal ? String(d.focal).split(".")[0] : "";
      const isRel = (h) => focalBase && String(h.num).split(".")[0] === focalBase ? 1 : 0;
      const ordered = hist.slice().sort(
        (a, b) => isRel(b) - isRel(a) || b.dateMs - a.dateMs
      );
      const rows = ordered.map((h) => _histRowHtml(h, focalBase)).join("");
      bits.push(
        `<div class="dw-scc-det-sec"><b>Property history (${hist.length})</b><div class="dw-scc-stages">${rows}</div></div>`
      );
    }
    return bits.join("");
  }
  function fetchSccDetail(kind, ramId, cb) {
    const fragUrl = _deviDetailUrl(kind, ramId);
    const infoUrl = _deviAppByIdUrl(kind, ramId);
    const docsUrl = _sccDocsSearchUrl(ramId);
    if (!fragUrl || !infoUrl || !docsUrl) {
      cb(null);
      return;
    }
    cachedFetch(
      "scc_detail_" + kind + "_" + ramId,
      _CACHE_TTL.SCC_DETAIL,
      (done) => {
        let frag = null, info = null, docs = null, pending = 3;
        const finish = (history) => {
          const out = Object.assign(
            { properties: [], stages: [], history: [], focal: ramId },
            frag || {}
          );
          if (history) out.history = history;
          out.docs = docs || [];
          if (info) {
            out.officer = String(info.project_officer || "").trim();
            out.appType = String(info.application_type || "").trim();
            out.statusDesc = String(info.decision_desc || "").trim();
            const appeal = String(info.appeal_result || "").trim();
            if (appeal && !/^not applicable$/i.test(appeal)) {
              out.appeal = appeal;
            }
          }
          const hasAnything = out.properties.length || out.stages.length || out.history.length || out.officer || out.statusDesc || out.docs.length;
          if (!hasAnything && !frag && !info && !docs) {
            done(new Error("devi detail unavailable"), void 0);
            return;
          }
          done(null, hasAnything ? out : null);
        };
        const step = () => {
          if (--pending) return;
          const landNo = info && info.land_no;
          if (landNo == null) {
            finish();
            return;
          }
          gmJsonGet(
            CFG.SCC_DEVI_BASE + "/Geo/GetApplicationFilterResults",
            {
              method: "POST",
              data: JSON.stringify(_deviFilterBody({ landNumber: landNo })),
              headers: { "Content-Type": "application/json" }
            },
            (err, data) => {
              if (err || !data) {
                finish();
                return;
              }
              finish(_histFromFilterResults(data, ramId));
            }
          );
        };
        gmGet(
          fragUrl,
          { headers: { "X-Requested-With": "XMLHttpRequest", Accept: "text/html" } },
          (err, r) => {
            frag = !err && r && r.status >= 200 && r.status < 300 ? _parseSccDetailHtml(r.responseText) : null;
            step();
          }
        );
        gmJsonGet(infoUrl, (err, d) => {
          info = !err && d && Array.isArray(d.features) && d.features[0] ? d.features[0].properties || null : null;
          step();
        });
        gmJsonGet(docsUrl, (err, d) => {
          docs = err ? null : _parseSccDocs(d);
          step();
        });
      },
      (err, v) => cb(err ? null : v)
    );
  }
  function _onSccPopupOpen(e) {
    const el = e.popup && e.popup.getElement && e.popup.getElement();
    const slot = el && el.querySelector(".dw-scc-detail");
    if (!slot || slot.dataset.dwDone) return;
    slot.dataset.dwDone = "1";
    fetchSccDetail(slot.dataset.sccKind, slot.dataset.sccId, (detail) => {
      if (!slot.isConnected) return;
      slot.innerHTML = _renderSccDetail(detail);
    });
  }
  function _formatSccPopup(p, kind, live) {
    const meta = _KIND[kind];
    const rows = [];
    rows.push(
      esc`<div class="dw-scc-pop-hd"><b>${p.ram_id || "Application"}</b>` + esc` <span class="dw-scc-sub">${meta.label} application</span></div>`
    );
    const cat = String(p.category_desc || "").trim();
    const grp = String(p.group_desc || "").trim();
    if (cat || grp) {
      rows.push(esc`<div>${cat || grp}` + (cat && grp && grp !== cat ? esc` <span class="dw-scc-sub">(${grp})</span>` : "") + "</div>");
    }
    const desc = _clip(p.description, 300);
    if (desc) rows.push(esc`<div class="dw-scc-pop-desc">${desc}</div>`);
    const bits = [];
    if (p.d_date_rec) bits.push("Lodged " + _fmtSccDate(p.d_date_rec));
    if (!live && p.d_decision_made)
      bits.push("Decided " + _fmtSccDate(p.d_decision_made));
    const status = live ? p.progress || "In Progress" : p.decision || "";
    if (status) bits.push(status);
    if (bits.length)
      rows.push(esc`<div class="dw-scc-sub">${bits.join(" · ")}</div>`);
    const lvl = String(p.assessment_level || "").trim();
    if (lvl && lvl.toLowerCase() !== "other")
      rows.push(esc`<div class="dw-scc-sub">Assessment: ${lvl}</div>`);
    const id = String(p.ram_id || "").trim();
    if (_deviDetailUrl(kind, id)) {
      rows.push(
        `<div class="dw-scc-detail" data-scc-kind="${kind}" data-scc-id="${_escHtml(id)}"><span class="dw-scc-sub">Loading Development.i detail…</span></div>`
      );
    }
    const links = [];
    if (/notification/i.test(String(p.progress || ""))) {
      links.push(
        `<a class="dw-scc-link dw-scc-link--notif" href="${_escHtml(CFG.SCC_SUBMISSION_URL)}" target="_blank" rel="noreferrer">Make a submission ↗</a>`
      );
    }
    const url = _deviAppUrl(kind, p.ram_id);
    if (url) {
      links.push(
        `<a class="dw-scc-link" href="${_escHtml(url)}" target="_blank" rel="noreferrer">Open in Development.i ↗</a>`
      );
    }
    const report = _deviReportUrl(kind, p.ram_id);
    if (report) {
      links.push(
        `<a class="dw-scc-link" href="${_escHtml(report)}" target="_blank" rel="noreferrer">Report PDF ↗</a>`
      );
    }
    if (links.length) {
      rows.push(`<div class="dw-scc-links">${links.join(" ")}</div>`);
    }
    return `<div class="dw-scc-pop">${rows.join("")}</div>`;
  }
  function _makeSubLayer(kind, live) {
    const meta = _KIND[kind];
    return makeArcgisQueryLayer({
      label: `SCC ${meta.label} (${live ? "current" : "decided"})`,
      pane: PANE,
      paneZIndex: PANE_Z,
      // In-progress sets are small council-wide (~600–3500 features);
      // decided sets run to 190k, so those wait for street-level zoom.
      minZoom: live ? 13 : 16,
      queryUrl: `${CFG.SCC_APPS_SERVICE}/${live ? meta.liveId : meta.pastId}/query`,
      where: "1=1",
      outFields: _APP_FIELDS,
      orderBy: "d_date_rec DESC",
      featureKey: _sccFeatureKey,
      pointToLayer: (f, latlng) => L.circleMarker(latlng, {
        pane: PANE,
        radius: (live ? 6 : 4) * (_isTouch() ? 1.7 : 1),
        color: live ? "#ffffff" : meta.color,
        weight: (live ? 1.5 : 1) * (_isTouch() ? 1.5 : 1),
        opacity: live ? 0.9 : 0.5,
        fillColor: meta.color,
        fillOpacity: live ? 0.85 : 0.35,
        // Keep marker taps OURS: without this the click re-fires
        // on the map and the site opens its add-point popup on
        // top of the application popup.
        bubblingMouseEvents: false
      }),
      tipClass: "dw-scc-tip",
      // Touch has no hover — a bound tooltip would open on tap,
      // stacking on the popup. The popup is the single touch surface.
      tooltip: _isTouch() ? null : (p) => _formatSccTooltip(p, kind, live),
      popup: (p) => _formatSccPopup(p, kind, live),
      popupOpts: { maxWidth: 320, className: "dw-scc-pop-wrap" },
      attribution: 'Applications &copy; <a href="https://developmenti.sunshinecoast.qld.gov.au/" target="_blank" rel="noreferrer">Sunshine Coast Council</a>'
    }, gmJsonGet);
  }
  function _formatNotifTooltip(p) {
    const lines = [
      esc`<span class="dw-scc-tip-hd"><b>${p.application_number || "Application"}</b>` + '<span class="dw-scc-chip dw-scc-chip--notif">On public notification</span></span>'
    ];
    const desc = _clip(p.description, 90);
    if (desc) lines.push(esc`<span class="dw-scc-sub">${desc}</span>`);
    const alertMs = Date.parse(p.alertDate || "") || 0;
    if (alertMs) {
      lines.push(esc`<span class="dw-scc-sub">Submissions invited — listed ${_fmtSccDate(alertMs)}</span>`);
    }
    return lines.join("<br>");
  }
  function _notifPopupProps(p) {
    return {
      ram_id: p.application_number,
      group_desc: p.group_desc || p.application_type,
      category_desc: p.category_desc,
      description: p.description,
      progress: "In Progress — On Public Notification",
      assessment_level: p.assessment_level,
      d_date_rec: Date.parse(p.date_received || "") || null
    };
  }
  function _makeNotifyingLayer() {
    return makeArcgisQueryLayer({
      label: "SCC notifying applications",
      pane: PANE,
      paneZIndex: PANE_Z,
      minZoom: 10,
      buildRequest: (bbox) => ({
        url: CFG.SCC_DEVI_BASE + "/Geo/GetApplicationFilterResults",
        gmOpts: {
          method: "POST",
          data: JSON.stringify(_deviFilterBody({
            progress: "notification",
            bbox,
            includeBA: false,
            includePlumb: false
          })),
          headers: { "Content-Type": "application/json" }
        }
      }),
      transform: (data) => ({
        type: "FeatureCollection",
        features: _dedupeDeviFeatures(data)
      }),
      featureKey: _sccFeatureKey,
      pointToLayer: (f, latlng) => L.circleMarker(latlng, {
        pane: PANE,
        radius: 8 * (_isTouch() ? 1.7 : 1),
        color: "#ffffff",
        weight: 2 * (_isTouch() ? 1.5 : 1),
        opacity: 0.95,
        fillColor: "#dc2626",
        fillOpacity: 0.9,
        bubblingMouseEvents: false
      }),
      tipClass: "dw-scc-tip",
      tooltip: _isTouch() ? null : (p) => _formatNotifTooltip(p),
      popup: (p) => _formatSccPopup(_notifPopupProps(p), "DA", true),
      popupOpts: { maxWidth: 320, className: "dw-scc-pop-wrap" },
      attribution: 'Applications &copy; <a href="https://developmenti.sunshinecoast.qld.gov.au/" target="_blank" rel="noreferrer">Sunshine Coast Council</a>'
    }, gmJsonGet);
  }
  function _sccDefaultState() {
    return { DA: true, BA: true, PL: true, live: true, past: false, notif: true };
  }
  function _sccLoadState() {
    const state = _sccDefaultState();
    try {
      const saved = JSON.parse(GM_getValue(CFG.SCC_APPS_STATE_KEY, "{}"));
      for (const k of Object.keys(state)) {
        if (typeof saved[k] === "boolean") state[k] = saved[k];
      }
    } catch (_) {
    }
    return state;
  }
  function _sccSaveState(state) {
    try {
      GM_setValue(CFG.SCC_APPS_STATE_KEY, JSON.stringify(state));
    } catch (_) {
    }
  }
  function _buildSccPanel(state, onChange) {
    const el = document.createElement("div");
    el.className = "dw-scc-panel";
    el.innerHTML = '<div class="dw-scc-panel-hd">SCC Applications</div>' + Object.keys(_KIND).map((kind) => {
      const m = _KIND[kind];
      return `<div class="dw-scc-row"><label><input type="checkbox" data-key="${kind}"><span class="dw-scc-dot" style="background:${m.color}"></span>${m.label}</label></div>`;
    }).join("") + '<div class="dw-scc-row dw-scc-status"><span class="dw-scc-row-label">Status</span><label><input type="checkbox" data-key="live"> current</label><label><input type="checkbox" data-key="past"> decided</label></div><div class="dw-scc-row dw-scc-notif-row"><label><input type="checkbox" data-key="notif"><span class="dw-scc-dot" style="background:#dc2626"></span>on public notification</label></div><div class="dw-scc-hint">decided sets appear from zoom 16</div>';
    el.querySelectorAll("input[data-key]").forEach((cb) => {
      cb.checked = !!state[cb.dataset.key];
      cb.addEventListener("change", () => onChange(cb.dataset.key, cb.checked));
    });
    L.DomEvent.disableClickPropagation(el);
    L.DomEvent.disableScrollPropagation(el);
    return el;
  }
  var _SccAppsLayer = null;
  function _getSccAppsLayerClass() {
    if (_SccAppsLayer) return _SccAppsLayer;
    _SccAppsLayer = L.LayerGroup.extend({
      initialize() {
        L.LayerGroup.prototype.initialize.call(this, []);
        this._subs = {};
        this._panel = null;
        this._state = _sccLoadState();
      },
      onAdd(map) {
        L.LayerGroup.prototype.onAdd.call(this, map);
        this._syncSubs();
        this._panel = _buildSccPanel(this._state, (key, on) => {
          this._state[key] = on;
          _sccSaveState(this._state);
          this._syncSubs();
        });
        map.getContainer().appendChild(this._panel);
        map.on("popupopen", _onSccPopupOpen);
      },
      onRemove(map) {
        map.off("popupopen", _onSccPopupOpen);
        if (this._panel) {
          this._panel.remove();
          this._panel = null;
        }
        L.LayerGroup.prototype.onRemove.call(this, map);
      },
      _syncSubs() {
        const want = {};
        for (const kind of Object.keys(_KIND)) {
          for (const phase of ["live", "past"]) {
            want[kind + "_" + phase] = !!(this._state[kind] && this._state[phase]);
          }
        }
        want.notif = !!this._state.notif;
        for (const key of Object.keys(want)) {
          const on = want[key];
          let sub = this._subs[key];
          if (on && !sub) {
            sub = this._subs[key] = key === "notif" ? _makeNotifyingLayer() : _makeSubLayer(
              key.split("_")[0],
              key.split("_")[1] === "live"
            );
          }
          if (!sub) continue;
          if (on && !this.hasLayer(sub)) this.addLayer(sub);
          else if (!on && this.hasLayer(sub)) this.removeLayer(sub);
        }
      }
    });
    return _SccAppsLayer;
  }
  var SccApplicationsLayerProvider = class extends LayerProvider {
    create() {
      const Cls = _getSccAppsLayerClass();
      return new Cls();
    }
  };

  // src/providers/geocaching.js
  var GeocachingLayerProvider = class extends LayerProvider {
    create() {
      const MIN_ZOOM = 10;
      const FETCH_MAX_Z = 13;
      const DEBOUNCE_MS = 500;
      const MAX_TILES = 64;
      const TYPE_LABELS = {
        2: "T",
        3: "M",
        8: "?",
        5: "L",
        6: "E",
        11: "C",
        137: "E",
        1858: "W",
        4: "V",
        13: "C"
      };
      const TYPE_COLOR = {
        2: "#1f8e3e",
        3: "#fcb900",
        8: "#1e3fae",
        5: "#5b2a86",
        6: "#d33a3a",
        11: "#444",
        137: "#7d5a2a",
        1858: "#2aa198",
        4: "#888",
        13: "#d33a3a"
      };
      const detailsCache = /* @__PURE__ */ new Map();
      const tileCache = /* @__PURE__ */ new Map();
      const TILE_CACHE_MAX = 64;
      let subdomainIdx = 0;
      function nextSubdomain() {
        const list = CFG.GEOCACHING_TILE_SUBDOMAINS;
        const s = list[subdomainIdx % list.length];
        subdomainIdx++;
        return s;
      }
      function visibleTiles(map) {
        const z = Math.min(Math.floor(map.getZoom()), FETCH_MAX_Z);
        const b = map.getBounds();
        const n = Math.pow(2, z);
        const lngToTx = (lng) => Math.floor((lng + 180) / 360 * n);
        const latToTy = (lat) => {
          const r = lat * Math.PI / 180;
          return Math.floor(
            (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n
          );
        };
        const yMin = Math.max(0, latToTy(b.getNorth()));
        const yMax = Math.min(n - 1, latToTy(b.getSouth()));
        const xStart = lngToTx(b.getWest());
        let xCount = lngToTx(b.getEast()) - xStart + 1;
        if (xCount <= 0) xCount += n;
        xCount = Math.min(xCount, n);
        const tiles = [];
        for (let i = 0; i < xCount; i++) {
          const x = ((xStart + i) % n + n) % n;
          for (let y = yMin; y <= yMax; y++) {
            tiles.push({ z, x, y });
          }
        }
        return tiles;
      }
      const IS_TOUCH = L.Browser.mobile || window.matchMedia && window.matchMedia("(hover: none)").matches;
      const HIT_PX = IS_TOUCH ? 40 : 28;
      function buildHitIcon() {
        return L.divIcon({
          className: "dw-geo-icon",
          html: `<div style="width:${HIT_PX}px;height:${HIT_PX}px;background:transparent;cursor:pointer;"></div>`,
          iconSize: [HIT_PX, HIT_PX],
          iconAnchor: [HIT_PX / 2, HIT_PX / 2]
        });
      }
      function buildPinIcon(typeId, fill, opacity, favs) {
        const label = TYPE_LABELS[typeId] || "G";
        const favBadge = favs > 0 ? `<div style="position:absolute;top:-6px;right:-8px;background:#d33;color:#fff;font:bold 9px/1 sans-serif;padding:2px 4px;border-radius:8px;border:1px solid #fff;white-space:nowrap;box-shadow:0 0 2px rgba(0,0,0,.45);pointer-events:none;">♥${favs > 99 ? "99+" : favs}</div>` : "";
        const html = `<div style="position:relative;width:20px;height:20px;overflow:visible;cursor:pointer;"><div style="background:${fill};color:#fff;opacity:${opacity};width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;font:bold 11px/1 sans-serif;border:1px solid #222;box-shadow:0 0 1px rgba(0,0,0,.6);">${label}</div>` + favBadge + `</div>`;
        return L.divIcon({
          className: "dw-geo-icon",
          html,
          iconSize: [20, 20],
          iconAnchor: [10, 10]
        });
      }
      function pinForCode(code) {
        const row = detailsCache.get(code);
        if (!row) return buildPinIcon(2, TYPE_COLOR[2], 1, 0);
        const typeId = row.type && row.type.value || 2;
        const disabled = !row.available;
        return buildPinIcon(
          typeId,
          disabled ? "#888" : TYPE_COLOR[typeId] || "#1f8e3e",
          disabled ? 0.6 : 1,
          parseInt(row.fp, 10) || 0
        );
      }
      const GeoLayer = L.Layer.extend({
        initialize() {
          this._group = null;
          this._tiles = null;
          this._debounce = null;
          this._gen = 0;
          this._inflight = /* @__PURE__ */ new Set();
          this._byCode = /* @__PURE__ */ new Map();
          this._tileGroups = /* @__PURE__ */ new Map();
          this._pinMode = null;
        },
        onAdd(map) {
          if (!map.getPane("dwGeocachingTilePane")) {
            map.createPane("dwGeocachingTilePane");
            map.getPane("dwGeocachingTilePane").style.zIndex = "440";
          }
          if (!map.getPane("dwGeocachingPane")) {
            map.createPane("dwGeocachingPane");
            map.getPane("dwGeocachingPane").style.zIndex = "445";
          }
          this._tiles = L.tileLayer(CFG.GEOCACHING_PUBLIC_PNG, {
            pane: "dwGeocachingTilePane",
            subdomains: CFG.GEOCACHING_TILE_SUBDOMAINS,
            minZoom: MIN_ZOOM,
            maxNativeZoom: FETCH_MAX_Z,
            // Hide the raster past its native zoom instead of
            // CSS-stretching it — overzoomed bitmap icons blow
            // up big and blurry. z14+ uses crisp DOM pins (see
            // the zoom-staged visuals note above).
            maxZoom: FETCH_MAX_Z,
            tileSize: 256,
            // map.png sends NO Access-Control-Allow-Origin, so
            // a CORS-enabled <img> (crossOrigin:true) fails its
            // check in a real browser and renders NOTHING —
            // every other raster endpoint we use serves ACAO;
            // this one doesn't. We never read these pixels, so
            // a plain <img> is correct. (The e2e harness can't
            // catch this class of bug: it launches Chromium
            // with --disable-web-security, which masks CORS —
            // the same blind spot that hid the Strava
            // crossOrigin breakage.)
            crossOrigin: false,
            attribution: 'Caches © <a href="https://www.geocaching.com" target="_blank" rel="noreferrer">Geocaching.com</a>'
          }).addTo(map);
          this._group = L.layerGroup().addTo(map);
          this._fetchSoon();
          map.on("moveend zoomend", this._onViewChange, this);
        },
        onRemove(map) {
          clearTimeout(this._debounce);
          this._debounce = null;
          map.off("moveend zoomend", this._onViewChange, this);
          for (const h of this._inflight) gmCancel(h);
          this._inflight.clear();
          if (this._tiles) {
            this._tiles.remove();
            this._tiles = null;
          }
          if (this._group) {
            this._group.remove();
            this._group = null;
          }
          this._tileGroups.clear();
          this._byCode.clear();
        },
        _onViewChange() {
          this._fetchSoon();
        },
        _fetchSoon() {
          clearTimeout(this._debounce);
          this._debounce = setTimeout(() => this._fetch(), DEBOUNCE_MS);
        },
        _fetch() {
          const map = this._map;
          if (!map || !this._group) return;
          if (map.getZoom() < MIN_ZOOM) {
            this._group.clearLayers();
            this._tileGroups.clear();
            this._byCode.clear();
            return;
          }
          const myGen = ++this._gen;
          for (const h of this._inflight) gmCancel(h);
          this._inflight.clear();
          const tiles = visibleTiles(map);
          if (tiles.length > MAX_TILES) {
            return;
          }
          const pinMode = map.getZoom() > FETCH_MAX_Z;
          if (this._pinMode !== pinMode) {
            this._group.clearLayers();
            this._tileGroups.clear();
            this._byCode.clear();
            this._pinMode = pinMode;
          }
          const visKeys = new Set(
            tiles.map((t) => `${t.z}/${t.x}/${t.y}`)
          );
          for (const [key, rec] of this._tileGroups) {
            if (visKeys.has(key)) continue;
            this._group.removeLayer(rec.group);
            for (const code of rec.codes) this._byCode.delete(code);
            this._tileGroups.delete(key);
          }
          for (const t of tiles) {
            const key = `${t.z}/${t.x}/${t.y}`;
            if (this._tileGroups.has(key)) continue;
            const cached = tileCache.get(key);
            if (cached) {
              this._renderTile(t, cached);
              continue;
            }
            this._fetchTile(t, myGen, key);
          }
        },
        _fetchTile(t, myGen, key) {
          this._getInfo(t, myGen, key, true);
        },
        _tileUrl(template, t) {
          return template.replace("{s}", nextSubdomain()).replace("{x}", String(t.x)).replace("{y}", String(t.y)).replace("{z}", String(t.z));
        },
        _getInfo(t, myGen, key, allowWarm) {
          const url = this._tileUrl(CFG.GEOCACHING_PUBLIC_INFO, t);
          const handle = gmJsonGet(url, {
            headers: {
              "Accept": "application/json",
              "Referer": "https://www.geocaching.com/play/map"
            },
            timeout: 15e3
          }, (err, data, raw) => {
            this._inflight.delete(handle);
            if (myGen !== this._gen || !this._group) return;
            if (!err && data) {
              tileCache.set(key, data);
              if (tileCache.size > TILE_CACHE_MAX) {
                const first = tileCache.keys().next().value;
                tileCache.delete(first);
              }
              this._renderTile(t, data);
              return;
            }
            const status = raw && raw.status;
            if (status === 204 && allowWarm) {
              this._warmThenRetry(t, myGen, key);
            }
          });
          this._inflight.add(handle);
        },
        _warmThenRetry(t, myGen, key) {
          const url = this._tileUrl(CFG.GEOCACHING_PUBLIC_PNG, t);
          const warm = gmGet(url, {
            headers: { "Referer": "https://www.geocaching.com/play/map" },
            timeout: 15e3
          }, () => {
            this._inflight.delete(warm);
            if (myGen !== this._gen || !this._group) return;
            this._getInfo(t, myGen, key, false);
          });
          this._inflight.add(warm);
        },
        _renderTile(t, grid) {
          if (!this._group) return;
          if (!grid || !Array.isArray(grid.keys)) return;
          const tileKey2 = `${t.z}/${t.x}/${t.y}`;
          if (this._tileGroups.has(tileKey2)) return;
          const pinMode = !!this._map && this._map.getZoom() > FETCH_MAX_Z;
          const tileGroup = L.layerGroup();
          const tileCodes = [];
          const newCodes = [];
          const data = grid.data || {};
          for (const k of grid.keys) {
            if (!k) continue;
            const m = /^\((\d+),\s*(\d+)\)$/.exec(k);
            if (!m) continue;
            const cx = +m[1], cy = +m[2];
            const raw = data[k];
            const entries = Array.isArray(raw) ? raw : raw && raw.i ? [raw] : [];
            for (const entry of entries) {
              if (!entry || !entry.i) continue;
              const code = entry.i;
              if (!/^GC[0-9A-Z]+$/.test(code)) continue;
              if (this._byCode.has(code)) continue;
              newCodes.push(code);
              const [lat, lon] = utfGridCellToLatLng(t.z, t.x, t.y, cx, cy);
              const name = entry.n || code;
              const marker = L.marker([lat, lon], {
                icon: pinMode ? pinForCode(code) : buildHitIcon(),
                pane: "dwGeocachingPane",
                interactive: true
              }).bindTooltip(
                `<b>${_escHtml(name)}</b><br><span class="dw-cad-sub">${_escHtml(code)} · <i>click for details</i></span>`,
                { className: "dw-flight-tip", sticky: true }
              );
              marker._dwData = {
                kind: "geocache",
                code,
                name,
                color: TYPE_COLOR[2],
                url: `https://www.geocaching.com/geocache/${code}`
              };
              marker.on("add", () => {
                const el = marker._icon;
                if (!el || el._dwStopWired) return;
                el._dwStopWired = true;
                L.DomEvent.disableClickPropagation(el);
                L.DomEvent.on(el, "click", (ev) => {
                  L.DomEvent.stop(ev);
                  this._onClick(marker, code);
                });
                L.DomEvent.on(
                  el,
                  "contextmenu touchend",
                  L.DomEvent.stopPropagation
                );
              });
              marker.addTo(tileGroup);
              this._byCode.set(code, marker);
              tileCodes.push(code);
            }
          }
          tileGroup.addTo(this._group);
          this._tileGroups.set(tileKey2, { group: tileGroup, codes: tileCodes });
          if (pinMode) {
            let budget = 40;
            for (const code of newCodes) {
              if (detailsCache.has(code)) continue;
              if (budget-- <= 0) break;
              this._fetchDetails(code, (row) => {
                const mk = this._byCode.get(code);
                if (!row || !mk) return;
                this._applyDetails(mk, code, row, { open: false });
              });
            }
          }
        },
        // Fetch + cache map.details for one cache. cb(row|null) —
        // null means error or no data (caller decides fallback).
        _fetchDetails(code, cb) {
          const url = CFG.GEOCACHING_PUBLIC_DETAILS + code;
          gmJsonGet(url, {
            headers: {
              "Accept": "application/json",
              "Referer": "https://www.geocaching.com/play/map"
            },
            timeout: 1e4
          }, (err, data) => {
            if (err || !data || data.status !== "success") {
              cb(null);
              return;
            }
            const row = data.data && data.data[0] || null;
            if (row) detailsCache.set(code, row);
            cb(row);
          });
        },
        _onClick(marker, code) {
          const showOpts = IS_TOUCH ? { open: false, popup: true } : { open: true };
          const cached = detailsCache.get(code);
          if (cached) {
            this._applyDetails(marker, code, cached, showOpts);
            return;
          }
          this._fetchDetails(code, (row) => {
            if (!row) {
              window.open(
                `https://www.geocaching.com/geocache/${code}`,
                "_blank",
                "noopener,noreferrer"
              );
              return;
            }
            this._applyDetails(marker, code, row, showOpts);
          });
        },
        // Pull the display fields out of a map.details row once, so the
        // tooltip and the touch popup format identically.
        _detailFields(row) {
          const typeId = row.type && row.type.value || 2;
          return {
            typeId,
            disabled: !row.available,
            favs: parseInt(row.fp, 10) || 0,
            premium: !!row.subrOnly,
            name: row.name || "",
            diff: row.difficulty && row.difficulty.value || row.difficulty && row.difficulty.text || "?",
            terr: row.terrain && row.terrain.value || row.terrain && row.terrain.text || "?",
            size: row.container && row.container.text || "",
            owner: row.owner && row.owner.text || "",
            typeText: row.type && row.type.text || ""
          };
        },
        // Touch-only: an anchored popup with the cache stats + a button
        // to open the full geocaching.com listing. Tapping the icon no
        // longer jumps straight to the (often paywalled) listing.
        _openDetailPopup(marker, code, row) {
          if (!this._map) return;
          const f = this._detailFields(row);
          const el = document.createElement("div");
          el.className = "dw-geo-pop";
          el.innerHTML = `<div class="dw-geo-pop-hd"><b>${_escHtml(f.name || code)}</b>` + (f.disabled ? ` <i>(disabled)</i>` : "") + (f.premium ? ` <span class="dw-geo-pmo">🔒 Premium</span>` : "") + `</div><div class="dw-geo-pop-sub">${_escHtml(code)} · D ${_escHtml(String(f.diff))} / T ${_escHtml(String(f.terr))}` + (f.size ? " · " + _escHtml(String(f.size)) : "") + (f.favs ? ` · ♥ ${f.favs}` : "") + (f.typeText ? " · " + _escHtml(f.typeText) : "") + `</div>` + (f.owner ? `<div class="dw-geo-pop-owner">by ${_escHtml(f.owner)}</div>` : "") + (f.premium ? `<div class="dw-geo-pop-note">Full listing needs geocaching.com Premium</div>` : "") + `<button type="button" class="dw-geo-pop-open">View full listing ↗</button>`;
          L.DomEvent.disableClickPropagation(el);
          el.querySelector(".dw-geo-pop-open").addEventListener("click", (ev) => {
            L.DomEvent.stop(ev);
            window.open(
              `https://www.geocaching.com/geocache/${code}`,
              "_blank",
              "noopener,noreferrer"
            );
          });
          marker.closeTooltip && marker.closeTooltip();
          L.popup({ className: "dw-geo-popup", offset: [0, -6], autoPan: true }).setLatLng(marker.getLatLng()).setContent(el).openOn(this._map);
        },
        _applyDetails(marker, code, row, opts) {
          const typeId = row.type && row.type.value || 2;
          const color = TYPE_COLOR[typeId] || "#1f8e3e";
          const disabled = !row.available;
          const fill = disabled ? "#888" : color;
          const favs = parseInt(row.fp, 10) || 0;
          if (this._map && this._map.getZoom() > FETCH_MAX_Z && marker.setIcon) {
            marker.setIcon(pinForCode(code));
          }
          const name = row.name || code;
          const diff = row.difficulty && row.difficulty.value || row.difficulty && row.difficulty.text || "?";
          const terr = row.terrain && row.terrain.value || row.terrain && row.terrain.text || "?";
          const size = row.container && row.container.text || "";
          const owner = row.owner && row.owner.text || "";
          const typeText = row.type && row.type.text || "";
          const premium = !!row.subrOnly;
          marker._dwData = Object.assign(marker._dwData || {}, {
            color: fill,
            disabled,
            label: TYPE_LABELS[typeId] || "G",
            diff,
            terr,
            size,
            owner,
            favs,
            typeText,
            premium
          });
          if (marker.setTooltipContent) {
            marker.setTooltipContent(
              `<b>${_escHtml(name)}</b>` + (disabled ? " <i>(disabled)</i>" : "") + (premium ? ` <span class="dw-geo-pmo" title="Premium Member Only on geocaching.com — basic info shown here">🔒 Premium</span>` : "") + `<br><span class="dw-cad-sub">${_escHtml(code)} · D ${diff} / T ${terr}` + (size ? " · " + _escHtml(String(size)) : "") + (favs ? ` · ♥ ${favs}` : "") + (typeText ? " · " + _escHtml(typeText) : "") + (owner ? "<br>by " + _escHtml(owner) : "") + (premium ? `<br><i>Full listing needs geocaching.com Premium</i>` : "") + `</span>`
            );
          }
          if (opts && opts.open) {
            window.open(
              `https://www.geocaching.com/geocache/${code}`,
              "_blank",
              "noopener,noreferrer"
            );
          }
          if (opts && opts.popup) {
            this._openDetailPopup(marker, code, row);
          }
        },
        getAttribution() {
          return 'Caches © <a href="https://www.geocaching.com" target="_blank" rel="noreferrer">Geocaching.com</a>';
        }
      });
      return new GeoLayer();
    }
  };

  // src/layers/vector-tile-layer.js
  function makeVectorTileLayer(opts) {
    const debounceMs = opts.debounceMs || 400;
    const timeoutMs = opts.timeoutMs || 2e4;
    const padBounds = opts.padBounds || 0;
    const maxNativeZoom = opts.maxNativeZoom || 16;
    const maxTiles = opts.maxTiles || 60;
    const Layer = L.Layer.extend({
      initialize() {
        this._group = null;
        this._debounce = null;
        this._lastKey = null;
        this._gen = 0;
        this._handles = [];
        this._tileEls = /* @__PURE__ */ new Map();
      },
      onAdd(map) {
        if (!map.getPane(opts.pane)) {
          map.createPane(opts.pane);
          map.getPane(opts.pane).style.zIndex = String(opts.paneZIndex);
        }
        this._group = L.layerGroup().addTo(map);
        this._fetch();
        map.on("moveend zoomend", this._onViewChange, this);
      },
      onRemove(map) {
        clearTimeout(this._debounce);
        this._debounce = null;
        this._gen++;
        this._cancel();
        map.off("moveend zoomend", this._onViewChange, this);
        if (this._group) {
          this._group.remove();
          this._group = null;
        }
        this._tileEls.clear();
      },
      _cacheTile(tk, els) {
        const TILE_EL_MAX = 256;
        this._tileEls.set(tk, els);
        if (this._tileEls.size > TILE_EL_MAX) {
          const oldest = this._tileEls.keys().next().value;
          this._tileEls.delete(oldest);
        }
      },
      _onViewChange() {
        clearTimeout(this._debounce);
        this._debounce = setTimeout(() => this._fetch(), debounceMs);
      },
      _cancel() {
        for (const h of this._handles) gmCancel(h);
        this._handles = [];
      },
      _fetch() {
        const map = this._map;
        if (!map || !this._group) return;
        const vz = map.getZoom();
        if (vz < opts.minZoom) {
          this._group.clearLayers();
          this._lastKey = null;
          this._cancel();
          return;
        }
        const tz = Math.min(Math.floor(vz), maxNativeZoom);
        const n = Math.pow(2, tz);
        const b = padBounds ? map.getBounds().pad(padBounds) : map.getBounds();
        const lon2t = (lon) => Math.floor((lon + 180) / 360 * n);
        const lat2t = (lat) => {
          const r = lat * Math.PI / 180;
          return Math.floor(
            (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n
          );
        };
        const x0 = Math.max(0, lon2t(b.getWest()));
        const x1 = Math.min(n - 1, lon2t(b.getEast()));
        const y0 = Math.max(0, lat2t(b.getNorth()));
        const y1 = Math.min(n - 1, lat2t(b.getSouth()));
        const key = `${tz}:${x0},${y0},${x1},${y1}`;
        if (key === this._lastKey) return;
        this._lastKey = key;
        const coords = [];
        for (let x = x0; x <= x1; x++)
          for (let y = y0; y <= y1; y++) coords.push([x, y]);
        if (coords.length > maxTiles) {
          console.warn(`[CustomTiles] ${opts.label}: ${coords.length} tiles exceeds cap ${maxTiles}, skipping`);
          return;
        }
        const myGen = ++this._gen;
        this._cancel();
        const need = [];
        for (const [x, y] of coords) {
          const tk = `${tz}/${x}/${y}`;
          if (!this._tileEls.has(tk)) need.push([x, y, tk]);
        }
        let pending = need.length;
        let failedAny = false;
        const finish = () => {
          if (myGen !== this._gen || !this._group) return;
          const elements = [];
          for (const [x, y] of coords) {
            const arr = this._tileEls.get(`${tz}/${x}/${y}`);
            if (arr) for (const e of arr) elements.push(e);
          }
          const wayIds = /* @__PURE__ */ new Set();
          for (const el of elements)
            if (el.type === "way" && el._id) wayIds.add(el._id);
          const seenNode = /* @__PURE__ */ new Set();
          const out = elements.filter((el) => {
            if (el.type === "node" && el._id) {
              if (wayIds.has(el._id) || seenNode.has(el._id)) return false;
              seenNode.add(el._id);
            }
            return true;
          });
          this._group.clearLayers();
          opts.render(this._group, out, tz);
          if (failedAny) this._lastKey = null;
        };
        if (!pending) {
          finish();
          return;
        }
        for (const [x, y, tk] of need) {
          const h = gmGet(
            opts.tileUrl(tz, x, y),
            { responseType: "arraybuffer", timeout: timeoutMs },
            (err, r) => {
              if (myGen !== this._gen || !this._group) {
                if (--pending === 0) finish();
                return;
              }
              if (!err && r && r.status === 200 && r.response) {
                const tileEls = [];
                try {
                  const layers = mvtDecode(r.response);
                  for (const layer of layers) {
                    const ext = layer.extent || 4096;
                    for (const f of layer.features) {
                      const props = {};
                      for (let i = 0; i < f.tags.length; i += 2)
                        props[layer.keys[f.tags[i]]] = layer.values[f.tags[i + 1]];
                      const rings = decodeGeometry(f.geom).map((ring) => ring.map((p) => ({
                        lon: (x + p[0] / ext) / n * 360 - 180,
                        lat: Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + p[1] / ext) / n))) * 180 / Math.PI
                      })));
                      const els = opts.toElements(layer.name, props, f.type, rings);
                      if (els) for (const e of els) tileEls.push(e);
                    }
                  }
                  this._cacheTile(tk, tileEls);
                } catch (e) {
                  failedAny = true;
                }
              } else {
                failedAny = true;
              }
              if (--pending === 0) finish();
            }
          );
          this._handles.push(h);
        }
      },
      getAttribution() {
        return opts.attribution;
      }
    });
    return new Layer();
  }

  // src/providers/openinframap.js
  function oimIcon(className, glyph, fill, size) {
    size = size || 15;
    return L.divIcon({
      className,
      html: `<svg viewBox="0 0 16 16" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="6.5" fill="${fill}" stroke="#222" stroke-width="1" opacity="0.92"/><text x="8" y="11.5" text-anchor="middle" font-size="9" font-family="sans-serif" fill="#fff">${glyph}</text></svg>`,
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2]
    });
  }
  var PowerInfraLayerProvider = class extends LayerProvider {
    create() {
      function fmtVoltage(v) {
        const n = parseInt(v, 10) || 0;
        if (!n) return null;
        if (n >= 1e3) {
          const kv = n / 1e3;
          return (Number.isInteger(kv) ? kv : kv.toFixed(1)) + " kV";
        }
        return n + " V";
      }
      function lineColor(voltageStr) {
        const v = parseInt(voltageStr, 10) || 0;
        if (v >= 3e5) return "#D9534F";
        if (v >= 1e5) return "#F0A500";
        if (v >= 33e3) return "#FFD93D";
        if (v > 0) return "#9CCC65";
        return "#aaa";
      }
      function lineWeight(power, voltageStr) {
        const v = parseInt(voltageStr, 10) || 0;
        if (power === "line") return v >= 3e5 ? 3 : v >= 1e5 ? 2.5 : 2;
        if (power === "cable") return 1.6;
        return 1.2;
      }
      const pointIcon = (g, f, s) => oimIcon("dw-infra-icon", g, f, s || 16);
      function kvToV(v) {
        const x = parseFloat(v);
        return x ? String(Math.round(x * 1e3)) : "";
      }
      function fmtMW(v) {
        const x = parseFloat(v);
        if (!x) return "";
        return (Number.isInteger(x) ? x : x < 10 ? x.toFixed(2) : x.toFixed(1)) + " MW";
      }
      return makeVectorTileLayer({
        label: "PowerInfra",
        pane: "dwInfraPane",
        paneZIndex: 410,
        minZoom: 9,
        padBounds: 0.1,
        maxNativeZoom: CFG.OIM_MAX_NATIVE_Z,
        attribution: 'Power data © <a href="https://openinframap.org/" target="_blank" rel="noreferrer">OpenInfraMap</a> / <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>',
        tileUrl: (z, x, y) => `${CFG.OIM_POWER_TILES}/${z}/${x}/${y}.pbf`,
        toElements: (layerName, p, gtype, rings) => {
          if (p.disused) return null;
          if (layerName === "power_line") {
            const t = p.type;
            const power = t === "cable" ? "cable" : t === "minor_line" ? "minor_line" : "line";
            const tags = {
              power,
              voltage: kvToV(p.voltage),
              name: p.name,
              operator: p.operator,
              ref: p.ref
            };
            return rings.map((r) => ({ type: "way", geometry: r, tags }));
          }
          if (layerName === "power_substation") {
            const tags = {
              power: "substation",
              voltage: kvToV(p.voltage),
              name: p.name,
              operator: p.operator
            };
            return rings.map((r) => ({
              type: "way",
              geometry: r,
              tags,
              _id: "sub/" + p.osm_id
            }));
          }
          if (layerName === "power_substation_point") {
            const r = rings[0];
            if (!r || !r.length) return null;
            return [{
              type: "node",
              lat: r[0].lat,
              lon: r[0].lon,
              _id: "sub/" + p.osm_id,
              tags: {
                power: "substation",
                voltage: kvToV(p.voltage),
                name: p.name,
                operator: p.operator
              }
            }];
          }
          if (layerName === "power_plant") {
            const tags = {
              power: "plant",
              "plant:source": p.source,
              "plant:output:electricity": fmtMW(p.output),
              name: p.name,
              operator: p.operator
            };
            return rings.map((r) => ({
              type: "way",
              geometry: r,
              tags,
              _id: "plant/" + p.osm_id
            }));
          }
          if (layerName === "power_plant_point") {
            const r = rings[0];
            if (!r || !r.length) return null;
            return [{
              type: "node",
              lat: r[0].lat,
              lon: r[0].lon,
              _id: "plant/" + p.osm_id,
              tags: {
                power: "plant",
                "plant:source": p.source,
                "plant:output:electricity": fmtMW(p.output),
                name: p.name,
                operator: p.operator
              }
            }];
          }
          if (layerName === "power_generator_area") {
            const tags = {
              power: "generator",
              "generator:source": p.source,
              "generator:output:electricity": fmtMW(p.output),
              name: p.name,
              operator: p.operator
            };
            return rings.map((r) => ({ type: "way", geometry: r, tags }));
          }
          return null;
        },
        render: (group, elements, zoom) => {
          for (const el of elements) {
            const tags = el.tags || {};
            const power = tags.power;
            if (!power) continue;
            const geom = el.geometry || [];
            if (el.type === "way" && geom.length && (power === "line" || power === "minor_line" || power === "cable")) {
              const latlngs = geom.map((g) => [g.lat, g.lon]);
              const color = lineColor(tags.voltage);
              const weight = lineWeight(power, tags.voltage);
              const vLabel2 = fmtVoltage(tags.voltage);
              const tip2 = esc`<b>${vLabel2 || (power === "cable" ? "Underground cable" : "Power line")}</b>` + (tags.name ? esc`<br>${tags.name}` : "") + (tags.operator ? esc`<br>${tags.operator}` : "") + (tags.ref ? esc`<br>Ref: ${tags.ref}` : "");
              L.polyline(latlngs, {
                pane: "dwInfraPane",
                color: "#222",
                weight: weight + 2.5,
                opacity: 0.35,
                interactive: false
              }).addTo(group);
              L.polyline(latlngs, {
                pane: "dwInfraPane",
                color,
                weight,
                opacity: 0.92,
                dashArray: power === "cable" ? "6 4" : null
              }).bindTooltip(tip2, { className: "dw-infra-tip", sticky: true }).addTo(group);
              continue;
            }
            if (el.type === "way" && geom.length && (power === "substation" || power === "plant")) {
              const latlngs = geom.map((g) => [g.lat, g.lon]);
              const isPlant = power === "plant";
              const fill2 = isPlant ? "#9B59B6" : "#F0A500";
              const vLabel2 = fmtVoltage(tags.voltage);
              const tip2 = esc`<b>${tags.name || (isPlant ? "Power plant" : "Substation")}</b>` + (vLabel2 ? esc`<br>${vLabel2}` : "") + (tags.operator ? esc`<br>${tags.operator}` : "") + (tags["plant:source"] ? esc`<br>Source: ${tags["plant:source"]}` : "") + (tags["plant:output:electricity"] ? esc`<br>Output: ${tags["plant:output:electricity"]}` : "");
              L.polygon(latlngs, {
                pane: "dwInfraPane",
                color: fill2,
                weight: 1.5,
                opacity: 0.9,
                fillColor: fill2,
                fillOpacity: 0.2
              }).bindTooltip(tip2, { className: "dw-infra-tip", sticky: true }).addTo(group);
              continue;
            }
            if (el.type === "way" && geom.length && power === "generator" && tags["generator:source"] === "solar") {
              const latlngs = geom.map((g) => [g.lat, g.lon]);
              const tip2 = esc`<b>${tags.name || "Solar farm"}</b>` + (tags["generator:output:electricity"] ? esc`<br>Output: ${tags["generator:output:electricity"]}` : "") + (tags.operator ? esc`<br>${tags.operator}` : "");
              L.polygon(latlngs, {
                pane: "dwInfraPane",
                color: "#F6C90E",
                weight: 1.5,
                opacity: 0.9,
                fillColor: "#F6C90E",
                fillOpacity: 0.25
              }).bindTooltip(tip2, { className: "dw-infra-tip", sticky: true }).addTo(group);
              continue;
            }
            let lat, lon;
            if (el.type === "node") {
              lat = el.lat;
              lon = el.lon;
            } else if (geom.length) {
              let sLat = 0, sLon = 0;
              for (const g of geom) {
                sLat += g.lat;
                sLon += g.lon;
              }
              lat = sLat / geom.length;
              lon = sLon / geom.length;
            } else {
              continue;
            }
            if (!isFinite(lat) || !isFinite(lon)) continue;
            const src = tags["generator:source"] || "";
            let glyph, fill, label;
            if (power === "substation") {
              glyph = "⚡";
              fill = "#F0A500";
              label = tags.name || "Substation";
            } else if (power === "plant") {
              glyph = "⚙";
              fill = "#9B59B6";
              label = tags.name || "Power plant";
            } else if (power === "transformer") {
              glyph = "T";
              fill = "#E67E22";
              label = "Transformer";
            } else if (src === "wind") {
              glyph = "〇";
              fill = "#5B9BD5";
              label = tags.name || "Wind turbine";
            } else if (src === "solar") {
              glyph = "☀";
              fill = "#F6C90E";
              label = tags.name || "Solar generator";
            } else {
              glyph = "⚡";
              fill = "#aaa";
              label = tags.name || power;
            }
            const sz = power === "transformer" ? 12 : 16;
            const vLabel = fmtVoltage(tags.voltage);
            let tip = esc`<b>${label}</b>`;
            if (vLabel) tip += esc`<br>${vLabel}`;
            if (tags.operator) tip += esc`<br>${tags.operator}`;
            if (tags["generator:output:electricity"]) tip += esc`<br>Output: ${tags["generator:output:electricity"]}`;
            if (tags["plant:source"]) tip += esc`<br>Source: ${tags["plant:source"]}`;
            L.marker([lat, lon], { icon: pointIcon(glyph, fill, sz), pane: "dwInfraPane", interactive: true }).bindTooltip(tip, { className: "dw-infra-tip", sticky: true }).addTo(group);
          }
        }
      });
    }
  };
  var TelecomsLayerProvider = class extends LayerProvider {
    create() {
      const dotIcon = (g, f, s) => oimIcon("dw-telecom-icon", g, f, s || 15);
      const DC_FILL = "#00897B";
      const MAST_FILL = "#26A69A";
      return makeVectorTileLayer({
        label: "Telecoms",
        pane: "dwTelecomPane",
        paneZIndex: 409,
        minZoom: 10,
        padBounds: 0.1,
        maxNativeZoom: CFG.OIM_MAX_NATIVE_Z,
        attribution: 'Telecoms data © <a href="https://openinframap.org/" target="_blank" rel="noreferrer">OpenInfraMap</a> / <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>',
        tileUrl: (z, x, y) => `${CFG.OIM_TELECOM_TILES}/${z}/${x}/${y}.pbf`,
        toElements: (layerName, p, gtype, rings) => {
          if (p.disused) return null;
          if (layerName === "telecoms_data_center") {
            const tags = {
              kind: "datacenter",
              name: p.name,
              operator: p.operator,
              dtype: p.type
            };
            return rings.map((r) => ({
              type: "way",
              geometry: r,
              tags,
              _id: "dc/" + p.osm_id
            }));
          }
          if (layerName === "telecoms_data_center_point") {
            const r = rings[0];
            if (!r || !r.length) return null;
            return [{
              type: "node",
              lat: r[0].lat,
              lon: r[0].lon,
              _id: "dc/" + p.osm_id,
              tags: {
                kind: "datacenter",
                name: p.name,
                operator: p.operator,
                dtype: p.type
              }
            }];
          }
          if (layerName === "telecoms_mast" || layerName === "telecoms_antenna") {
            const r = rings[0];
            if (!r || !r.length) return null;
            return [{
              type: "node",
              lat: r[0].lat,
              lon: r[0].lon,
              tags: {
                kind: layerName === "telecoms_mast" ? "mast" : "antenna",
                name: p.name,
                operator: p.operator
              }
            }];
          }
          return null;
        },
        render: (group, elements) => {
          for (const el of elements) {
            const t = el.tags || {};
            if (el.type === "way" && el.geometry && el.geometry.length) {
              const latlngs = el.geometry.map((g) => [g.lat, g.lon]);
              const tip2 = esc`<b>${t.name || "Telephone exchange / data centre"}</b>` + (t.dtype ? esc`<br>${t.dtype}` : "") + (t.operator ? esc`<br>${t.operator}` : "");
              L.polygon(latlngs, {
                pane: "dwTelecomPane",
                color: DC_FILL,
                weight: 1.5,
                opacity: 0.9,
                fillColor: DC_FILL,
                fillOpacity: 0.2
              }).bindTooltip(tip2, { className: "dw-infra-tip", sticky: true }).addTo(group);
              continue;
            }
            if (el.type !== "node" || !isFinite(el.lat) || !isFinite(el.lon))
              continue;
            let glyph, fill, label;
            if (t.kind === "datacenter") {
              glyph = "▣";
              fill = DC_FILL;
              label = t.name || "Telephone exchange / data centre";
            } else if (t.kind === "mast") {
              glyph = "T";
              fill = MAST_FILL;
              label = t.name || "Comms mast";
            } else {
              glyph = "Y";
              fill = MAST_FILL;
              label = t.name || "Antenna";
            }
            let tip = esc`<b>${label}</b>`;
            if (t.dtype) tip += esc`<br>${t.dtype}`;
            if (t.operator) tip += esc`<br>${t.operator}`;
            L.marker([el.lat, el.lon], {
              icon: dotIcon(glyph, fill, t.kind === "datacenter" ? 16 : 13),
              pane: "dwTelecomPane",
              interactive: true
            }).bindTooltip(tip, { className: "dw-infra-tip", sticky: true }).addTo(group);
          }
        }
      });
    }
  };
  var WaterLayerProvider = class extends LayerProvider {
    create() {
      const dotIcon = (g, f, s) => oimIcon("dw-water-icon", g, f, s || 14);
      const STYLE = {
        plant_water: { fill: "#0277BD", glyph: "≈", label: "Water treatment plant" },
        plant_waste: { fill: "#6D4C41", glyph: "≈", label: "Wastewater plant" },
        reservoir: { fill: "#0288D1", glyph: "R", label: "Reservoir" },
        tower: { fill: "#0288D1", glyph: "T", label: "Water tower" },
        well: { fill: "#0288D1", glyph: "○", label: "Well" },
        pump: { fill: "#00897B", glyph: "P", label: "Pumping station" }
      };
      const WASTE = /waste|sewage|sewer|drain/i;
      return makeVectorTileLayer({
        label: "Water",
        pane: "dwWaterPane",
        paneZIndex: 400,
        minZoom: 10,
        padBounds: 0.1,
        maxNativeZoom: CFG.OIM_MAX_NATIVE_Z,
        attribution: 'Water data © <a href="https://openinframap.org/" target="_blank" rel="noreferrer">OpenInfraMap</a> / <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>',
        tileUrl: (z, x, y) => `${CFG.OIM_WATER_TILES}/${z}/${x}/${y}.pbf`,
        toElements: (layerName, p, gtype, rings) => {
          if (p.disused) return null;
          const tagsFor = (wk) => ({
            wk,
            name: p.name,
            operator: p.operator,
            substance: p.substance
          });
          const ways = (wk, id) => rings.map((r) => ({
            type: "way",
            geometry: r,
            tags: tagsFor(wk),
            _id: id
          }));
          const point = (wk, id) => {
            const r = rings[0];
            if (!r || !r.length) return null;
            return [{
              type: "node",
              lat: r[0].lat,
              lon: r[0].lon,
              _id: id,
              tags: tagsFor(wk)
            }];
          };
          switch (layerName) {
            case "water_pipeline": {
              const wk = WASTE.test(p.substance || "") ? "pipe_waste" : "pipe_water";
              return rings.map((r) => ({
                type: "way",
                geometry: r,
                tags: tagsFor(wk)
              }));
            }
            case "water_treatment_plant_polygon":
              return ways("plant_water", "wtp/" + p.osm_id);
            case "water_treatment_plant_point":
              return point("plant_water", "wtp/" + p.osm_id);
            case "wastewater_plant_polygon":
              return ways("plant_waste", "wwp/" + p.osm_id);
            case "wastewater_plant_point":
              return point("plant_waste", "wwp/" + p.osm_id);
            case "water_reservoir":
              return ways("reservoir", "res/" + p.osm_id);
            case "water_reservoir_point":
              return point("reservoir", "res/" + p.osm_id);
            case "pumping_station_polygon":
              return ways("pump", "pmp/" + p.osm_id);
            case "pumping_station_point":
              return point("pump", "pmp/" + p.osm_id);
            case "water_tower":
              return point("tower");
            case "water_well":
              return point("well");
            default:
              return null;
          }
        },
        render: (group, elements) => {
          for (const el of elements) {
            const t = el.tags || {};
            const extra = (t.operator ? esc`<br>${t.operator}` : "") + (t.substance ? esc`<br>${t.substance}` : "");
            if (el.type === "way" && el.geometry && el.geometry.length) {
              const latlngs = el.geometry.map((g) => [g.lat, g.lon]);
              if (t.wk === "pipe_water" || t.wk === "pipe_waste") {
                const waste = t.wk === "pipe_waste";
                L.polyline(latlngs, {
                  pane: "dwWaterPane",
                  color: waste ? "#8D6E63" : "#039BE5",
                  weight: 2,
                  opacity: 0.9,
                  dashArray: waste ? "5 4" : null
                }).bindTooltip(
                  esc`<b>${t.name || (waste ? "Wastewater pipeline" : "Water pipeline")}</b>` + extra,
                  { className: "dw-infra-tip", sticky: true }
                ).addTo(group);
                continue;
              }
              const st2 = STYLE[t.wk] || STYLE.reservoir;
              L.polygon(latlngs, {
                pane: "dwWaterPane",
                color: st2.fill,
                weight: 1.5,
                opacity: 0.9,
                fillColor: st2.fill,
                fillOpacity: 0.2
              }).bindTooltip(
                esc`<b>${t.name || st2.label}</b>` + extra,
                { className: "dw-infra-tip", sticky: true }
              ).addTo(group);
              continue;
            }
            if (el.type !== "node" || !isFinite(el.lat) || !isFinite(el.lon))
              continue;
            const st = STYLE[t.wk];
            if (!st) continue;
            L.marker([el.lat, el.lon], {
              icon: dotIcon(st.glyph, st.fill, t.wk === "well" ? 12 : 14),
              pane: "dwWaterPane",
              interactive: true
            }).bindTooltip(
              esc`<b>${t.name || st.label}</b>` + extra,
              { className: "dw-infra-tip", sticky: true }
            ).addTo(group);
          }
        }
      });
    }
  };

  // src/tokens.js
  var TokenManagerBase = class {
    constructor(opts) {
      opts = opts || {};
      this._label = opts.label || "Token";
      this._refreshMargin = opts.refreshMarginMs || CFG.REFRESH_MARGIN;
      this.expires = 0;
      this.fetching = false;
      this.pending = [];
      this.refreshScheduled = false;
      this.retryCount = 0;
      this.onRefresh = null;
    }
    isValid() {
      return false;
    }
    _cached() {
      return [];
    }
    _fetch(done) {
      done(new Error(`${this._label} _fetch() not implemented`));
    }
    get(cb) {
      if (this.isValid()) {
        cb(null, ...this._cached());
        return;
      }
      this.pending.push(cb);
      if (this.fetching) return;
      this.fetching = true;
      this._fetch((err, ...result) => {
        this.fetching = false;
        const cbs = this.pending.splice(0);
        cbs.forEach((fn) => fn(err, ...result));
        if (!err) {
          this.retryCount = 0;
          this.scheduleRefresh();
        } else if (!this.refreshScheduled) {
          const delay = Math.min(
            CFG.RETRY_DELAY * Math.pow(2, this.retryCount),
            CFG.RETRY_MAX_DELAY
          );
          this.retryCount++;
          setTimeout(() => this.scheduleRefresh(), delay);
        }
      });
    }
    scheduleRefresh() {
      if (this.refreshScheduled) return;
      this.refreshScheduled = true;
      const wait = Math.min(
        2147483647,
        Math.max(3e4, this.expires - Date.now() - this._refreshMargin)
      );
      setTimeout(() => {
        this.refreshScheduled = false;
        this._fetch((err, ...result) => {
          if (err) {
            const delay = Math.min(
              CFG.RETRY_DELAY * Math.pow(2, this.retryCount),
              CFG.RETRY_MAX_DELAY
            );
            this.retryCount++;
            console.warn(
              `[CustomTiles] ${this._label} token refresh failed:`,
              err.message,
              "- retry in",
              Math.round(delay / 6e4),
              "min"
            );
            setTimeout(() => this.scheduleRefresh(), delay);
            return;
          }
          this.retryCount = 0;
          if (this.onRefresh) this.onRefresh(...result);
          this.scheduleRefresh();
        });
      }, wait);
    }
  };
  var QldTokenManager = class _QldTokenManager extends TokenManagerBase {
    constructor(opts) {
      opts = opts || {};
      super({ label: opts.label || "QLD" });
      this._serviceUrl = opts.serviceUrl || CFG.QLD_SERVICE;
      this._storageKey = opts.storageKey || "qld_token";
      this.token = GM_getValue(this._storageKey, null);
      this.expires = GM_getValue(this._storageKey + "_expires", 0);
    }
    isValid() {
      return !!(this.token && this.expires - Date.now() > CFG.REFRESH_MARGIN);
    }
    _cached() {
      return [this.token];
    }
    save(token, expiresMs) {
      this.token = token;
      this.expires = expiresMs;
      GM_setValue(this._storageKey, token);
      GM_setValue(this._storageKey + "_expires", expiresMs);
    }
    _fetch(done) {
      gmGet(CFG.QLD_ORIGIN + "/", {
        anonymous: false,
        headers: {
          Accept: "text/html,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          Origin: CFG.QLD_ORIGIN,
          Referer: CFG.QLD_ORIGIN + "/"
        }
      }, (err, r) => {
        if (err) {
          done(new Error(
            `[${this._label}] GET qldglobe.information.qld.gov.au failed`
          ));
          return;
        }
        const csrf = _QldTokenManager._xsrfFromSetCookie(r.responseHeaders) || _QldTokenManager._csrfFromHtml(r.responseText);
        if (!csrf) {
          done(new Error(
            `[${this._label}] CSRF token not found in Set-Cookie or HTML`
          ));
          return;
        }
        this._doPost(csrf, done);
      });
    }
    _doPost(csrf, done) {
      gmJsonGet(CFG.QLD_TOKEN_EP, {
        method: "POST",
        anonymous: false,
        headers: {
          "Content-Type": "application/json",
          "X-Requested-With": "XMLHttpRequest",
          Origin: CFG.QLD_ORIGIN,
          Referer: CFG.QLD_ORIGIN + "/"
        },
        data: JSON.stringify({
          url: this._serviceUrl,
          location: {
            href: CFG.QLD_ORIGIN + "/",
            origin: CFG.QLD_ORIGIN,
            protocol: "https:",
            host: "qldglobe.information.qld.gov.au",
            hostname: "qldglobe.information.qld.gov.au",
            port: "",
            pathname: "/",
            search: "",
            hash: "",
            ancestorOrigins: {}
          },
          _csrf: csrf
        })
      }, (err, data, raw) => {
        if (err) {
          const tail = raw && raw.responseText ? `: ${raw.responseText.slice(0, 160)}` : "";
          done(new Error(`[${this._label}] Token endpoint ${err.message}${tail}`), null);
          return;
        }
        if (!data.token) {
          done(new Error(`[${this._label}] Parse error: No token field in response`), null);
          return;
        }
        const exp = data.expires ? data.expires > 1e12 ? data.expires : data.expires * 1e3 : Date.now() + CFG.DEFAULT_TTL;
        this.save(data.token, exp);
        console.info(
          `[CustomTiles] ${this._label} token acquired, expires`,
          new Date(exp).toISOString()
        );
        done(null, data.token);
      });
    }
    static _xsrfFromSetCookie(rawHeaders) {
      if (!rawHeaders) return null;
      for (const line of rawHeaders.split(/\r?\n/)) {
        if (/^set-cookie\s*:/i.test(line)) {
          const pair = line.replace(/^set-cookie\s*:\s*/i, "").split(";")[0];
          const eq = pair.indexOf("=");
          if (eq > -1 && pair.slice(0, eq).trim() === "XSRF-TOKEN") {
            return decodeURIComponent(pair.slice(eq + 1).trim());
          }
        }
      }
      return null;
    }
    static _csrfFromHtml(html) {
      const patterns = [
        /<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)["']/i,
        /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']csrf-token["']/i,
        /window\._csrf\s*=\s*["']([^"']+)["']/,
        /['"_]csrf['"]\s*:\s*["']([^"']{20,80})["']/,
        /csrfToken\s*:\s*["']([^"']{20,80})["']/,
        /<input[^>]+name=["']_csrf["'][^>]+value=["']([^"']+)["']/i,
        /<input[^>]+value=["']([^"']+)["'][^>]+name=["']_csrf["']/i
      ];
      for (const p of patterns) {
        const m = html.match(p);
        if (m) return m[1];
      }
      return null;
    }
  };
  var AppleTokenManager = class extends TokenManagerBase {
    constructor() {
      super({ label: "Apple" });
      this.accessKey = GM_getValue("apple_accesskey", null);
      this.version = GM_getValue("apple_version", CFG.APPLE_DEFAULT_V);
      this.expires = GM_getValue("apple_accesskey_expires", 0);
    }
    isValid() {
      return !!(this.accessKey && this.expires - Date.now() > CFG.REFRESH_MARGIN);
    }
    _cached() {
      return [this.accessKey, this.version];
    }
    save(accessKey, version, expiresMs) {
      this.accessKey = accessKey;
      this.version = version || this.version;
      this.expires = expiresMs;
      GM_setValue("apple_accesskey", accessKey);
      GM_setValue("apple_version", this.version);
      GM_setValue("apple_accesskey_expires", expiresMs);
    }
    _fetch(done) {
      gmGet(CFG.APPLE_DDG_TOKEN_URL, {
        headers: {
          Accept: "*/*",
          Referer: CFG.APPLE_DDG_ORIGIN + "/"
        }
      }, (err, r) => {
        if (err || r.status < 200 || r.status >= 300) {
          done(new Error("[Apple] DDG token HTTP " + (r ? r.status : "network")));
          return;
        }
        const jwt = (r.responseText || "").trim();
        if (!/^[\w-]+\.[\w-]+\.[\w-]+$/.test(jwt)) {
          done(new Error("[Apple] DDG returned invalid JWT"));
          return;
        }
        this._doBootstrap(jwt, done);
      });
    }
    _doBootstrap(jwt, done) {
      gmGet(CFG.APPLE_BOOTSTRAP_URL, {
        headers: {
          Accept: "*/*",
          Authorization: "Bearer " + jwt,
          Origin: CFG.APPLE_DDG_ORIGIN,
          Referer: CFG.APPLE_DDG_ORIGIN + "/"
        }
      }, (err, r) => {
        if (err) {
          done(new Error("[Apple] Bootstrap network error"));
          return;
        }
        if (r.status < 200 || r.status >= 300) {
          done(new Error(
            `[Apple] Bootstrap HTTP ${r.status}: ${r.responseText.slice(0, 160)}`
          ));
          return;
        }
        try {
          const data = JSON.parse(r.responseText);
          if (!data.accessKey) throw new Error("No accessKey in bootstrap response");
          const vMatch = r.responseText.match(/[?&]v=(\d+)/);
          const version = vMatch ? vMatch[1] : this.version;
          const exp = Date.now() + CFG.APPLE_TOKEN_TTL;
          this.save(data.accessKey, version, exp);
          console.info(
            "[CustomTiles] Apple accessKey acquired, v=" + version + ", expires",
            new Date(exp).toISOString()
          );
          done(null, data.accessKey, version);
        } catch (e) {
          done(new Error("[Apple] Bootstrap parse: " + e.message));
        }
      });
    }
  };

  // src/app/custom-tiles-app.js
  var pageWin3 = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
  var { QpwsLayerProvider, NationalParksLayerProvider } = createQldEnvironmentProviders({ makeHoverIdentify, gmJsonGet });
  var CustomTilesApp = class {
    constructor() {
      this.qldToken = new QldTokenManager({
        serviceUrl: CFG.QLD_SERVICE,
        storageKey: "qld_token",
        label: "QLD Globe"
      });
      this.qldPhotosToken = new QldTokenManager({
        serviceUrl: CFG.QLD_HIST_PHOTOS_SERVICE,
        storageKey: "qld_photos_token",
        label: "QLD Photos"
      });
      this.appleToken = new AppleTokenManager();
      this.layers = {};
      this.injected = false;
      this.histCompass = null;
      this.waybackHistControl = null;
      this.qldToken.onRefresh = (token) => {
        const qld = this.layers[CFG.LAYER_QLD];
        const roads = this.layers[CFG.LAYER_ROADS];
        if (qld)
          qld.setUrl(CFG.QLD_TILE_TPL + (token ? "?token=" + token : ""));
        if (roads) roads.redraw();
      };
      this.appleToken.onRefresh = (accessKey, version) => {
        const apple = this.layers[CFG.LAYER_APPLE];
        if (apple) apple.setUrl(buildAppleTileUrl(accessKey, version));
      };
    }
    boot() {
      this._injectStyles();
      if (this.qldToken.isValid()) {
        this.qldToken.scheduleRefresh();
      } else {
        this.qldToken.get((err) => {
          if (err)
            console.warn("[CustomTiles] Initial QLD token fetch:", err.message);
        });
      }
      if (this.appleToken.isValid()) {
        this.appleToken.scheduleRefresh();
      } else {
        this.appleToken.get((err) => {
          if (err)
            console.warn(
              "[CustomTiles] Initial Apple token fetch:",
              err.message
            );
        });
      }
      this._patchControlLayers();
    }
    // -- Leaflet interception -----------------------------------------
    _patchControlLayers() {
      if (typeof pageWin3.L !== "undefined" && pageWin3.L.control && pageWin3.L.tileLayer) {
        this._applyPatch();
      } else {
        try {
          Object.defineProperty(pageWin3, "L", {
            configurable: true,
            enumerable: true,
            set: (val) => {
              Object.defineProperty(pageWin3, "L", {
                value: val,
                writable: true,
                configurable: true,
                enumerable: true
              });
              if (val && val.control && val.tileLayer) this._applyPatch();
            }
          });
        } catch (e) {
          console.warn("[CustomTiles] defineProperty fallback:", e.message);
          const poll = () => {
            if (typeof pageWin3.L !== "undefined" && pageWin3.L.control && pageWin3.L.tileLayer) {
              this._applyPatch();
            } else {
              setTimeout(poll, 16);
            }
          };
          poll();
        }
      }
    }
    _applyPatch() {
      const orig = L.control.layers;
      const app = this;
      L.control.layers = function(baseLayers, overlays, opts) {
        const ctrl = orig.apply(this, arguments);
        const isMain = baseLayers && Object.keys(baseLayers).length >= 1;
        if (isMain) {
          const _addTo = ctrl.addTo.bind(ctrl);
          ctrl.addTo = function(m) {
            const ret = _addTo(m);
            try {
              app._injectLayers(ctrl, m);
            } catch (e) {
              console.error("[CustomTiles] Injection error:", e);
            }
            return ret;
          };
        }
        return ctrl;
      };
    }
    _injectLayers(ctrl, map) {
      if (this.injected) return;
      this.injected = true;
      this._ctrl = ctrl;
      try {
        pageWin3._dwLayerCtrl = ctrl;
      } catch (_) {
      }
      const addBase = (name, provider) => {
        const lyr = this.layers[name] = provider.create();
        ctrl.addBaseLayer(lyr, name);
        return lyr;
      };
      const addOverlay = (name, provider) => {
        const lyr = this.layers[name] = provider.create();
        ctrl.addOverlay(lyr, name);
        return lyr;
      };
      try {
        addBase(CFG.LAYER_GOOGLE, new GoogleHybridLayerProvider());
        addBase(CFG.LAYER_APPLE, new AppleMapsLayerProvider(this.appleToken));
        addBase(CFG.LAYER_STAMEN_TERRAIN, new StamenTerrainLayerProvider());
        addBase(CFG.LAYER_VEXCEL, new VexcelLayerProvider());
        const vexCtl = this._vexCtl = createVexcelControl();
        this.vexcelHistControl = this._makeHistoryBar({
          layer: vexCtl,
          event: "capturechange",
          getCount: () => vexCtl.getCaptureCount(),
          getIdx: () => vexCtl.getCaptureIdx(),
          setIdx: (i) => vexCtl.setCapture(i),
          getLabel: (i) => vexCtl.getCaptureDate(i),
          getState: () => vexCtl.getCaptureState()
        });
        vexCtl.on("overlaytoggle", () => this._syncVexcelHistControl(map));
        const wayLyr = addBase(CFG.LAYER_WAYBACK, new WaybackLayerProvider());
        this.waybackHistControl = this._makeHistoryBar({
          layer: wayLyr,
          event: "histchange",
          getCount: () => wayLyr.getHistCount(),
          getIdx: () => wayLyr.getHistIdx(),
          setIdx: (i) => wayLyr.setHistIdx(i),
          getLabel: (i) => wayLyr.getHistLabel(i)
        });
        addBase(CFG.LAYER_QLD, new QldGlobeLayerProvider(this.qldToken));
        const qldLyr = addBase(
          CFG.LAYER_HIST,
          new QldHistoricalLayerProvider(this.qldPhotosToken)
        );
        this.histCompass = this._makeHistoryBar({
          layer: qldLyr,
          event: "capturechange",
          getCount: () => qldLyr.getCaptureCount(),
          getIdx: () => qldLyr.getCaptureIdx(),
          setIdx: (i) => qldLyr.setCapture(i),
          getLabel: (i) => qldLyr.getCaptureDate(i)
        });
        addBase(CFG.LAYER_TOPO, new QldTopoLayerProvider());
        this._injectGroupHeaders(ctrl);
        addOverlay(CFG.LAYER_STRAVA, new StravaHeatmapLayerProvider());
        addOverlay(CFG.LAYER_GARMIN, new GarminHeatmapLayerProvider());
        addOverlay(CFG.LAYER_WATER, new WaterLayerProvider());
        addOverlay(CFG.LAYER_FLIGHTS, new FlightsLayerProvider());
        addOverlay(CFG.LAYER_MARINE, new MarineTrafficLayerProvider());
        addOverlay(CFG.LAYER_WAZE, new WazeLayerProvider());
        addOverlay(CFG.LAYER_GEOCACHING, new GeocachingLayerProvider());
        addOverlay(CFG.LAYER_MOBILE, new MobileCoverageLayerProvider());
        addOverlay(CFG.LAYER_SEAMARKS, new OpenSeaMapLayerProvider());
        addOverlay(CFG.LAYER_INFRA, new PowerInfraLayerProvider());
        addOverlay(CFG.LAYER_TELECOM, new TelecomsLayerProvider());
        addOverlay(CFG.LAYER_LIGHTPOL, new LightPollutionLayerProvider());
        addOverlay(CFG.LAYER_CADASTRE, new QldCadastreLayerProvider());
        addOverlay(CFG.LAYER_SCC_APPS, new SccApplicationsLayerProvider());
        addOverlay(CFG.LAYER_QPWS, new QpwsLayerProvider());
        addOverlay(CFG.LAYER_RELIEF, new QldReliefLayerProvider());
        addOverlay(
          CFG.LAYER_NATIONAL_PARKS,
          new NationalParksLayerProvider()
        );
        addOverlay(
          CFG.LAYER_INTVL_GLOBAL,
          new IntvlGlobalTilesLayerProvider()
        );
        this._mode3DController = new Mode3DController(this);
        Mode3DButton.attach(map, this._mode3DController);
        if (!map.getPane("dwRoadsPane")) {
          map.createPane("dwRoadsPane");
          map.getPane("dwRoadsPane").style.zIndex = 225;
          map.getPane("dwRoadsPane").style.pointerEvents = "none";
        }
        if (!map.getPane("dwLabelsPane")) {
          map.createPane("dwLabelsPane");
          map.getPane("dwLabelsPane").style.zIndex = 250;
          map.getPane("dwLabelsPane").style.pointerEvents = "none";
        }
        this.layers[CFG.LAYER_ROADS] = new QldRoadsLayerProvider(
          this.qldToken
        ).create();
        this.layers[CFG.LAYER_LABELS] = new QldLabelsLayerProvider().create();
        this.layers[CFG.LAYER_ESRI_REF] = new EsriReferenceLayerProvider().create();
        map.on("baselayerchange", () => {
          this._syncLabelsLayer(map);
          this._syncHistCompass(map);
          this._syncWaybackHistControl(map);
          this._syncVexcelHistControl(map);
          this._syncZoomLevel(map);
        });
        map.on("layeradd", (e) => {
          if (e.layer === this.layers[CFG.LAYER_QLD] || e.layer === this.layers[CFG.LAYER_GOOGLE] || e.layer === this.layers[CFG.LAYER_HIST] || e.layer === this.layers[CFG.LAYER_TOPO] || e.layer === this.layers[CFG.LAYER_WAYBACK] || e.layer === this.layers[CFG.LAYER_VEXCEL]) {
            this._syncLabelsLayer(map);
            this._syncHistCompass(map);
            this._syncWaybackHistControl(map);
            this._syncVexcelHistControl(map);
            this._syncZoomLevel(map);
          }
        });
        for (const [name, layer] of Object.entries(this.layers || {})) {
          if (!layer) continue;
          const origOnAdd = layer.onAdd;
          const origOnRemove = layer.onRemove;
          if (typeof origOnAdd === "function") {
            layer.onAdd = function(m) {
              try {
                return origOnAdd.call(this, m);
              } catch (e) {
                console.warn(`[CustomTiles] onAdd '${name}':`, e);
              }
            };
          }
          if (typeof origOnRemove === "function") {
            layer.onRemove = function(m) {
              try {
                return origOnRemove.call(this, m);
              } catch (e) {
                console.warn(`[CustomTiles] onRemove '${name}':`, e);
              }
            };
          }
        }
        this._restoreLayer(map);
        this._restoreOverlays(map, ctrl);
        this._normalizeBaseZoom(map);
        map.on("baselayerchange", () => this._normalizeBaseZoom(map));
        map.on("zoomend", () => this._reenableBaseSelectability());
        new LayerManagerUI(ctrl).setup();
        this._hookSitePopup(map);
      } catch (e) {
        this.injected = false;
        throw e;
      }
    }
    // -- Layer sync ---------------------------------------------------
    _syncLabelsLayer(map) {
      const isQld = map.hasLayer(this.layers[CFG.LAYER_QLD]) || map.hasLayer(this.layers[CFG.LAYER_HIST]);
      for (const lyr of [
        this.layers[CFG.LAYER_ROADS],
        this.layers[CFG.LAYER_LABELS]
      ]) {
        if (!lyr) continue;
        if (isQld) {
          if (!map.hasLayer(lyr)) map.addLayer(lyr);
        } else {
          if (map.hasLayer(lyr)) map.removeLayer(lyr);
        }
      }
      const esriRef = this.layers[CFG.LAYER_ESRI_REF];
      if (esriRef) {
        const wantEsri = map.hasLayer(this.layers[CFG.LAYER_WAYBACK]) || map.hasLayer(this.layers[CFG.LAYER_VEXCEL]);
        if (wantEsri && !map.hasLayer(esriRef)) map.addLayer(esriRef);
        else if (!wantEsri && map.hasLayer(esriRef)) map.removeLayer(esriRef);
      }
    }
    _syncHistCompass(map) {
      const hist = this.histCompass;
      if (!hist) return;
      const isHist = !!(this.layers[CFG.LAYER_HIST] && map.hasLayer(this.layers[CFG.LAYER_HIST]));
      if (isHist && !hist._map) hist.addTo(map);
      else if (!isHist && hist._map) hist.remove();
    }
    _syncWaybackHistControl(map) {
      const ctrl = this.waybackHistControl;
      if (!ctrl) return;
      const active = !!(this.layers[CFG.LAYER_WAYBACK] && map.hasLayer(this.layers[CFG.LAYER_WAYBACK]));
      if (active && !ctrl._map) ctrl.addTo(map);
      else if (!active && ctrl._map) ctrl.remove();
    }
    _syncVexcelHistControl(map) {
      const ctrl = this.vexcelHistControl;
      if (!ctrl) return;
      const active = !!(this.layers[CFG.LAYER_VEXCEL] && map.hasLayer(this.layers[CFG.LAYER_VEXCEL]));
      if (active && !ctrl._map) ctrl.addTo(map);
      else if (!active && ctrl._map) ctrl.remove();
    }
    _syncZoomLevel(map) {
      const ours = [
        CFG.LAYER_QLD,
        CFG.LAYER_HIST,
        CFG.LAYER_TOPO,
        CFG.LAYER_WAYBACK,
        CFG.LAYER_GOOGLE,
        CFG.LAYER_APPLE,
        CFG.LAYER_STAMEN_TERRAIN
      ];
      const isDeep = ours.some(
        (name) => this.layers[name] && map.hasLayer(this.layers[name])
      );
      const newMax = isDeep ? 25 : 22;
      map.setMaxZoom(newMax);
      if (map.getZoom() > newMax) map.setZoom(newMax);
    }
    // Keep EVERY base layer — including dynamic.watch's own (Satellite,
    // Satellite Hi-Res, OpenCycleMap, …) — selectable AND rendering at
    // deep zoom. Two problems this solves:
    //   1. Leaflet's L.Control.Layers disables the radio of any base
    //      whose `maxZoom < current map zoom`. Once our overzooming
    //      bases unlock z25, the site's shallower bases (cap ~19-20)
    //      get their radios greyed out — you can't switch back to them.
    //   2. Even if selectable, a base with maxZoom below the view drops
    //      out of range and shows nothing.
    // Fix: lift each base tile/grid layer's maxZoom to the deep max and
    // pin maxNativeZoom at its old ceiling so Leaflet STRETCHES its
    // deepest tile; and neutralise the zoom-based input disabling.
    _normalizeBaseZoom(map) {
      const ctrl = this._ctrl;
      if (!ctrl || !ctrl._layers) return;
      const DEEP = 25;
      for (const entry of ctrl._layers) {
        if (entry.overlay) continue;
        const lyr = entry.layer;
        const o = lyr && lyr.options;
        if (!o) continue;
        const isGrid = lyr instanceof L.GridLayer || lyr instanceof L.TileLayer;
        if (!isGrid) continue;
        const curMax = typeof o.maxZoom === "number" ? o.maxZoom : DEEP;
        if (curMax < DEEP) {
          if (o.maxNativeZoom == null) o.maxNativeZoom = curMax;
          o.maxZoom = DEEP;
          if (lyr._map && typeof lyr.redraw === "function") {
            try {
              lyr.redraw();
            } catch (_) {
            }
          }
        }
      }
      if (!ctrl._dwSelectablePatched && typeof ctrl._checkDisabledLayers === "function") {
        ctrl._dwSelectablePatched = true;
        ctrl._checkDisabledLayers = function() {
          for (const inp of this._layerControlInputs || []) {
            if (inp) inp.disabled = false;
          }
        };
      }
      this._reenableBaseSelectability();
    }
    // Cheap zoomend path: re-clear the zoom-based radio disabling.
    // Leaflet binds its ORIGINAL _checkDisabledLayers to zoomend at
    // addTo time (captured by reference), so reassigning the method
    // doesn't stop the original from re-disabling on zoom — we call
    // our patched version again to undo it. No base-layer loop here.
    _reenableBaseSelectability() {
      const ctrl = this._ctrl;
      if (ctrl && typeof ctrl._checkDisabledLayers === "function") {
        try {
          ctrl._checkDisabledLayers();
        } catch (_) {
        }
      }
    }
    // -- Layer restore ------------------------------------------------
    // Save which overlays are active to localStorage so they survive page
    // reloads. Restore is called once after all overlays are registered;
    // saving happens on every overlayadd/overlayremove event.
    _restoreOverlays(map, ctrl) {
      const overlayNames = new Set(
        ctrl._layers.filter((l) => l.overlay).map((l) => l.name)
      );
      try {
        const saved = JSON.parse(localStorage.getItem(CFG.OVERLAY_STATE_KEY) || "[]");
        for (const name of saved) {
          const lyr = this.layers[name];
          if (lyr && overlayNames.has(name) && !map.hasLayer(lyr)) {
            map.addLayer(lyr);
          }
        }
      } catch (_) {
      }
      const save = () => {
        const active = [];
        for (const [name, lyr] of Object.entries(this.layers)) {
          if (lyr && overlayNames.has(name) && map.hasLayer(lyr)) active.push(name);
        }
        try {
          localStorage.setItem(CFG.OVERLAY_STATE_KEY, JSON.stringify(active));
        } catch (_) {
        }
      };
      map.on("overlayadd overlayremove", save);
    }
    _restoreLayer(map) {
      const saved = this._readPageCookie(CFG.MAPTYPE_COOKIE);
      const target = saved ? this.layers[saved] : null;
      if (!target) return;
      const baseLayers = new Set(
        (this._ctrl && this._ctrl._layers || []).filter((entry) => !entry.overlay).map((entry) => entry.layer)
      );
      map.whenReady(() => {
        const toRemove = [];
        baseLayers.forEach((l) => {
          if (l !== target && map.hasLayer(l)) toRemove.push(l);
        });
        toRemove.forEach((l) => map.removeLayer(l));
        if (!map.hasLayer(target)) map.addLayer(target);
        console.info("[CustomTiles] Restored layer:", saved);
      });
    }
    _readPageCookie(name) {
      const m = document.cookie.match(
        new RegExp(
          "(?:^|;\\s*)" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "=([^;]*)"
        )
      );
      return m ? decodeURIComponent(m[1]) : null;
    }
    // -- Street View popup injection --------------------------------
    _hookSitePopup(map) {
      map.on("popupopen", (e) => {
        const el = e.popup.getElement ? e.popup.getElement() : e.popup._container;
        if (!el) return;
        const pod = el.querySelector(".popup-on-location");
        if (!pod) return;
        const titleEl = pod.querySelector("#waypoint-popup-title");
        if (!titleEl) return;
        const txt = (titleEl.textContent || "").trim();
        const cm = txt.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
        if (!cm) return;
        const lat = parseFloat(cm[1]);
        const lng = parseFloat(cm[2]);
        if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return;
        const popupGen = String((Number(pod.dataset.dwPopupGen) || 0) + 1);
        pod.dataset.dwPopupGen = popupGen;
        pod.dataset.dwLat = lat.toFixed(6);
        pod.dataset.dwLng = lng.toFixed(6);
        pod.querySelectorAll(".dw-popup-ident").forEach((n) => n.remove());
        this._injectIdentifyIntoPopup(map, lat, lng, pod, popupGen);
        titleEl.classList.add("dw-popup-coords");
        titleEl.title = "Click to copy coordinates";
        if (!titleEl.dataset.dwCopyHooked) {
          titleEl.dataset.dwCopyHooked = "1";
          titleEl.addEventListener("click", () => {
            const curLat = Number(pod.dataset.dwLat);
            const curLng = Number(pod.dataset.dwLng);
            if (!isFinite(curLat) || !isFinite(curLng)) return;
            const text = `${curLat.toFixed(6)},${curLng.toFixed(6)}`;
            navigator.clipboard.writeText(text).then(() => {
              titleEl.classList.add("dw-popup-coords--copied");
              setTimeout(() => titleEl.classList.remove("dw-popup-coords--copied"), 1400);
            }).catch(() => {
            });
          });
        }
        if (pod.querySelector(".dw-sv-btn")) return;
        const btn = document.createElement("button");
        btn.className = "dw-sv-btn";
        btn.type = "button";
        btn.setAttribute("aria-label", "Open current coordinates in Google Maps");
        btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2C8.1 2 5 5.1 5 9c0 5.2 7 13 7 13s7-7.8 7-13c0-3.9-3.1-7-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/></svg><span>Google Maps</span>';
        btn.addEventListener("click", () => {
          const curLat = Number(pod.dataset.dwLat);
          const curLng = Number(pod.dataset.dwLng);
          if (!isFinite(curLat) || !isFinite(curLng)) return;
          const url = "https://www.google.com/maps?q=" + curLat.toFixed(6) + "," + curLng.toFixed(6);
          window.open(url, "_blank", "noopener,noreferrer");
        });
        pod.appendChild(btn);
      });
    }
    // Touch devices have no hover, so the Cadastre / QPWS identify
    // tooltips (and the cadastre Sales link → price window) were
    // unreachable on mobile: tapping the map opens the site's
    // add-point popup instead. So on touch-primary devices we make
    // that popup the info surface — when those layers are active, run
    // the same /identify the desktop hover uses for the tapped point
    // and append the result (including the Sales ↗ link, which the
    // document-level delegated handler already services wherever it
    // appears in the DOM).
    _injectIdentifyIntoPopup(map, lat, lng, pod, popupGen) {
      const latlng = L.latLng(lat, lng);
      const noHover = L.Browser.mobile || window.matchMedia && window.matchMedia("(hover: none)").matches;
      const isCurrent = () => pod.isConnected && pod.dataset.dwPopupGen === String(popupGen);
      const section = (cls, html) => {
        if (!isCurrent()) return null;
        const div = document.createElement("div");
        div.className = "dw-popup-ident " + cls;
        div.innerHTML = html;
        pod.appendChild(div);
        return div;
      };
      const setSection = (div, html) => {
        if (div && div.isConnected && isCurrent()) div.innerHTML = html;
      };
      const cad = this.layers[CFG.LAYER_CADASTRE];
      if (cad && map.hasLayer(cad) && map.getZoom() >= CFG.QLD_CADASTRE_HOVER_MIN_ZOOM) {
        _ensureSalesHook(map);
        arcgisIdentify(map, latlng, {
          baseUrl: CFG.QLD_CADASTRE_SERVICE,
          layers: "all:" + CFG.QLD_CADASTRE_IDENTIFY_LAYER,
          tolerance: 3
        }, (err, feat) => {
          if (!isCurrent()) return;
          if (err || !feat) return;
          const attrs = feat.attributes || {};
          const lotplan = _cadVal(attrs["Lot/plan"]);
          const cadSec = section(
            "dw-popup-ident-cad",
            _formatCadastreTooltip(attrs, null, true)
          );
          if (!lotplan) return;
          fetchCadastreAddress(lotplan, (info) => {
            if (!isCurrent()) return;
            setSection(cadSec, _formatCadastreTooltip(attrs, info, true));
            if (info && isFinite(info.lat) && isFinite(info.lon) && info.streetName && info.streetNumber) {
              const salesSec = section(
                "dw-popup-ident-sales",
                `<div class="dw-sales-pop"><div class="dw-sales-loading">Loading sales…</div></div>`
              );
              fetchOthSales(info, (result) => {
                if (!isCurrent()) return;
                setSection(salesSec, _renderSalesContent(result));
              });
            }
          });
        });
      }
      const scc = this.layers[CFG.LAYER_SCC_APPS];
      if (scc && map.hasLayer(scc) && map.getZoom() >= 12) {
        fetchSccPropertyHistory(lat, lng, (res) => {
          if (!isCurrent() || !res) return;
          const html = _renderSccPropertyHistory(res);
          if (html) section("dw-popup-ident-scc", html);
        });
      }
      const qpws = this.layers[CFG.LAYER_QPWS];
      if (noHover && qpws && map.hasLayer(qpws) && map.getZoom() >= CFG.QLD_QPWS_HOVER_MIN_ZOOM) {
        arcgisIdentify(map, latlng, {
          baseUrl: CFG.QLD_QPWS_SERVICE,
          layers: "all:10",
          tolerance: 5
        }, (err, feat) => {
          if (!isCurrent()) return;
          if (err || !feat) return;
          const a = feat.attributes || {};
          const name = a.NAME || a.name || a.PARK_NAME || a.park_name || "";
          const type = a.FEAT_TYPE || a.feat_type || a.MANAGE_TYPE || a.manage_type || "";
          if (!name && !type) return;
          section(
            "dw-popup-ident-qpws",
            (name ? `<b>${_escHtml(name)}</b>` : "") + (name && type ? "<br>" : "") + (type ? _escHtml(type) : "")
          );
        });
      }
    }
    _injectGroupHeaders(ctrl) {
      let savedGroups = [];
      try {
        savedGroups = JSON.parse(GM_getValue("dw_collapsed_groups", "[]")) || [];
      } catch (_) {
        savedGroups = [];
      }
      const collapsedGroups = new Set(
        Array.isArray(savedGroups) ? savedGroups : []
      );
      const injectSection = (sectionEl, groups) => {
        if (!sectionEl) return;
        const labelMap = /* @__PURE__ */ new Map();
        for (const lbl of sectionEl.querySelectorAll(":scope > label")) {
          const span = lbl.querySelector("span");
          if (!span) continue;
          const name = span.textContent.trim();
          lbl.dataset.dwName = name;
          labelMap.set(name, lbl);
        }
        for (const group of groups) {
          const labels = group.names.map((n) => labelMap.get(n)).filter(Boolean);
          if (!labels.length) continue;
          const grpDiv = document.createElement("div");
          grpDiv.className = "dw-layer-group";
          if (collapsedGroups.has(group.header))
            grpDiv.classList.add("dw-layer-group--closed");
          const hdr = document.createElement("div");
          hdr.className = "dw-layer-group-header";
          hdr.textContent = group.header;
          hdr.setAttribute("role", "button");
          hdr.setAttribute("tabindex", "0");
          hdr.setAttribute(
            "aria-expanded",
            String(!collapsedGroups.has(group.header))
          );
          const toggleGroup = () => {
            const nowClosed = grpDiv.classList.toggle("dw-layer-group--closed");
            hdr.setAttribute("aria-expanded", String(!nowClosed));
            if (nowClosed) collapsedGroups.add(group.header);
            else collapsedGroups.delete(group.header);
            try {
              GM_setValue(
                "dw_collapsed_groups",
                JSON.stringify([...collapsedGroups])
              );
            } catch (_) {
            }
          };
          hdr.addEventListener("click", toggleGroup);
          hdr.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
              e.preventDefault();
              toggleGroup();
            }
          });
          grpDiv.appendChild(hdr);
          const content = document.createElement("div");
          content.className = "dw-layer-group-content";
          grpDiv.appendChild(content);
          sectionEl.insertBefore(grpDiv, labels[0]);
          for (const lbl of labels) {
            content.appendChild(lbl);
            if (group.shortLabels) {
              const short = group.shortLabels[lbl.dataset.dwName];
              if (short) {
                const span = lbl.querySelector("span span");
                if (span) span.textContent = " " + short;
              }
            }
          }
        }
      };
      const doInject = () => {
        const container = ctrl.getContainer();
        if (!container) return;
        injectSection(
          container.querySelector(".leaflet-control-layers-base"),
          DW_LAYER_GROUPS
        );
        injectSection(
          container.querySelector(".leaflet-control-layers-overlays"),
          DW_OVERLAY_GROUPS
        );
      };
      const origUpdate = ctrl._update.bind(ctrl);
      ctrl._update = function() {
        origUpdate();
        doInject();
      };
      doInject();
    }
    // Horizontal scrubber bar for historical-layer time travel.
    // Renders an absolute-positioned bar at the top-centre of the map with
    // prev/next arrows, a range slider for rapid scrubbing, and a date
    // label. Slider drags are debounced so tile servers aren't hammered.
    //
    // adapter shape: { layer, event, getCount(), getIdx(), setIdx(i), getLabel(i) }
    // idx convention: 0 = newest, count-1 = oldest. Slider visually
    // reverses that (left = old, right = new).
    _makeHistoryBar(adapter) {
      const bar = document.createElement("div");
      bar.className = "dw-history-bar";
      const prev = document.createElement("a");
      prev.className = "dw-vxh-btn";
      prev.href = "#";
      prev.title = "Older";
      prev.innerHTML = "&#9664;";
      bar.appendChild(prev);
      const slider = document.createElement("input");
      slider.type = "range";
      slider.className = "dw-history-slider";
      slider.min = "0";
      slider.max = "0";
      slider.value = "0";
      bar.appendChild(slider);
      const next = document.createElement("a");
      next.className = "dw-vxh-btn";
      next.href = "#";
      next.title = "Newer";
      next.innerHTML = "&#9654;";
      bar.appendChild(next);
      const label = document.createElement("span");
      label.className = "dw-history-bar-label";
      bar.appendChild(label);
      L.DomEvent.disableClickPropagation(bar);
      L.DomEvent.disableScrollPropagation(bar);
      const formatLabel = (lab, idx, count) => {
        if (!count) {
          const state = adapter.getState ? adapter.getState() : "loading";
          return state === "loading" ? "Loading…" : "No imagery here";
        }
        const s = lab ? String(lab) : "?";
        const trimmed = s.length > 10 && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s;
        return count > 1 ? `${trimmed}  ${idx + 1}/${count}` : trimmed;
      };
      const update = () => {
        const count = adapter.getCount();
        const idx = adapter.getIdx();
        slider.max = String(Math.max(0, count - 1));
        slider.value = String(Math.max(0, count - 1 - idx));
        slider.disabled = count <= 1;
        label.textContent = formatLabel(adapter.getLabel(idx), idx, count);
        prev.classList.toggle("dw-vxh-disabled", idx >= count - 1);
        next.classList.toggle("dw-vxh-disabled", idx <= 0);
      };
      let debounce = null;
      const applyIdx = (i, immediate) => {
        if (debounce) {
          clearTimeout(debounce);
          debounce = null;
        }
        if (immediate) {
          adapter.setIdx(i);
        } else {
          debounce = setTimeout(() => {
            debounce = null;
            adapter.setIdx(i);
          }, 200);
        }
      };
      L.DomEvent.on(prev, "click", (e) => {
        L.DomEvent.preventDefault(e);
        applyIdx(adapter.getIdx() + 1, true);
      });
      L.DomEvent.on(next, "click", (e) => {
        L.DomEvent.preventDefault(e);
        applyIdx(adapter.getIdx() - 1, true);
      });
      slider.addEventListener("input", () => {
        const count = adapter.getCount();
        const newIdx = Math.max(0, count - 1 - parseInt(slider.value, 10));
        label.textContent = formatLabel(
          adapter.getLabel(newIdx),
          newIdx,
          count
        );
        applyIdx(newIdx, false);
      });
      slider.addEventListener("change", () => {
        const count = adapter.getCount();
        const newIdx = Math.max(0, count - 1 - parseInt(slider.value, 10));
        applyIdx(newIdx, true);
      });
      let attachedMap = null;
      const onChange = () => update();
      return {
        get _map() {
          return attachedMap;
        },
        addTo(map) {
          if (attachedMap === map) return;
          attachedMap = map;
          map.getContainer().appendChild(bar);
          adapter.layer.on(adapter.event, onChange);
          update();
        },
        remove() {
          if (!attachedMap) return;
          adapter.layer.off(adapter.event, onChange);
          if (bar.parentNode) bar.parentNode.removeChild(bar);
          attachedMap = null;
        }
      };
    }
    // -- Styles -------------------------------------------------------
    _injectStyles() {
      if (document.getElementById("dw-custom-tiles-styles")) return;
      const css = [
        ".dw-manage-btn { padding: 4px 8px 2px; border-top: 1px solid #ddd; margin-top: 3px; }",
        ".dw-manage-link { font-size: 11px; color: #888; text-decoration: none; white-space: nowrap; cursor: pointer; }",
        ".dw-manage-link:hover { color: #333; text-decoration: underline; }",
        ".dw-manager-panel { padding-bottom: 2px; }",
        ".dw-manager-hint { font-size: 10px; color: #999; padding: 0 8px 5px; margin: 0; line-height: 1.35; }",
        ".dw-manager-list { padding: 0 2px; }",
        ".dw-manager-row { display: flex; align-items: center; gap: 5px; padding: 3px 6px; cursor: pointer; white-space: nowrap; font-size: 12px; border-radius: 3px; margin: 1px 0; user-select: none; }",
        ".dw-manager-row:not(.dw-manager-row--active):hover { background: rgba(0,0,0,0.06); }",
        ".dw-manager-row--active { opacity: 0.5; cursor: default; }",
        ".dw-manager-row input[type=checkbox] { margin: 0; flex-shrink: 0; }",
        ".dw-manager-name { flex: 1; }",
        ".dw-badge { font-size: 9px; background: #e0e0e0; color: #555; padding: 1px 4px; border-radius: 2px; flex-shrink: 0; font-weight: normal; }",
        ".dw-manager-footer { padding: 5px 8px 1px; border-top: 1px solid #ddd; margin-top: 4px; }",
        ".dw-back-link { font-size: 11px; color: #888; text-decoration: none; cursor: pointer; }",
        ".dw-back-link:hover { color: #333; text-decoration: underline; }",
        // z-index 1160 sits just above the Vexcel full-map oblique
        // overlay (1150) so the date bar stays usable while an oblique
        // fills the map — and below the compass (1200). Harmless for
        // the other time-series bars (nothing else lives at 1000-1160).
        ".dw-history-bar { position: absolute; top: 10px; left: 50%; transform: translateX(-50%); z-index: 1160; display: flex; align-items: center; gap: 8px; padding: 5px 10px; background: rgba(255,255,255,0.95); border-radius: 6px; box-shadow: 0 1px 6px rgba(0,0,0,0.35); font-size: 11px; font-family: sans-serif; white-space: nowrap; pointer-events: auto; width: min(82vw, 720px); box-sizing: border-box; }",
        ".dw-history-slider { flex: 1; min-width: 0; margin: 0; accent-color: #4a8; cursor: pointer; }",
        ".dw-history-slider:disabled { cursor: not-allowed; opacity: 0.4; }",
        ".dw-history-bar-label { min-width: 130px; text-align: right; color: #333; font-variant-numeric: tabular-nums; }",
        ".dw-vxh-btn { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; background: #fff; border: 1px solid #bbb; border-radius: 3px; font-size: 11px; color: #444; text-decoration: none; cursor: pointer; flex-shrink: 0; }",
        ".dw-vxh-btn:hover:not(.dw-vxh-disabled) { background: #e8f0fb; color: #000; border-color: #888; }",
        ".dw-vxh-disabled { opacity: 0.3; cursor: default; pointer-events: none; }",
        ".dw-layer-group { margin: 1px 0; }",
        ".dw-layer-group-header { font-size: 10px; font-weight: 700; color: #aaa; text-transform: uppercase; letter-spacing: 0.05em; padding: 5px 8px 1px; cursor: pointer; user-select: none; }",
        ".dw-layer-group:not(.dw-layer-group--closed) > .dw-layer-group-header::before { content: '▾  '; }",
        ".dw-layer-group--closed > .dw-layer-group-header::before { content: '▸  '; }",
        ".dw-layer-group--closed > .dw-layer-group-content { display: none; }",
        ".dw-manager-group-hd { font-size: 10px; font-weight: 700; color: #aaa; text-transform: uppercase; letter-spacing: 0.05em; padding: 5px 6px 1px; margin-top: 3px; border-top: 1px solid #f0f0f0; }",
        ".dw-manager-group { padding-left: 6px; border-left: 2px solid #eee; margin: 0 0 2px 8px; }",
        ".dw-popup-coords { font-family: ui-monospace, Menlo, monospace; font-size: 11.5px; color: #6b7280; margin: 0 0 10px; letter-spacing: 0.04em; cursor: pointer; transition: color 0.12s; }",
        ".dw-popup-coords:hover { color: #374151; }",
        ".dw-popup-coords--copied { color: #16a34a !important; }",
        ".dw-qpws-tip { font-size: 11px; line-height: 1.35; padding: 4px 7px; background: rgba(255,255,255,0.97); border-color: #888; }",
        ".dw-qpws-tip b { font-weight: 700; }",
        ".dw-infra-tip { font-size: 11px; line-height: 1.4; }",
        // Match the site's native popup buttons (full popup width,
        // rounded, light border, generous padding) with a blue accent
        // so Street View reads as the external/exit action.
        ".popup-on-location .dw-sv-btn { display: flex; align-items: center; justify-content: center; gap: 8px; width: 100%; margin: 6px 0 0; padding: 12px 16px; font-size: 14px; font-family: inherit; font-weight: 500; line-height: 1.2; background: #eff6ff; color: #1d4ed8; border: 1px solid #bfdbfe; border-radius: 10px; cursor: pointer; box-sizing: border-box; }",
        ".popup-on-location .dw-sv-btn:hover { background: #dbeafe; border-color: #93c5fd; }",
        ".popup-on-location .dw-sv-btn svg { flex-shrink: 0; }",
        // Layer-identify sections injected into the site's add-point
        // popup on touch devices (Cadastre parcel + Sales link, QPWS
        // protected area) — mobile's replacement for hover tooltips.
        ".dw-geo-pmo { color: #b8860b; font-weight: 600; font-size: 10px; white-space: nowrap; }",
        ".popup-on-location .dw-popup-ident { border-top: 1px solid #e5e7eb; margin-top: 8px; padding-top: 8px; font-size: 12.5px; line-height: 1.5; text-align: left; }",
        ".popup-on-location .dw-popup-ident b { font-weight: 700; }",
        ".popup-on-location .dw-popup-ident .dw-cad-sub { color: #6b7280; font-size: 11px; }",
        ".popup-on-location .dw-popup-ident .dw-cad-link { font-weight: 600; }",
        // 3D toggle in the planner action row. Matches the native
        // btn-default look; `.active` darkens it the same way
        // Bootstrap 3 does for pressed buttons.
        ".dw-3d-btn { padding: 5px 8px; }",
        ".dw-3d-btn.active { background: #e0e0e0; border-color: #999; box-shadow: inset 0 3px 5px rgba(0,0,0,.125); }",
        ".dw-flight-icon { background: none !important; border: none !important; }",
        ".dw-flight-tip { font-size: 11px; line-height: 1.4; }",
        // Geocache icon — overflow:visible so the favourites-points
        // badge can sit above the pin's top-right corner without
        // being clipped by Leaflet's marker container.
        ".dw-geo-icon { background: none !important; border: none !important; overflow: visible !important; }",
        // Touch tap-popup with cache stats + a button to the listing
        // (so a tap previews the cache instead of jumping to the link).
        ".dw-geo-pop { font-size: 12.5px; line-height: 1.5; color: #1f2937; min-width: 180px; }",
        ".dw-geo-pop-hd { font-weight: 400; margin-bottom: 2px; }",
        ".dw-geo-pop-hd b { font-weight: 700; }",
        ".dw-geo-pop-sub { color: #6b7280; font-size: 11.5px; }",
        ".dw-geo-pop-owner { color: #6b7280; font-size: 11.5px; margin-top: 2px; }",
        ".dw-geo-pop-note { color: #b8860b; font-size: 11px; margin-top: 4px; }",
        ".dw-geo-pop-open { display: block; width: 100%; margin-top: 8px; padding: 8px 10px; font-size: 13px; font-weight: 500; background: #eff6ff; color: #1d4ed8; border: 1px solid #bfdbfe; border-radius: 8px; cursor: pointer; }",
        ".dw-geo-pop-open:hover { background: #dbeafe; border-color: #93c5fd; }",
        ".dw-marine-icon { background: none !important; border: none !important; }",
        ".dw-marine-cluster { background: none !important; border: none !important; overflow: visible !important; cursor: pointer; }",
        ".dw-marine-tip { font-size: 11px; line-height: 1.4; }",
        // SCC applications (Development.i) — hover tooltip + click
        // popup with the full record and a Development.i deep link.
        // width:max-content beats the site's shrink-to-fit tooltip
        // sizing (which otherwise wraps into a skinny column), while
        // max-width keeps long descriptions from sprawling.
        ".dw-scc-tip { width: max-content; max-width: 280px; white-space: normal; font-size: 11.5px; line-height: 1.45; padding: 8px 10px; background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.22); color: #1f2937; }",
        ".dw-scc-tip b { font-weight: 700; }",
        ".dw-scc-tip-hd { display: flex; align-items: center; gap: 6px; }",
        ".dw-scc-tip-cat { color: #374151; }",
        ".dw-scc-chip { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 10px; font-weight: 600; white-space: nowrap; }",
        ".dw-scc-chip--live { background: #ecfdf5; color: #047857; }",
        ".dw-scc-chip--past { background: #f3f4f6; color: #6b7280; }",
        ".dw-scc-chip--notif { background: #fef2f2; color: #dc2626; }",
        ".dw-scc-chip--rel { background: #eff6ff; color: #1d4ed8; margin-left: 4px; font-size: 9px; padding: 0 5px; vertical-align: 1px; }",
        ".dw-scc-dec--ok { color: #047857 !important; }",
        ".dw-scc-dec--bad { color: #dc2626 !important; }",
        ".dw-scc-sub { color: #6b7280; font-size: 10.5px; }",
        ".dw-scc-pop { font-size: 12.5px; line-height: 1.5; color: #1f2937; min-width: 200px; }",
        ".dw-scc-pop-hd { margin-bottom: 2px; }",
        ".dw-scc-pop-hd b { font-weight: 700; }",
        ".dw-scc-pop-desc { margin: 4px 0; }",
        ".dw-scc-pop .dw-scc-sub { display: block; margin-top: 2px; }",
        ".dw-scc-link { display: inline-block; margin-top: 6px; font-weight: 600; }",
        ".dw-scc-links { display: flex; flex-wrap: wrap; gap: 0 14px; }",
        ".dw-scc-link--notif { color: #dc2626 !important; }",
        // Floating sublayer picker shown while the overlay is active
        // (dev/building/plumbing × current/decided checkboxes).
        ".dw-scc-panel { position: absolute; right: 10px; bottom: 30px; z-index: 1000; background: rgba(255,255,255,0.96); border-radius: 6px; box-shadow: 0 1px 6px rgba(0,0,0,0.35); padding: 7px 10px; font-size: 11px; font-family: sans-serif; line-height: 1.6; user-select: none; }",
        ".dw-scc-panel-hd { font-weight: 700; font-size: 10px; color: #888; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 3px; }",
        ".dw-scc-row { display: flex; align-items: center; gap: 8px; white-space: nowrap; }",
        ".dw-scc-dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }",
        ".dw-scc-row-label { color: #888; }",
        ".dw-scc-row label { display: flex; align-items: center; gap: 5px; cursor: pointer; margin: 0; font-weight: normal; }",
        ".dw-scc-row input { margin: 0; }",
        ".dw-scc-status { border-top: 1px solid #eee; margin-top: 4px; padding-top: 4px; }",
        ".dw-scc-notif-badge { color: #dc2626; font-weight: 700; font-size: 10.5px; }",
        // Vexcel imagery compass — docked top-right when the Vexcel
        // base is active (counterpart to the QLD Historical compass):
        // a compass rose (N/E/S/W + ⊙ nadir) and a capture-date
        // slider. The image panel is hidden until a direction is
        // clicked (passive compass; fetches only on demand). Styled to
        // match the other custom panes: white translucent chrome,
        // #bbb borders, #444 text, blue-tint hover (like the history
        // bar / layer manager), not a dark theme.
        // Docked lower-right, clear of the site's top-right close/exit
        // button (the compass used to cover it on the basemap).
        ".dw-vex-ctl { position: absolute; top: 84px; right: 12px; z-index: 1200; background: rgba(255,255,255,0.95); border-radius: 6px; box-shadow: 0 1px 6px rgba(0,0,0,0.35); color: #333; font-family: sans-serif; padding: 8px; width: max-content; }",
        ".dw-vex-rose { display: grid; grid-template-columns: repeat(3, 30px); grid-template-rows: repeat(3, 30px); gap: 3px; margin: 0 auto; }",
        ".dw-vex-rose .dw-vex-n { grid-column: 2; grid-row: 1; }",
        ".dw-vex-rose .dw-vex-w { grid-column: 1; grid-row: 2; }",
        ".dw-vex-rose .dw-vex-c { grid-column: 2; grid-row: 2; }",
        ".dw-vex-rose .dw-vex-e { grid-column: 3; grid-row: 2; }",
        ".dw-vex-rose .dw-vex-s { grid-column: 2; grid-row: 3; }",
        ".dw-vex-dir { width: 30px; height: 30px; padding: 0; font-size: 13px; font-weight: 700; background: #fff; color: #444; border: 1px solid #bbb; border-radius: 3px; cursor: pointer; }",
        ".dw-vex-dir:hover { background: #e8f0fb; color: #000; border-color: #888; }",
        ".dw-vex-dir--on { background: #2563eb; color: #fff; border-color: #2563eb; }",
        // Greyed = no photo for this direction on the selected date
        // (e.g. ⊙ nadir was only flown some years). Non-clickable.
        ".dw-vex-dir--off { opacity: 0.35; cursor: default; background: #f3f4f6; }",
        ".dw-vex-dir--off:hover { background: #f3f4f6; color: #444; border-color: transparent; }",
        // Near-infrared band toggle (vegetation → red). Sits under the
        // compass rose; greyed where no IR band exists (SCC: nadir 2025).
        ".dw-vex-ir { display: block; width: 96px; margin: 6px auto 0; padding: 4px 0; font-size: 11px; font-weight: 700; letter-spacing: 0.04em; background: #fff; color: #444; border: 1px solid #bbb; border-radius: 3px; cursor: pointer; }",
        ".dw-vex-ir:hover:not(.dw-vex-dir--off) { background: #fdecec; color: #b91c1c; border-color: #dca; }",
        ".dw-vex-ir--on { background: #dc2626; color: #fff; border-color: #dc2626; }",
        ".dw-vex-ir--on:hover { background: #dc2626 !important; color: #fff !important; }",
        ".dw-vex-basemsg { max-width: 150px; margin: 6px auto 0; padding: 5px 7px; font-size: 10.5px; line-height: 1.35; color: #7a2e2e; background: #fdecec; border: 1px solid #f0c0c0; border-radius: 3px; text-align: center; }",
        // Full-map overlay: the chosen oblique REPLACES the map view
        // (fills the whole map area), with the compass floating above
        // it (dw-vex-ctl has the higher z-index). Dates ride the shared
        // history bar. The image pans (drag) + zooms (wheel) since the
        // full frame is large and can't be cropped server-side.
        ".dw-vex-overlay { position: absolute; inset: 0; z-index: 1150; background: #0b0b0d; }",
        // The oblique is a Leaflet image-pyramid (CRS.Simple) that
        // tiles /v2/oriented/tile — pans/zooms with chunked loading.
        ".dw-vex-tilemap { position: absolute; inset: 0; background: #0b0b0d; }",
        ".dw-vex-tilemap .leaflet-control-zoom { margin: 12px; }",
        ".dw-vex-close { position: absolute; top: 12px; left: 12px; z-index: 1000; background: rgba(255,255,255,0.95); border: 1px solid #bbb; color: #333; font-size: 12px; font-weight: 600; font-family: sans-serif; line-height: 1; padding: 7px 11px; border-radius: 5px; box-shadow: 0 1px 6px rgba(0,0,0,0.35); cursor: pointer; }",
        ".dw-vex-close:hover { background: #fff; color: #000; }",
        ".dw-vex-hint { position: absolute; bottom: 12px; left: 50%; transform: translateX(-50%); z-index: 1000; background: rgba(0,0,0,0.55); color: #e5e7eb; font-size: 11px; font-family: sans-serif; padding: 4px 10px; border-radius: 999px; pointer-events: none; }",
        ".dw-vex-msg { position: absolute; inset: 0; z-index: 999; display: flex; align-items: center; justify-content: center; padding: 20px 16px; font-size: 13px; color: #d1d5db; text-align: center; }",
        ".dw-scc-notif-badge { color: #dc2626; font-weight: 600; }",
        ".dw-scc-hint { color: #999; font-size: 10px; margin-top: 3px; }",
        // Deep-detail section inside the application popup (assessment
        // stages + associated parcels, auto-loaded from Development.i).
        ".dw-scc-detail { border-top: 1px solid #e5e7eb; margin-top: 6px; padding-top: 6px; }",
        ".dw-scc-det-sec { margin-bottom: 5px; }",
        ".dw-scc-det-sec b { font-weight: 700; font-size: 11px; }",
        ".dw-scc-stages { max-height: 240px; overflow-y: auto; margin-top: 3px; padding-right: 4px; }",
        // The site's location popup has more vertical room than a
        // Leaflet marker popup — let the full parcel history breathe.
        ".popup-on-location .dw-scc-stages { max-height: 320px; }",
        // flex-wrap + a min share for the description keep these rows
        // readable in ANY container: a long meta ("In Progress ·
        // lodged 26 Jun 2019") wraps under the description instead of
        // crushing it into a one-word-per-line column (as happened in
        // the site's location popup) or overflowing the popup edge.
        ".dw-scc-stage { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 0 10px; font-size: 11px; line-height: 1.45; padding: 2px 0; border-bottom: 1px dotted #eee; }",
        ".dw-scc-stage-desc { flex: 1 1 62%; min-width: 0; overflow-wrap: break-word; color: #374151; }",
        ".dw-scc-stage-val { flex: 0 1 auto; margin-left: auto; max-width: 100%; color: #6b7280; text-align: right; }",
        ".dw-cad-tip { font-size: 11px; line-height: 1.35; padding: 4px 7px; background: rgba(255,255,255,0.97); border-color: #888; }",
        ".dw-cad-tip b { font-weight: 700; }",
        ".dw-cad-tip .dw-cad-sub { color: #6b7280; }",
        // Re-enable pointer events just on the SmartMap anchor (the
        // surrounding tooltip is non-interactive so the cursor still
        // passes hover events through to the map).
        ".dw-cad-tip .dw-cad-link { display: inline-block; margin-top: 3px; color: #1d4ed8; text-decoration: none; pointer-events: auto; }",
        ".dw-cad-tip .dw-cad-link:hover { text-decoration: underline; }",
        // INTVL territory tooltip — same minimalist style as cadastre.
        ".dw-intvl-tip { font-size: 11px; line-height: 1.4; padding: 4px 7px; background: rgba(255,255,255,0.97); border-color: #888; }",
        ".dw-intvl-tip b { font-weight: 700; }",
        // Sales popup — opened by clicking the "Sales ↗" link in the
        // cadastre tooltip. Uses Leaflet's popup primitive so it
        // inherits autopan + map-anchored behaviour for free.
        ".dw-sales-pop { font-size: 12px; line-height: 1.45; color: #1f2937; min-width: 250px; }",
        ".dw-sales-pop .dw-sales-hd { font-weight: 700; font-size: 12.5px; margin-bottom: 4px; color: #111827; }",
        ".dw-sales-pop .dw-sales-stats { color: #374151; margin-bottom: 6px; }",
        ".dw-sales-pop .dw-sales-sub { color: #6b7280; }",
        ".dw-sales-pop .dw-sales-row { margin: 4px 0; display: flex; gap: 8px; align-items: baseline; }",
        ".dw-sales-pop .dw-sales-k { flex: 0 0 64px; color: #6b7280; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.04em; }",
        ".dw-sales-pop .dw-sales-v { flex: 1; }",
        ".dw-sales-pop .dw-sales-events { margin: 0; padding: 0 0 0 4px; list-style: none; }",
        ".dw-sales-pop .dw-sales-events li { margin: 2px 0; }",
        ".dw-sales-pop .dw-sales-err { color: #b91c1c; padding: 4px 0; }",
        ".dw-sales-pop .dw-sales-loading { color: #6b7280; padding: 6px 0; font-style: italic; }",
        ".dw-sales-pop .dw-sales-source { display: inline-block; margin-top: 8px; color: #1d4ed8; text-decoration: none; }",
        ".dw-sales-pop .dw-sales-source:hover { text-decoration: underline; }"
      ].join("\n");
      const style = document.createElement("style");
      style.id = "dw-custom-tiles-styles";
      style.textContent = css;
      function attachStyle() {
        const styleHost = document.head || document.documentElement;
        if (!styleHost) {
          const docObs = new MutationObserver(() => {
            if (document.documentElement) {
              docObs.disconnect();
              attachStyle();
            }
          });
          docObs.observe(document, { childList: true });
          return;
        }
        styleHost.appendChild(style);
        if (styleHost !== document.head) {
          const headObs = new MutationObserver(() => {
            if (document.head && style.parentNode !== document.head) {
              document.head.appendChild(style);
              headObs.disconnect();
            }
          });
          headObs.observe(document.documentElement, { childList: true });
        }
      }
      attachStyle();
    }
  };

  // src/app.js
  function bootUserscript() {
    if (isWazeTokenFrame()) {
      startWazeTokenBroker();
      return;
    }
    const SCRIPT_VERSION = typeof GM_info !== "undefined" && GM_info.script?.version || "?";
    console.info(
      `%c[CustomTiles] v${SCRIPT_VERSION} loaded`,
      "color:#fff;background:#0277bd;padding:2px 6px;border-radius:3px;"
    );
    if (globalThis.__DW_TEST_EXPORTS__) {
      globalThis.__dw = {
        CFG,
        DW_LAYER_GROUPS,
        DW_OVERLAY_GROUPS,
        tileToBBox4326,
        tileToBBox3857,
        utfGridCellToLatLng,
        _overzoomPlacement,
        mvtDecode,
        parseLayer,
        parseValue,
        parseFeature,
        decodeGeometry,
        zig,
        readVarint,
        skipField,
        utf8,
        hexAlpha,
        pointInRing,
        prepareLayers,
        intvlActivityTime,
        intvlAgo,
        intvlArea,
        _cadVal,
        _escHtml,
        esc,
        _safeColor,
        _fmtPrice,
        _fmtDate,
        _slugify,
        _othStreetTypeSlug,
        _othCanonicalUrlFromLocation,
        _formatCadastreTooltip,
        _formatAddressLine,
        _deviAppUrl,
        _fmtSccDate,
        _formatSccTooltip,
        _formatSccPopup,
        _sccDefaultState,
        _sccLoadState,
        _deviDetailUrl,
        _parseSccDetailHtml,
        _renderSccDetail,
        _deviAppByIdUrl,
        _deviFilterBody,
        _dedupeDeviFeatures,
        _formatNotifTooltip,
        _notifPopupProps,
        _deviKindFromCategory,
        _histFromFilterResults,
        _decisionClass,
        _histRowHtml,
        _renderSccPropertyHistory,
        _deviReportUrl,
        _sccDocsSearchUrl,
        _sccDocDownloadUrl,
        _parseSccDocs,
        _sccFeatureKey,
        _vexcelParseToken,
        _vexcelTokenExp,
        _vexcelTokenValid,
        _vexcelTileTpl,
        _vexcelCollectionYear,
        _vexcelParseObliques,
        _vexcelObliqueExtractUrl,
        _vexcelObliqueTileBase,
        _vexcelMaxDownsample,
        _vexcelBand,
        _vexcelFootprint,
        _vexcelBilinear,
        _vexcelInvBilinear,
        _vexcelIsCredString,
        LayerProvider,
        tileProvider,
        tokenTileProvider,
        arcgisExportProvider,
        pollingDataLayer,
        oimIcon
      };
    }
    if (!globalThis.__DW_DISABLE_BOOT__) new CustomTilesApp().boot();
  }

  // src/main.js
  bootUserscript();
})();
