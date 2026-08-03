/* -- Configuration ----------------------------------------------------- */

export const CFG = {
	LAYER_QLD: "QLD Globe",
	LAYER_GOOGLE: "Google Hybrid",
	LAYER_APPLE: "Apple Maps",
	LAYER_STAMEN_TERRAIN: "Stamen Terrain",
	LAYER_WAYBACK: "Esri Wayback",

	WAYBACK_CONFIG_URL:
		"https://s3-us-west-2.amazonaws.com/config.maptiles.arcgis.com/waybackconfig.json",

	// Apple MapKit raster tile endpoint (ti/tile). The vector endpoint
	// (md/v1/vtile) returns protobuf and won't render in plain Leaflet.
	// style=0 = road map; tint=dark gives the dark colour scheme.
	// accessKey and `v` build number are injected at runtime by
	// AppleTokenManager (acquired via DuckDuckGo's bootstrap flow).
	APPLE_TILE_BASE:
		"https://cdn.apple-mapkit.com/ti/tile?x={x}&y={y}&z={z}" +
		"&style=0&size=1&scale=2&lang=en&poi=1&labels=1&tint=dark&emphasis=standard",
	APPLE_DDG_TOKEN_URL: "https://duckduckgo.com/local.js?get_mk_token=1",
	APPLE_BOOTSTRAP_URL:
		"https://cdn.apple-mapkit.com/ma/bootstrap?apiVersion=2&mkjsVersion=5.79.95&poi=1",
	APPLE_DDG_ORIGIN: "https://duckduckgo.com",
	APPLE_TOKEN_TTL: 30 * 60 * 1000,
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
	// The viewer's proper tile credential is the `session` minted by
	// POST admin.vexcelgroup.com/api/viewer/configuration/init, gated by a
	// hash = sha256(`${APP_NAME}_${timestamp}`) (no secret salt). Accounts
	// that don't issue a session (session:null) fall back to the JWT.
	VEXCEL_SESSION_KEY: "dw_vexcel_session",
	VEXCEL_INIT_URL: "https://admin.vexcelgroup.com/api/viewer/configuration/init",
	VEXCEL_APP_NAME: "viewer",
	// The imagery services (and configuration/init's session mint) gate on
	// an Origin of the ANZ viewer — verified: Origin present → 200 / real
	// session; absent → 401 / session:null. <img> tiles can't send a
	// spoofed Origin, so the basemap GM-fetches + blob-bridges like Stamen.
	VEXCEL_SPOOF_ORIGIN: "https://anz-viewer.vexcelgroup.com",
	// Esri's reference overlays — the label/road tile pair designed to
	// sit on World Imagery. Auto-synced onto the Wayback base the same
	// way QLD Labels/Roads pair with the QLD bases. Keyless XYZ.
	LAYER_ESRI_REF: "Esri Labels & Roads",
	ESRI_PLACES_TILE:
		"https://server.arcgisonline.com/ArcGIS/rest/services/Reference/" +
		"World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
	ESRI_TRANSPORT_TILE:
		"https://server.arcgisonline.com/ArcGIS/rest/services/Reference/" +
		"World_Transportation/MapServer/tile/{z}/{y}/{x}",
	LAYER_STRAVA: "Strava Heatmap",
	LAYER_GARMIN: "Garmin Heatmap",

	QLD_ORIGIN: "https://qldglobe.information.qld.gov.au",
	QLD_TOKEN_EP:
		"https://qldglobe.information.qld.gov.au/api/qldglobe/public/token",
	QLD_SERVICE:
		"https://spatial-img.information.qld.gov.au/arcgis/rest/services/" +
		"Basemaps/LatestStateProgram_QGovSISPUsers/ImageServer",
	QLD_TILE_TPL:
		"https://spatial-img.information.qld.gov.au/arcgis/rest/services/" +
		"Basemaps/LatestStateProgram_QGovSISPUsers/ImageServer/tile/{z}/{y}/{x}",
	QLD_LABELS_TILE:
		"https://spatial-gis.information.qld.gov.au/arcgis/rest/services/" +
		"Basemaps/QldImageryLabel/MapServer/tile/{z}/{y}/{x}",
	QLD_ROADS_EXPORT:
		"https://spatial-gis.information.qld.gov.au/arcgis/rest/services/" +
		"Transportation/RoadsAndTracks/MapServer/export",

	MAPTYPE_COOKIE: "leafletgl_maptype",
	ARCHIVE_KEY: "dw_archived_layers",

	REFRESH_MARGIN: 5 * 60 * 1000,
	DEFAULT_TTL: 60 * 60 * 1000,
	RETRY_DELAY: 2 * 60 * 1000,
	RETRY_MAX_DELAY: 30 * 60 * 1000,

	LAYER_HIST: "QLD Historical",
	QLD_HIST_SERVICE:
		"https://spatial-img.information.qld.gov.au/arcgis/rest/services/" +
		"TimeSeries/AerialOrtho_AllUsers/ImageServer",
	QLD_HIST_PHOTOS_SERVICE:
		"https://spatial-img.information.qld.gov.au/arcgis/rest/services/" +
		"QImagery/HistoricalAerialPhoto_AllUsers/ImageServer",

	LAYER_WATER: "Water Infrastructure",
	LAYER_FLIGHTS: "Live Flights",
	LAYER_MARINE: "Marine Vessels",
	LAYER_WAZE: "Waze Traffic",
	LAYER_MOBILE: "Mobile Coverage",
	LAYER_SEAMARKS: "OpenSeaMap",
	LAYER_INFRA: "Power Infrastructure",
	LAYER_TELECOM: "Telecoms",
	LAYER_LIGHTPOL: "Light Pollution",
	LAYER_CADASTRE: "Australia Cadastre",
	LAYER_QPWS:    "QPWS Estate",
	LAYER_RELIEF:  "QLD Relief",
	LAYER_NATIONAL_PARKS: "National Parks",
	LAYER_HIST_MINES: "Historic Mines",
	LAYER_TOPO:    "QLD Topo",
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
	GEOCACHING_PUBLIC_INFO:
		"https://tiles{s}.geocaching.com/map.info?x={x}&y={y}&z={z}",
	// The PNG tile is the legacy map's VISUAL render. We don't draw it
	// (custom markers instead), but requesting it triggers the server
	// to generate the tile, which is what populates the map.info
	// UTFGrid. Cold tiles (never recently rendered) return HTTP 204 on
	// map.info until a map.png request warms them. The warming is
	// shared across the tiles01..04 edges and persists server-side, so
	// we only pay it once per tile per cache-eviction cycle. Verified
	// empirically: map.png works with any Referer; map.info needs the
	// geocaching.com Referer; HEAD does NOT warm (must be a full GET).
	GEOCACHING_PUBLIC_PNG:
		"https://tiles{s}.geocaching.com/map.png?x={x}&y={y}&z={z}",
	GEOCACHING_PUBLIC_DETAILS:
		"https://tiles01.geocaching.com/map.details?i=",
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
	INTVL_TILES_BASE:
		"https://d1yalngj9nsyl4.cloudfront.net/single-player/run",
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
	QLD_TOPO_TILE:
		"https://spatial-gis.information.qld.gov.au/arcgis/rest/services/" +
		"Basemaps/QldMap_Topo/MapServer/tile/{z}/{y}/{x}",
	QLD_RELIEF_TILE:
		"https://spatial-gis.information.qld.gov.au/arcgis/rest/services/" +
		"Basemaps/QldMap_Relief/MapServer/tile/{z}/{y}/{x}",

	// Minimum zoom for QPWS hover-identify (below this, polygons too small).
	QLD_QPWS_HOVER_MIN_ZOOM: 11,

	OIM_WATER_TILES: "https://openinframap.org/map/water",

	// QLD Digital Cadastral Database via Planning Cadastre MapServer.
	// Layer 1 is the parent "Land Parcels" group — service handles
	// scale-dependent sub-layer selection (full parcels close-in,
	// generalised >10ha groupings further out).
	QLD_CADASTRE_SERVICE:
		"https://spatial-gis.information.qld.gov.au/arcgis/rest/services/" +
		"PlanningCadastre/LandParcelPropertyFramework/MapServer",
	QLD_CADASTRE_LAYER_ID: 1,
	// Identify against this specific sublayer (Base Parcels Only) — gives
	// real lot/plan/tenure attributes rather than road-segment metadata.
	QLD_CADASTRE_IDENTIFY_LAYER: 8,

	// National fallback overlay (Geoscape-derived, via DCCEEW). Covers
	// every jurisdiction but only renders parcels at ~1:5000 (zoom >=17)
	// and carries no lot/plan or street address — so it's used to fill
	// WA/ACT/NT tiles where the per-state /export services can't. Rich
	// lot/plan+address come from each state's identify service instead
	// (see src/providers/cadastre-au.js). CORS-open; attribute Geoscape.
	NATIONAL_CADASTRE_SERVICE:
		"https://gis.environment.gov.au/gispub/rest/services/" +
		"national_basemap_v2/national_base_map_V2/MapServer",
	NATIONAL_CADASTRE_LAYER: 12,
	// Parcels are meaningless zoomed right out — don't draw/identify above this.
	CADASTRE_MIN_ZOOM: 13,

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
	SCC_APPS_SERVICE:
		"https://geopublic.scc.qld.gov.au/arcgis/rest/services/" +
		"PlanningCadastre/Applications_SCRC/MapServer",
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
	SCC_SUBMISSION_URL:
		"https://haveyoursay.sunshinecoast.qld.gov.au/submissions-and-comments-development-applications",

	// QPWS estate: protected-area polygons + tracks/trails of all kinds.
	// Layer IDs in the source service:
	//   10 = Protected areas and forests   5 = Walking track
	//    6 = Great walk                    7 = Horse trail
	//    8 = Mountain bike trail           9 = Trail bike trail
	// Rendered server-side so we inherit official QPWS symbology.
	QLD_QPWS_SERVICE:
		"https://spatial-gis.information.qld.gov.au/arcgis/rest/services/" +
		"Environment/ParksTerrestrialProtectedAreas/MapServer",
	QLD_QPWS_LAYER_IDS: "10,5,6,7,8,9",

	// GSQ MiningResources (GeoResGlobe). Public, CORS-open, token-free —
	// same host as the cadastre, so already in @connect. Layer 16 =
	// "Historical workings" (~15k named old mine sites), 102 = "Historical
	// coal workings". Point features with commodity/status/size attributes.
	QLD_MINING_SERVICE:
		"https://spatial-gis.information.qld.gov.au/arcgis/rest/services/" +
		"GeoscientificInformation/MiningResources/MapServer",
	QLD_MINING_LAYER_IDS: "16,102",
	QLD_MINING_HOVER_MIN_ZOOM: 10,

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
	GOOGLE_HYBRID_TILE:
		"https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}",
	// Strava's logged-out map currently serves 512px tiles through URL z11.
	STRAVA_HEATMAP_TILE:
		"https://content-a.strava.com/anon/globalheat/all/blue/{z}/{x}/{y}.png?v=19",
	STRAVA_HEATMAP_MAX_NATIVE_Z: 11,
	OPENSEAMAP_TILE:
		"https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png",
	ACCC_MOBILE_COVERAGE_SERVICE:
		"https://spatial.infrastructure.gov.au/server/rest/services/ACCC_Mobile_Sites_and_Coverages/MapServer",

	// lightpollutionmap.info GeoServer (WMS via GWC tile cache).
	// LAYERS=PostGIS:SB_2025 = sky brightness, latest published edition.
	// STYLES=WA = "World Atlas" colour ramp matching the official site.
	LIGHTPOL_WMS_BASE:
		"https://www2.lightpollutionmap.info/geoserver/gwc/service/wms",
	LIGHTPOL_WMS_LAYER: "PostGIS:SB_2025",
	LIGHTPOL_WMS_STYLE: "WA",
};

export const BLANK_TILE =
	"data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

// Base-layer groups for the picker and Manage Layers panel.
// shortLabels strip the state prefix so labels are concise inside their group.
export const DW_LAYER_GROUPS = [
	{
		header: "Global",
		names: [
			CFG.LAYER_GOOGLE,
			CFG.LAYER_APPLE,
			CFG.LAYER_STAMEN_TERRAIN,
			CFG.LAYER_WAYBACK,
			CFG.LAYER_VEXCEL,
		],
	},
	{
		header: "Queensland",
		names: [CFG.LAYER_QLD, CFG.LAYER_HIST, CFG.LAYER_TOPO],
		shortLabels: {
			[CFG.LAYER_QLD]:   "Current Imagery",
			[CFG.LAYER_HIST]:  "Historical",
			[CFG.LAYER_TOPO]:  "Topographic",
		},
	},
];

// Overlay groups, organised by what the user is *trying to see* rather
// than by data provider. Any overlay not listed here falls through to
// an "Other" group at the bottom (currently empty).
export const DW_OVERLAY_GROUPS = [
	{
		header: "Property",
		names:  [CFG.LAYER_CADASTRE, CFG.LAYER_SCC_APPS, CFG.LAYER_QPWS, CFG.LAYER_RELIEF],
	},
	{
		header: "Infrastructure",
		names:  [CFG.LAYER_INFRA, CFG.LAYER_TELECOM, CFG.LAYER_WATER, CFG.LAYER_MOBILE],
	},
	{
		header: "Environment",
		names:  [CFG.LAYER_NATIONAL_PARKS, CFG.LAYER_LIGHTPOL, CFG.LAYER_SEAMARKS],
	},
	{
		header: "Mining",
		names:  [CFG.LAYER_HIST_MINES],
	},
	{
		header: "Live data",
		names:  [CFG.LAYER_FLIGHTS, CFG.LAYER_MARINE, CFG.LAYER_WAZE,
		         CFG.LAYER_INTVL_GLOBAL, CFG.LAYER_GEOCACHING],
	},
	{
		header: "Heatmaps",
		names:  [CFG.LAYER_STRAVA, CFG.LAYER_GARMIN],
	},
];
