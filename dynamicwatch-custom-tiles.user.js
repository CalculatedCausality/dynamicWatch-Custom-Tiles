// ==UserScript==
// @name         dynamicWatch – Map Layers & Overlays
// @namespace    https://dynamic.watch
// @version      7.9.94
// @description  Multi-source basemaps (QLD Globe/Historical/Topo, Google Hybrid, Apple Maps, Stamen Terrain, Esri Wayback) plus overlays: QPWS Estate, QLD Cadastre, Mobile Coverage, Marine Vessels (with grid-clustering), Live Flights, Geocaches, Strava/Garmin heatmaps, Light Pollution, Power Infrastructure, Telecoms, Water Infrastructure, National Parks, OpenSeaMap, QLD Relief, INTVL Global Map. Includes overlay persistence, QPWS hover-identify, cadastre Sales lookup via OnTheHouse, coordinate click-to-copy, and auto-refreshing access tokens for QLD and Apple MapKit.
// @author       Matthew Aucott
// @match        https://dynamic.watch/plan*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @connect      qldglobe.information.qld.gov.au
// @connect      spatial-img.information.qld.gov.au
// @connect      spatial-gis.information.qld.gov.au
// @connect      connecttile.garmin.com
// @connect      cdn.apple-mapkit.com
// @connect      duckduckgo.com
// @connect      tiles.stadiamaps.com
// @connect      s3-us-west-2.amazonaws.com
// @connect      wayback.maptiles.arcgis.com
// @connect      opensky-network.org
// @connect      www.marinetraffic.com
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

(function () {
	"use strict";

	const pageWin = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;

	// Visible version banner — answers "did Tampermonkey actually update?"
	// on every page load without grepping for symptoms.
	const SCRIPT_VERSION =
		(typeof GM_info !== "undefined" && GM_info.script?.version) || "?";
	console.info(
		`%c[CustomTiles] v${SCRIPT_VERSION} loaded`,
		"color:#fff;background:#0277bd;padding:2px 6px;border-radius:3px;",
	);

	/* -- Configuration ----------------------------------------------------- */

	const CFG = {
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
		LAYER_MOBILE: "Mobile Coverage",
		LAYER_SEAMARKS: "OpenSeaMap",
		LAYER_INFRA: "Power Infrastructure",
		LAYER_TELECOM: "Telecoms",
		LAYER_LIGHTPOL: "Light Pollution",
		LAYER_CADASTRE: "QLD Cadastre",
		LAYER_QPWS:    "QPWS Estate",
		LAYER_TOPO:    "QLD Topo",
		LAYER_INTVL_GLOBAL: "INTVL Global Map",
		LAYER_GEOCACHING: "Geocaches",
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
		QLD_CADASTRE_HOVER_MIN_ZOOM: 14,

		// OnTheHouse (Cotality) base URL — used by fetchOthSales for the
		// optional "Sales" lookup on the cadastre tooltip.
		OTH_BASE: "https://www.onthehouse.com.au",

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
		STRAVA_HEATMAP_TILE:
			"https://content-a.strava.com/anon/globalheat/all/blue/{z}/{x}/{y}@2x.png?v=19",
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

	const BLANK_TILE =
		"data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

	// Base-layer groups for the picker and Manage Layers panel.
	// shortLabels strip the state prefix so labels are concise inside their group.
	const DW_LAYER_GROUPS = [
		{
			header: "Global",
			names: [
				CFG.LAYER_GOOGLE,
				CFG.LAYER_APPLE,
				CFG.LAYER_STAMEN_TERRAIN,
				CFG.LAYER_WAYBACK,
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
	const DW_OVERLAY_GROUPS = [
		{
			header: "Property",
			names:  [CFG.LAYER_CADASTRE, CFG.LAYER_QPWS],
		},
		{
			header: "Infrastructure",
			names:  [CFG.LAYER_INFRA, CFG.LAYER_TELECOM, CFG.LAYER_WATER, CFG.LAYER_MOBILE],
		},
		{
			header: "Environment",
			names:  [CFG.LAYER_LIGHTPOL, CFG.LAYER_SEAMARKS],
		},
		{
			header: "Live data",
			names:  [CFG.LAYER_FLIGHTS, CFG.LAYER_MARINE,
			         CFG.LAYER_INTVL_GLOBAL, CFG.LAYER_GEOCACHING],
		},
		{
			header: "Heatmaps",
			names:  [CFG.LAYER_STRAVA, CFG.LAYER_GARMIN],
		},
	];

	/* -- Token Manager Base ----------------------------------------------- */

	// Shared scheduling/retry/queue logic for short-lived access tokens.
	// Subclasses own the actual token data and implement:
	//   isValid()       — return true if cached token is still usable
	//   _cached()       — return array of cached values to pass to callbacks
	//   _fetch(done)    — fetch fresh token + save it, then call
	//                     done(err)  or  done(null, ...resultArgs)
	//                     where ...resultArgs are also passed to onRefresh
	//
	// Subclasses must also assign this.expires (epoch ms) when they save —
	// the base reads it to schedule the next refresh.
	class TokenManagerBase {
		constructor(opts) {
			opts = opts || {};
			this._label = opts.label || "Token";
			this._refreshMargin = opts.refreshMarginMs || CFG.REFRESH_MARGIN;
			this.expires = 0;
			this.fetching = false;
			this.pending = [];
			this.refreshScheduled = false;
			this.retryCount = 0;
			/** Set by CustomTilesApp; called with subclass result args on refresh. */
			this.onRefresh = null;
		}

		// Subclass must override.
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
						CFG.RETRY_MAX_DELAY,
					);
					this.retryCount++;
					setTimeout(() => this.scheduleRefresh(), delay);
				}
			});
		}

		scheduleRefresh() {
			if (this.refreshScheduled) return;
			this.refreshScheduled = true;
			// Clamp to setTimeout's signed int32 ceiling — a freshly-acquired
			// long-lived token can have `expires - Date.now()` > 24.8 days,
			// which V8's setTimeout treats as "fire immediately" and would
			// burn through the retry budget in a tight loop.
			const wait = Math.min(
				2147483647,
				Math.max(30000, this.expires - Date.now() - this._refreshMargin),
			);
			setTimeout(() => {
				this.refreshScheduled = false;
				this._fetch((err, ...result) => {
					if (err) {
						const delay = Math.min(
							CFG.RETRY_DELAY * Math.pow(2, this.retryCount),
							CFG.RETRY_MAX_DELAY,
						);
						this.retryCount++;
						console.warn(
							`[CustomTiles] ${this._label} token refresh failed:`,
							err.message,
							"– retry in",
							Math.round(delay / 60000),
							"min",
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
	}

	/* -- QLD Token Manager ------------------------------------------------- */

	class QldTokenManager extends TokenManagerBase {
		// opts: { serviceUrl, storageKey, label }
		// Each QLD ImageServer (LatestStateProgram, HistoricalAerialPhoto, …)
		// has its own access policy, so the token request must be scoped to
		// the right service URL and tokens must be cached independently.
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

		// Two-step: GET the QLD Globe homepage to harvest a CSRF token, then
		// POST it to the token endpoint scoped to our service URL.
		_fetch(done) {
			gmGet(CFG.QLD_ORIGIN + "/", {
				headers: {
					"Accept": "text/html,*/*;q=0.8",
					"Accept-Language": "en-US,en;q=0.9",
					"Origin": CFG.QLD_ORIGIN,
					"Referer": CFG.QLD_ORIGIN + "/",
				},
			}, (err, r) => {
				if (err) {
					done(new Error(
						`[${this._label}] GET qldglobe.information.qld.gov.au failed`));
					return;
				}
				const csrf =
					QldTokenManager._xsrfFromSetCookie(r.responseHeaders) ||
					QldTokenManager._csrfFromHtml(r.responseText);
				if (!csrf) {
					done(new Error(
						`[${this._label}] CSRF token not found in Set-Cookie or HTML`));
					return;
				}
				this._doPost(csrf, done);
			});
		}

		_doPost(csrf, done) {
			gmJsonGet(CFG.QLD_TOKEN_EP, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Requested-With": "XMLHttpRequest",
					"Origin": CFG.QLD_ORIGIN,
					"Referer": CFG.QLD_ORIGIN + "/",
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
						ancestorOrigins: {},
					},
					_csrf: csrf,
				}),
			}, (err, data, raw) => {
				if (err) {
					const tail = raw && raw.responseText
						? `: ${raw.responseText.slice(0, 160)}` : "";
					done(new Error(`[${this._label}] Token endpoint ${err.message}${tail}`), null);
					return;
				}
				if (!data.token) {
					done(new Error(`[${this._label}] Parse error: No token field in response`), null);
					return;
				}
				const exp = data.expires
					? data.expires > 1e12 ? data.expires : data.expires * 1000
					: Date.now() + CFG.DEFAULT_TTL;
				this.save(data.token, exp);
				console.info(
					`[CustomTiles] ${this._label} token acquired, expires`,
					new Date(exp).toISOString(),
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
				/<input[^>]+value=["']([^"']+)["'][^>]+name=["']_csrf["']/i,
			];
			for (const p of patterns) {
				const m = html.match(p);
				if (m) return m[1];
			}
			return null;
		}
	}

	/* -- Apple MapKit Token Manager --------------------------------------- */

	// Two-step bootstrap, modelled on the QGIS Apple Maps plugin's manual flow:
	//   1. GET duckduckgo.com/local.js?get_mk_token=1  -> raw JWT (DDG-signed,
	//      ~6 hr life, Origin pinned to duckduckgo.com)
	//   2. GET cdn.apple-mapkit.com/ma/bootstrap with Authorization: Bearer <jwt>
	//      and Origin: https://duckduckgo.com  ->  JSON containing accessKey
	//      (good for 30 min) and current tile-URL templates (where the `v`
	//      build number lives).
	class AppleTokenManager extends TokenManagerBase {
		constructor() {
			super({ label: "Apple" });
			this.accessKey = GM_getValue("apple_accesskey", null);
			this.version = GM_getValue("apple_version", CFG.APPLE_DEFAULT_V);
			this.expires = GM_getValue("apple_accesskey_expires", 0);
		}

		isValid() {
			return !!(
				this.accessKey && this.expires - Date.now() > CFG.REFRESH_MARGIN
			);
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

		// Two-step: pull a DDG-signed JWT, then exchange it at Apple's
		// bootstrap endpoint for a 30-minute accessKey + current build `v`.
		_fetch(done) {
			gmGet(CFG.APPLE_DDG_TOKEN_URL, {
				headers: {
					Accept: "*/*",
					Referer: CFG.APPLE_DDG_ORIGIN + "/",
				},
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
					Referer: CFG.APPLE_DDG_ORIGIN + "/",
				},
			}, (err, r) => {
				if (err) {
					done(new Error("[Apple] Bootstrap network error"));
					return;
				}
				if (r.status < 200 || r.status >= 300) {
					done(new Error(
						`[Apple] Bootstrap HTTP ${r.status}: ${r.responseText.slice(0, 160)}`));
					return;
				}
				try {
					const data = JSON.parse(r.responseText);
					if (!data.accessKey)
						throw new Error("No accessKey in bootstrap response");
					// Pull the current `v` build number out of any tile-URL template
					// in the response (tileSources, tileURLTemplate, etc.) so we
					// don't drift onto a stale build.
					const vMatch = r.responseText.match(/[?&]v=(\d+)/);
					const version = vMatch ? vMatch[1] : this.version;
					const exp = Date.now() + CFG.APPLE_TOKEN_TTL;
					this.save(data.accessKey, version, exp);
					console.info(
						"[CustomTiles] Apple accessKey acquired, v=" + version +
							", expires", new Date(exp).toISOString(),
					);
					done(null, data.accessKey, version);
				} catch (e) {
					done(new Error("[Apple] Bootstrap parse: " + e.message));
				}
			});
		}
	}

	/* -- HTTP + caching infrastructure ------------------------------------
	 *
	 *   gmGet(url, opts, cb)       — text/binary GET via GM_xmlhttpRequest
	 *   gmJsonGet(url, opts, cb)   — same + JSON parse
	 *   gmCancel(handle)           — abort an in-flight request
	 *   gmCoalesce(key, fn)        — share results when multiple callers
	 *                                kick off the same request concurrently
	 *   cachedFetch(key, ttlMs, fetcher, cb)
	 *                              — persistent (GM_setValue) cache with TTL
	 *
	 * These standardise what was ~12 ad-hoc GM_xmlhttpRequest call sites
	 * with copy-pasted try/catch + timeout + header handling, eliminate
	 * duplicate concurrent fetches for the same URL, and lift the address +
	 * sales caches out of memory so they survive page reloads.
	 */

	function gmGet(url, opts, cb) {
		if (typeof opts === "function") { cb = opts; opts = {}; }
		opts = opts || {};
		const handle = { aborted: false, _xhr: null };
		const req = GM_xmlhttpRequest({
			method: opts.method || "GET",
			url,
			headers: opts.headers || {},
			data: opts.data,
			responseType: opts.responseType,
			timeout: opts.timeout || 25000,
			// Explicitly opt INTO same-domain cookies. Desktop
			// Tampermonkey defaults to anonymous=false but several
			// mobile managers (notably "Userscripts" on iOS Safari)
			// default to true, which silently strips third-party
			// session cookies. Set explicitly for cross-manager
			// parity even though no current layer depends on it
			// (Geocaching moved to the public tile API in v7.9.85).
			anonymous: opts.anonymous === true ? true : false,
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
			},
		});
		handle._xhr = req;
		return handle;
	}

	function gmJsonGet(url, opts, cb) {
		if (typeof opts === "function") { cb = opts; opts = {}; }
		opts = opts || {};
		const headers = Object.assign(
			{ Accept: "application/json" }, opts.headers || {},
		);
		return gmGet(url, Object.assign({}, opts, { headers }), (err, r) => {
			if (err) { cb(err, null, r); return; }
			if (r.status < 200 || r.status >= 300) {
				cb(new Error("http " + r.status), null, r);
				return;
			}
			try { cb(null, JSON.parse(r.responseText), r); }
			catch (e) { cb(new Error("parse: " + e.message), null, r); }
		});
	}

	function gmCancel(handle) {
		if (!handle || handle.aborted) return;
		handle.aborted = true;
		if (handle._xhr && typeof handle._xhr.abort === "function") {
			try { handle._xhr.abort(); } catch (_) {}
		}
	}

	// Wire a GridLayer subclass so that any gmGet handle stored on a tile
	// DOM element (as `_dwHandle` for one fetch, or `_dwHandles` for the
	// Garmin-style multi-fetch case) is cancelled when Leaflet drops the
	// tile. Without this, fast panning leaves dozens of inflight XHRs
	// streaming bytes nobody will look at — wasteful on metered links and
	// outright harmful on the Garmin heatmap, which fans 5 requests per
	// tile and can queue 80+ wasted fetches on a single pan.
	function wireTileAbort(gridLayer) {
		gridLayer.on("tileunload", (e) => {
			const t = e.tile;
			if (!t) return;
			if (t._dwHandle) { gmCancel(t._dwHandle); t._dwHandle = null; }
			if (t._dwHandles) {
				for (const h of t._dwHandles) gmCancel(h);
				t._dwHandles = null;
			}
		});
	}

	// Coalesce concurrent fetchers by key. `fn(done)` is invoked once per
	// key while a previous call is still pending; every caller's callback
	// receives the same result. Used to dedupe e.g. address lookups when
	// the user hovers fast across multiple parcels.
	const _gmInflight = new Map();
	function gmCoalesce(key, fn, cb) {
		const existing = _gmInflight.get(key);
		if (existing) { existing.push(cb); return; }
		const waiters = [cb];
		_gmInflight.set(key, waiters);
		fn((err, value) => {
			_gmInflight.delete(key);
			for (const w of waiters) {
				try { w(err, value); } catch (e) { console.error("[CustomTiles] cb error", e); }
			}
		});
	}

	// Persistent cache backed by GM_setValue. Entries are JSON-encoded
	// `{ v, e }` where `e` is the absolute epoch-ms expiry (0 = never).
	// `fetcher(done)` is called only on miss/expiry, with done(err, value).
	// Cache writes are deduplicated via gmCoalesce so concurrent callers
	// for the same key share one underlying fetch.
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
		} catch (_) {}
		gmCoalesce(storageKey, fetcher, (err, value) => {
			if (!err && value !== undefined) {
				try {
					const expires = ttlMs > 0 ? Date.now() + ttlMs : 0;
					GM_setValue(storageKey, JSON.stringify({ v: value, e: expires }));
				} catch (_) {}
			}
			cb(err, value);
		});
	}

	// Common TTLs used across the script. Cadastre addresses essentially
	// never change for a given lotplan, so 30 days is safe. Sales data
	// updates monthly-ish, so 24 h is a reasonable middle ground.
	const _CACHE_TTL = {
		CAD_ADDRESS: 30 * 24 * 3600 * 1000,
		OTH_LOCATIONS:  7 * 24 * 3600 * 1000,
		OTH_PROPERTY:       6 * 3600 * 1000,
		OTH_EVENTS:        24 * 3600 * 1000,
	};

	/* -- Tile geometry utilities ------------------------------------------ */

	// Convert a Leaflet tile coordinate (z,x,y) into the geographic bbox the
	// tile covers, in EPSG:4326 (lat/lng degrees). Used by every ArcGIS
	// MapServer export-style provider.
	function tileToBBox4326(z, x, y) {
		const n = Math.pow(2, z);
		const lon1 = (x / n) * 360 - 180;
		const lon2 = ((x + 1) / n) * 360 - 180;
		const lat1 =
			(Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
		const lat2 =
			(Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n))) * 180) / Math.PI;
		return { minLon: lon1, minLat: lat2, maxLon: lon2, maxLat: lat1 };
	}

	// Convert a UTFGrid cell (cx, cy) within tile (z, tx, ty) to lat/lng.
	// UTFGrid tiles are 64x64 cells over a 256-pixel tile, so each cell is
	// 4 px wide and 4 px tall. We address the centre of the cell (offset
	// +0.5) and convert the resulting tile-pixel coordinate through the
	// standard slippy-tile Mercator inverse. Precision = tile_size/64:
	//   z=10 -> ~600 m   z=12 -> ~150 m   z=14 -> ~38 m   z=16 -> ~9.6 m
	// Used by the Geocaching public-tile layer to place markers from the
	// UTFGrid response (no per-cache lat/lng in the data; only cell idx).
	function utfGridCellToLatLng(z, tx, ty, cx, cy) {
		const px = (cx + 0.5) / 64;
		const py = (cy + 0.5) / 64;
		const n = Math.pow(2, z);
		const lon = ((tx + px) / n) * 360 - 180;
		const lat =
			(Math.atan(Math.sinh(Math.PI * (1 - (2 * (ty + py)) / n))) * 180) /
			Math.PI;
		return [lat, lon];
	}

	// Same idea, but in EPSG:3857 Web Mercator metres — for WMS endpoints
	// (and anything else that wants the bbox in metres).
	const _MERC_ORIGIN = 20037508.3428;
	const _MERC_FULL = 2 * _MERC_ORIGIN;
	function tileToBBox3857(z, x, y) {
		const n = Math.pow(2, z);
		const tw = _MERC_FULL / n;
		const west = -_MERC_ORIGIN + x * tw;
		const east = west + tw;
		const north = _MERC_ORIGIN - y * tw;
		const south = north - tw;
		return { west, south, east, north };
	}

	/* -- Mapbox custom protocol (`dw://`) ---------------------------------
	 *
	 * Mapbox GL JS raster sources need a static URL template. Many of our
	 * Leaflet layers can't be expressed that way:
	 *   - ArcGIS Export tiles use per-tile bbox params (size, format, layers)
	 *   - Stamen Terrain needs a spoofed Origin header (Mapbox can't set one)
	 *   - QLD Historical needs an async catalog lookup before each fetch
	 *   - QLD Roads embeds dynamicLayers JSON in the query string
	 *
	 * Solution: register `mapboxgl.addProtocol("dw", handler)` so Mapbox
	 * raster sources can use `dw://<layerKey>/{z}/{x}/{y}.png` URLs.
	 * The handler routes to a per-layer fetch function the Leaflet layer
	 * registered via `dwRegisterMbLayer()` — whatever auth flow, header
	 * spoof, or bbox builder it needs is encapsulated there. Each tile
	 * resolves with the same ArrayBuffer Mapbox would have got from a
	 * direct fetch.
	 */
	const _dwMbLayers = new Map();
	let   _dwMbNextId = 1;
	// Set true the first time `mapboxgl.addProtocol` works. Mapbox GL JS
	// v3 dropped addProtocol entirely (it's a MapLibre API; the official
	// v3.x CDN build has no such export), so on dynamic.watch this stays
	// false and `_dwMbKey` layers (Stamen, QLD Historical, Garmin) are
	// served through the transformRequest blob bridge instead (see the
	// DW_TILE_PREFIX block below).
	let   _dwMbHasProtocol = false;

	function dwRegisterMbLayer(lyr, fetchTile) {
		const key = "lyr" + (_dwMbNextId++);
		_dwMbLayers.set(key, fetchTile);
		lyr._dwMbKey = key;
		return key;
	}

	function dwUnregisterMbLayer(lyr) {
		if (lyr && lyr._dwMbKey) {
			_dwMbLayers.delete(lyr._dwMbKey);
			lyr._dwMbKey = null;
		}
	}

	function dwMbProtocolHandler(params) {
		const m = (params.url || "").match(/^dw:\/\/(\w+)\/(\d+)\/(\d+)\/(\d+)\b/);
		if (!m) return Promise.reject(new Error("dw://: bad url " + params.url));
		const [, key, z, x, y] = m;
		const fetchTile = _dwMbLayers.get(key);
		if (!fetchTile) return Promise.reject(new Error("dw://: no layer " + key));
		return Promise.resolve()
			.then(() => fetchTile(+z, +x, +y))
			.then((data) => ({ data }));
	}

	// Helper: arraybuffer fetch through fetch() (no header spoof).
	function dwMbFetchAB(url) {
		return fetch(url, { credentials: "omit" }).then((r) => {
			if (!r.ok) throw new Error("HTTP " + r.status + " " + url);
			return r.arrayBuffer();
		});
	}
	// Helper: arraybuffer fetch through GM_xhr (header spoof / cookies).
	function dwMbGmFetchAB(url, opts) {
		return new Promise((resolve, reject) => {
			gmGet(url, { responseType: "arraybuffer", ...(opts || {}) }, (err, r) => {
				if (err) return reject(err);
				if (!r || r.status >= 400) return reject(new Error("HTTP " + (r?.status || "?") + " " + url));
				resolve(r.response);
			});
		});
	}

	/* -- transformRequest bridge (addProtocol replacement) ----------------
	 *
	 * Mapbox GL JS v3 has NO `addProtocol` (it's a MapLibre API — the
	 * official Mapbox v3.x CDN build genuinely doesn't export it), so the
	 * `dw://` scheme above can never fire on dynamic.watch. But the layers
	 * that needed it (Stamen — Origin spoof; QLD Historical — async
	 * catalog; Garmin Heatmap — multi-feed canvas composite) still can't
	 * be expressed as a plain Mapbox tile URL.
	 *
	 * The workaround: give those raster sources a sentinel URL template
	 * (`https://dwtile.local/<key>/{z}/{x}/{y}.png`) and intercept it in
	 * the map's `transformRequest`. For each tile:
	 *   • a cached blob → serve it,
	 *   • otherwise → fire the registered GM fetcher, hand Mapbox a
	 *     transparent 1×1 placeholder for now, and once the fetch lands,
	 *     cache the blob and debounce a source reload so Mapbox
	 *     re-requests the tile and gets the real image.
	 * `transformRequest` can't set the Origin header itself (browsers
	 * forbid it), which is exactly why the fetch must go through
	 * GM_xmlhttpRequest — so this bridge is the only way to render these
	 * layers in 3D on a v3 Mapbox.
	 */
	const DW_TILE_PREFIX = "https://dwtile.local/";
	// 1×1 transparent PNG — handed back for not-yet-warmed tiles so
	// Mapbox shows nothing (rather than an error placeholder) until the
	// reload swaps in the real blob.
	const DW_TRANSPARENT_PNG =
		"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

	function dwTileSentinel(key) {
		return `${DW_TILE_PREFIX}${key}/{z}/{x}/{y}.png`;
	}

	// Session-wide blob cache shared across 3D enable/disable cycles
	// (keyed by `<layerKey>/<z>/<x>/<y>`, query string stripped so a
	// cache-busting reload still hits the same entry).
	const _dwTileBlobs    = new Map();   // cacheKey -> objectURL
	const _dwTileInflight = new Set();   // cacheKey currently fetching
	// cacheKey -> failure timestamp. Failures are retried after a TTL —
	// a Set here would make one transient timeout blank that tile for
	// the rest of the session.
	const _dwTileFailed   = new Map();
	const DW_TILE_FAIL_RETRY_MS = 60 * 1000;
	const DW_TILE_BLOB_MAX = 600;

	function _dwTileFailedRecently(cacheKey) {
		const at = _dwTileFailed.get(cacheKey);
		return at != null && (Date.now() - at) < DW_TILE_FAIL_RETRY_MS;
	}

	function _dwTileEvict() {
		while (_dwTileBlobs.size > DW_TILE_BLOB_MAX) {
			const first = _dwTileBlobs.keys().next().value;
			const url = _dwTileBlobs.get(first);
			_dwTileBlobs.delete(first);
			// Defer the revoke: Mapbox may have JUST been handed this URL
			// by transformRequest and not started the fetch yet. A
			// re-request after eviction misses the cache and re-warms, so
			// correctness doesn't depend on the URL staying alive — the
			// delay only closes the evict-vs-inflight-fetch race.
			setTimeout(() => {
				try { URL.revokeObjectURL(url); } catch (_) {}
			}, 30 * 1000);
		}
	}

	/* -- Layer Providers --------------------------------------------------- */

	class LayerProvider {
		/** @returns {L.Layer} */
		create() {
			throw new Error(`${this.constructor.name}.create() not implemented`);
		}
	}

	function tileProvider(url, opts = {}) {
		return class extends LayerProvider {
			create() {
				return L.tileLayer(url, {
					tileSize: 256, maxNativeZoom: 18, maxZoom: 22,
					crossOrigin: true, ...opts,
				});
			}
		};
	}

	// Pass-through wrapper for layers whose entire body is
	// `makeArcgisExportTileLayer(opts)` — Cadastre, QPWS, Mobile Coverage.
	function arcgisExportProvider(opts) {
		return class extends LayerProvider {
			create() { return makeArcgisExportTileLayer(opts); }
		};
	}

	// Token-aware variant: `buildUrl(tokenMgr)` is passed the whole token
	// manager so providers with multi-field credentials (Apple uses
	// accessKey + version) can read what they need.
	function tokenTileProvider(buildUrl, opts = {}) {
		return class extends LayerProvider {
			constructor(tokenMgr) { super(); this._token = tokenMgr; }
			create() {
				const tok = this._token;
				const layer = L.tileLayer(
					tok.isValid() ? buildUrl(tok) : BLANK_TILE,
					{ tileSize: 256, maxNativeZoom: 21, maxZoom: 25,
					  crossOrigin: true, ...opts },
				);
				if (!tok.isValid()) {
					tok.get(() => {
						if (tok.isValid()) layer.setUrl(buildUrl(tok));
					});
				}
				return layer;
			}
		};
	}

	// Factory for the ArcGIS MapServer `export?` pattern shared by Mobile
	// Coverage, QPWS, and Cadastre overlays. Renders a transparent PNG per
	// Leaflet tile with the requested sublayers shown.
	//
	// opts: {
	//   baseUrl:        MapServer URL (no trailing slash)
	//   showLayers:     comma-separated sublayer IDs, e.g. "10,5,6"
	//   pane:           Leaflet pane name to put tiles in
	//   paneZIndex:     numeric z-index for the pane
	//   opacity, minZoom, maxZoom, attribution, tileSize=256
	//   clickThrough=true:  set pointer-events:none on the pane (so layers
	//                       underneath still receive hover/click events)
	//   onAdd, onRemove:    optional hooks receiving (layer, map) — used by
	//                       Cadastre to attach hover-identify
	// }
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
				return (
					`${opts.baseUrl}/export?` +
					`bbox=${bb.minLon},${bb.minLat},${bb.maxLon},${bb.maxLat}` +
					`&bboxSR=4326&imageSR=4326` +
					(opts.showLayers != null ? `&layers=show:${opts.showLayers}` : "") +
					`&size=${tileSize},${tileSize}` +
					`&format=png32&transparent=true&f=image`
				);
			},
		});

		const inst = new Layer("", {
			opacity: opts.opacity,
			attribution: opts.attribution,
			minZoom: opts.minZoom,
			maxZoom: opts.maxZoom,
			// Optional: when the export endpoint has a meaningful resolution
			// ceiling (e.g. coarse coverage grids), set this and Leaflet will
			// stretch the maxNativeZoom tiles instead of querying for tinier
			// bboxes that just render the same coarse polygons.
			maxNativeZoom: opts.maxNativeZoom,
			tileSize,
			pane: opts.pane,
		});
		// 3D mirror: Mapbox supports `{bbox-epsg-3857}` natively in
		// raster source URL templates. ArcGIS Export takes a bbox
		// query string, so the Mapbox-side URL just needs that token —
		// no dw:// indirection, no protocol handler. Use 3857 for both
		// bboxSR and imageSR; ArcGIS resolves them identically.
		const showParam = opts.showLayers != null ? `&layers=show:${opts.showLayers}` : "";
		inst._dwMb3DUrl =
			`${opts.baseUrl}/export?bbox={bbox-epsg-3857}` +
			`&bboxSR=3857&imageSR=3857` +
			`&size=${tileSize},${tileSize}` +
			`&format=png32&transparent=true&f=image${showParam}`;
		return inst;
	}

	// Vector-tile overlay: fetches the MVT (.pbf) tiles covering the current
	// view, decodes them with mvtDecode, projects each feature's tile-extent
	// geometry to lat/lon, maps it via opts.toElements(), and hands the result
	// to opts.render() in the very same { type, geometry|lat/lon, tags } shape
	// an OSM/Overpass-style renderer consumes — so such a renderer can be
	// repointed at a vector-tile backend unchanged. Debounced and generation-
	// guarded like the other view-driven layers; in-flight tile fetches are
	// aborted when the view changes.
	//
	// De-dup: node-type elements carrying an `_id` are de-duplicated across
	// tiles, and dropped when a way-type element shares that `_id` (so a feature
	// shipped as both a polygon and a centroid point renders only as the
	// polygon). Way-type elements are never de-duplicated — a line/area clipped
	// across tile borders must keep every piece.
	//
	// opts: { label, pane, paneZIndex, minZoom, maxNativeZoom=16, tileUrl(z,x,y),
	//         toElements(layerName, props, geomType, latlonRings)->elements|null,
	//         render(group, elements, zoom), attribution,
	//         debounceMs=400, timeoutMs=20000, padBounds=0, maxTiles=60 }
	function makeVectorTileLayer(opts) {
		const debounceMs = opts.debounceMs || 400;
		const timeoutMs = opts.timeoutMs || 20000;
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
				if (this._group) { this._group.remove(); this._group = null; }
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
						(1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n);
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
					console.warn(`[CustomTiles] ${opts.label}: ${coords.length} ` +
						`tiles exceeds cap ${maxTiles}, skipping`);
					return;
				}

				const myGen = ++this._gen;
				this._cancel();
				const elements = [];
				let pending = coords.length;
				if (!pending) { this._group.clearLayers(); return; }

				const finish = () => {
					if (myGen !== this._gen || !this._group) return;
					// Prefer polygons over their centroid points; drop duplicate
					// boundary points (see header).
					const wayIds = new Set();
					for (const el of elements)
						if (el.type === "way" && el._id) wayIds.add(el._id);
					const seenNode = new Set();
					const out = elements.filter((el) => {
						if (el.type === "node" && el._id) {
							if (wayIds.has(el._id) || seenNode.has(el._id)) return false;
							seenNode.add(el._id);
						}
						return true;
					});
					this._group.clearLayers();
					opts.render(this._group, out, tz);
				};

				for (const [x, y] of coords) {
					const h = gmGet(opts.tileUrl(tz, x, y),
						{ responseType: "arraybuffer", timeout: timeoutMs },
						(err, r) => {
							if (myGen === this._gen && this._group &&
							    !err && r && r.status === 200 && r.response) {
								try {
									const layers = mvtDecode(r.response);
									for (const layer of layers) {
										const ext = layer.extent || 4096;
										for (const f of layer.features) {
											const props = {};
											for (let i = 0; i < f.tags.length; i += 2)
												props[layer.keys[f.tags[i]]] =
													layer.values[f.tags[i + 1]];
											const rings = decodeGeometry(f.geom).map((ring) =>
												ring.map((p) => ({
													lon: (x + p[0] / ext) / n * 360 - 180,
													lat: Math.atan(Math.sinh(Math.PI *
														(1 - 2 * (y + p[1] / ext) / n))) *
														180 / Math.PI,
												})));
											const els =
												opts.toElements(layer.name, props, f.type, rings);
											if (els) for (const e of els) elements.push(e);
										}
									}
								} catch (e) { /* skip a malformed tile */ }
							}
							if (--pending === 0) finish();
						});
					this._handles.push(h);
				}
			},

			getAttribution() { return opts.attribution; },
		});

		return new Layer();
	}

	// -- QLD Globe -----------------------------------------------------------

	const QldGlobeLayerProvider = tokenTileProvider(
		(tok) => CFG.QLD_TILE_TPL + (tok.token ? "?token=" + tok.token : ""),
		{ maxNativeZoom: 21, maxZoom: 25,
		  attribution: "&copy; State of Queensland (Department of Resources)" },
	);

	// -- Google Hybrid --------------------------------------------------------

	const GoogleHybridLayerProvider = tileProvider(
		CFG.GOOGLE_HYBRID_TILE,
		{ subdomains: ["0","1","2","3"], maxNativeZoom: 21,
		  attribution: "&copy; Google" },
	);

	// -- Apple Maps ----------------------------------------------------------

	function buildAppleTileUrl(accessKey, version) {
		return CFG.APPLE_TILE_BASE +
			"&v=" + encodeURIComponent(version || CFG.APPLE_DEFAULT_V) +
			(accessKey ? "&accessKey=" + encodeURIComponent(accessKey) : "");
	}

	const AppleMapsLayerProvider = tokenTileProvider(
		(tok) => buildAppleTileUrl(tok.accessKey, tok.version),
		{ maxNativeZoom: 19, maxZoom: 22, attribution: "&copy; Apple" },
	);

	// -- Stamen Toner (via Stadia Maps, localhost-spoofed) -------------------

	class StamenTerrainLayerProvider extends LayerProvider {
		create() {
			const TILE_PX = 256;
			// Stamen Terrain — colour-shaded relief with optional labels.
			// Stadia's path is `stamen_terrain` (Toner was hard-to-read
			// black-and-white; Terrain serves the "topo context" purpose
			// the Toner slot used to fill, with much better legibility).
			const TILE_BASE = "https://tiles.stadiamaps.com/tiles/stamen_terrain/";
			const spoofOrigin = CFG.STADIA_SPOOF_ORIGIN;

			const TerrainGrid = L.GridLayer.extend({
				createTile(coords, done) {
					const img = document.createElement("img");
					img.setAttribute("role", "presentation");
					const url =
						TILE_BASE + coords.z + "/" + coords.x + "/" + coords.y + ".png";
					img._dwHandle = gmGet(url, {
						responseType: "arraybuffer",
						headers: {
							Origin:  spoofOrigin,
							Referer: spoofOrigin + "/",
							Accept:  "image/png,image/*,*/*;q=0.8",
						},
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
						const blob   = new Blob([r.response], { type: "image/png" });
						const objUrl = URL.createObjectURL(blob);
						img.onload  = () => { URL.revokeObjectURL(objUrl); done(null, img); };
						img.onerror = () => {
							URL.revokeObjectURL(objUrl);
							done(new Error("Stamen decode failed"), img);
						};
						img.src = objUrl;
					});
					return img;
				},
			});

			const layer = new TerrainGrid({
				tileSize: TILE_PX,
				maxNativeZoom: 18,    // Terrain caps at 18; tiles past 20 ship empty placeholders
				maxZoom: 22,
				attribution:
					'&copy; <a href="https://stadiamaps.com/" target="_blank" rel="noreferrer">Stadia Maps</a> ' +
					'&copy; <a href="https://stamen.com/" target="_blank" rel="noreferrer">Stamen Design</a> ' +
					'&copy; <a href="https://openmaptiles.org/" target="_blank" rel="noreferrer">OpenMapTiles</a> ' +
					'&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors',
			});
			wireTileAbort(layer);
			// 3D mirror: Stadia rejects browser-fetch from non-allowlisted
			// origins, so we proxy the request through GM_xmlhttpRequest
			// with the same `localhost` Origin Leaflet's createTile spoofs.
			dwRegisterMbLayer(layer, (z, x, y) => dwMbGmFetchAB(
				TILE_BASE + z + "/" + x + "/" + y + ".png", {
					headers: {
						Origin:  spoofOrigin,
						Referer: spoofOrigin + "/",
						Accept:  "image/png,image/*,*/*;q=0.8",
					},
				}));
			return layer;
		}
	}

	// -- Esri World Imagery Wayback ------------------------------------------
	// Public archive of every Esri World Imagery release (~2014 onward).
	// Bootstrap fetches the release catalog; tile URL embeds the release number.

	class WaybackLayerProvider extends LayerProvider {
		constructor() {
			super();
			this._releases = null;
			this._idx = 0;
			this._fetching = false;
			this._layerRef = null;
		}

		_tileUrl(releaseNum) {
			return (
				"https://wayback.maptiles.arcgis.com/arcgis/rest/services/" +
				"World_Imagery/WMTS/1.0.0/default028mm/MapServer/tile/" +
				releaseNum +
				"/{z}/{y}/{x}"
			);
		}

		// Catalog rarely changes — Esri publishes new releases on a slow
		// cadence — so persist for 24h via cachedFetch. The first session
		// pays the round-trip; subsequent toggles are instant. Releases are
		// stored as their decoded {label, releaseNum} array; the per-tile
		// URL is rebuilt locally so a future change to the tile-template
		// host doesn't require flushing the cache.
		_fetchCatalog() {
			if (this._fetching || this._releases) return;
			this._fetching = true;
			cachedFetch(
				"wayback_catalog",
				24 * 3600 * 1000,
				(done) => gmJsonGet(CFG.WAYBACK_CONFIG_URL, (err, data) => {
					if (err) { done(err, null); return; }
					const releases = Object.entries(data)
						.filter(([, item]) => item.itemTitle)
						.map(([key, item]) => ({
							releaseNum: parseInt(key, 10),
							label: item.itemTitle
								.replace(/^World Imagery \(Wayback /, "")
								.replace(/\)$/, ""),
						}));
					releases.sort((a, b) =>
						a.label < b.label ? 1 : a.label > b.label ? -1 : 0);
					done(null, releases);
				}),
				(err, releases) => {
					this._fetching = false;
					if (err || !releases) {
						console.error("[CustomTiles] Wayback catalog:", err && err.message);
						return;
					}
					this._releases = releases.map(r => ({
						...r, url: this._tileUrl(r.releaseNum),
					}));
					console.info("[CustomTiles] Wayback:",
						this._releases.length, "releases loaded");
					this._idx = 0;
					if (this._layerRef) {
						this._layerRef.setUrl(this._releases[0].url);
						this._layerRef.fire("histchange");
					}
				},
			);
		}

		create() {
			const provider = this;
			const layer = L.tileLayer(BLANK_TILE, {
				maxNativeZoom: 19,
				maxZoom: 25,
				tileSize: 256,
				attribution: "&copy; Esri, Maxar, Earthstar Geographics",
			});
			this._layerRef = layer;

			layer.getHistCount = () =>
				provider._releases ? provider._releases.length : 0;
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
	}


	// -- QLD Labels ----------------------------------------------------------

	// maxZoom 25 (vs native 19) so Leaflet stretches z=19 instead of 404ing.
	const QldLabelsLayerProvider = tileProvider(CFG.QLD_LABELS_TILE, {
		maxNativeZoom: 19, maxZoom: 25, pane: "dwLabelsPane",
		attribution: "&copy; State of Queensland (Department of Resources)",
	});

	// -- QLD Roads -----------------------------------------------------------

	class QldRoadsLayerProvider extends LayerProvider {
		constructor(qldToken) {
			super();
			this._token = qldToken;
		}

		create() {
			const TILE_PX = 256;
			const token = this._token;
			// Show labels on the four sublayers we render.
			const DYN_LAYERS = encodeURIComponent(JSON.stringify(
				[21, 22, 23, 10].map(id => ({
					id, source: { type: "mapLayer", mapLayerId: id },
					drawingInfo: { showLabels: true },
				})),
			));

			const QldRoadsGrid = L.GridLayer.extend({
				createTile(coords, done) {
					const img = document.createElement("img");
					img.setAttribute("role", "presentation");
					const b = tileToBBox3857(coords.z, coords.x, coords.y);
					const bbox = encodeURIComponent(
						`${b.west},${b.south},${b.east},${b.north}`);
					const tok = token.token
						? "&token=" + encodeURIComponent(token.token)
						: "";
					img.onload = () => done(null, img);
					img.onerror = () => done(new Error("Roads tile failed"), img);
					img.src =
						CFG.QLD_ROADS_EXPORT +
						`?bbox=${bbox}&bboxSR=102100&imageSR=102100` +
						`&size=${TILE_PX}%2C${TILE_PX}` +
						`&dpi=192&format=png32&transparent=true` +
						`&dynamicLayers=${DYN_LAYERS}&f=image${tok}`;
					return img;
				},
			});

			const layer = new QldRoadsGrid({
				tileSize: TILE_PX,
				maxNativeZoom: 19,
				maxZoom: 25,
				pane: "dwRoadsPane",
				attribution: "&copy; State of Queensland (Department of Resources)",
			});
			// 3D mirror: ArcGIS understands `bboxSR=3857`, and Mapbox
			// expands `{bbox-epsg-3857}` natively in raster source URLs.
			// Getter form because the QLD token may not be available
			// at create-time (CSRF bootstrap is async) and rotates
			// every ~6h — re-eval on each sync keeps the URL valid.
			layer._dwMb3DGetUrl = () => {
				if (!token.token) return null;  // skip mirror until ready
				const tok = "&token=" + encodeURIComponent(token.token);
				return CFG.QLD_ROADS_EXPORT +
					`?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857` +
					`&size=${TILE_PX},${TILE_PX}` +
					`&dpi=192&format=png32&transparent=true` +
					`&dynamicLayers=${DYN_LAYERS}&f=image${tok}`;
			};
			return layer;
		}
	}

	// -- QLD Historical -------------------------------------------------------

	class QldHistoricalLayerProvider extends LayerProvider {
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

			const geomParam =
				"?geometry=" +
				encodeURIComponent(
					JSON.stringify({
						x: c.lng,
						y: c.lat,
						spatialReference: { wkid: 4326 },
					}),
				) +
				"&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects" +
				"&outFields=objectid,name,year,title,capturestart" +
				"&returnGeometry=false&orderByFields=capturestart+DESC&f=json";

			// `data` is the already-parsed ArcGIS /query response (.features
			// array of {attributes}). The old shape took raw responseText
			// and JSON.parsed inline; now that gmJsonGet hands us the
			// parsed object directly there's no reason to re-stringify.
			const parseCaptures = (data, service, needsToken, mosaicWhere) =>
				(data && data.features || [])
					.map((f) => ({
						objectid: f.attributes.objectid,
						title:
							f.attributes.title ||
							f.attributes.name ||
							String(f.attributes.year || ""),
						captureDate: f.attributes.capturestart
							? new Date(f.attributes.capturestart).toISOString().slice(0, 10)
							: f.attributes.year
								? String(f.attributes.year)
								: null,
						service,
						needsToken,
						mosaicWhere,
					}))
					.filter((f) => f.objectid);

			let orthoCaptures = null;
			let photosCaptures = null;

			const finish = () => {
				this._fetching = false;
				const all = [...(orthoCaptures || []), ...(photosCaptures || [])];
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
						this._captures[0].captureDate || this._captures[0].title,
					);
				} else {
					console.warn(
						"[CustomTiles] QLD Historical: no coverage at",
						c.lng.toFixed(4),
						c.lat.toFixed(4),
					);
				}
				this._captureIdx = 0;
				this._currentOid =
					(this._captures[0] && this._captures[0].objectid) || null;
				this._fetchPending.splice(0).forEach((fn) => fn(this._currentOid));
				if (this._gridLayerRef) this._gridLayerRef.fire("capturechange");
			};

			const tryFinish = () => {
				if (orthoCaptures !== null && photosCaptures !== null) finish();
			};

			// Query 1: AerialOrtho (no token, public)
			gmJsonGet(
				CFG.QLD_HIST_SERVICE + "/query" + geomParam + "&where=category%3D1",
				{ headers: { Origin: "https://qldglobe.information.qld.gov.au" } },
				(err, data) => {
					if (err) {
						console.error("[CustomTiles] QLD Historical ortho query:",
							err.message);
						orthoCaptures = [];
					} else {
						orthoCaptures = parseCaptures(
							data, CFG.QLD_HIST_SERVICE, false, "category=1");
					}
					tryFinish();
				},
			);

			// Query 2: HistoricalAerialPhoto (requires token — holds the
			// 1930s–1990s scanned aerial photos). Silent empty result here is
			// why Brisbane appeared to start in 1994 (the AerialOrtho program's
			// earliest capture). Verbose logging makes auth/pagination issues
			// visible in the console so we can tell ortho-only fallback apart
			// from a real "no coverage" result.
			const doPhotosQuery = (tok) => {
				const tokenParam = tok ? "&token=" + encodeURIComponent(tok) : "";
				const url =
					CFG.QLD_HIST_PHOTOS_SERVICE + "/query" + geomParam +
					"&where=1%3D1" + tokenParam;
				gmJsonGet(url, {
					headers: {
						Origin:  "https://qldglobe.information.qld.gov.au",
						Referer: "https://qldglobe.information.qld.gov.au/",
					},
				}, (err, data, raw) => {
					if (err) {
						const body = raw && raw.responseText
							? ` ${raw.responseText.slice(0, 200)}` : "";
						console.warn("[CustomTiles] QLD Historical photos",
							err.message,
							tok ? "(token sent)" : "(no token)", body);
						photosCaptures = [];
					} else if (data.error) {
						console.warn(
							"[CustomTiles] QLD Historical photos service error:",
							data.error.code, data.error.message,
							tok ? "(token sent — may be expired or wrong scope)"
							    : "(no token)");
						photosCaptures = [];
					} else {
						photosCaptures = parseCaptures(
							data, CFG.QLD_HIST_PHOTOS_SERVICE, !!tok, null);
						const total = (data.features || []).length;
						const limited = !!data.exceededTransferLimit;
						console.info("[CustomTiles] QLD Historical photos:",
							total, "features",
							limited
								? "(LIMITED — older captures cut off, see maxRecordCount)"
								: "");
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
						`${b.west},${b.south},${b.east},${b.north}`);

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
						const tokenStr =
							needsToken && provider._qldToken && provider._qldToken.token
								? "&token=" + encodeURIComponent(provider._qldToken.token)
								: "";
						const mosaicRuleObj = {
							mosaicMethod: "esriMosaicLockRaster",
							lockRasterIds: [oid],
							ascending: true,
						};
						if (mosaicWhere) mosaicRuleObj.where = mosaicWhere;
						const mosaicRule = encodeURIComponent(
							JSON.stringify(mosaicRuleObj),
						);
						img.onload = () => done(null, img);
						img.onerror = () => done(new Error("QLD Hist tile failed"), img);
						img.src =
							svc +
							"/exportImage?bbox=" +
							bbox +
							"&bboxSR=102100&imageSR=102100" +
							"&size=" +
							TILE_PX +
							"%2C" +
							TILE_PX +
							"&format=jpg&mosaicRule=" +
							mosaicRule +
							"&f=image" +
							tokenStr;
					});
					return img;
				},
			});

			const gridLayer = new QldHistGrid({
				maxNativeZoom: 21,
				maxZoom: 25,
				tileSize: TILE_PX,
				keepBuffer: 2,
				attribution:
					"&copy; State of Queensland (Department of Resources) " +
					new Date().getFullYear(),
			});
			this._gridLayerRef = gridLayer;

			gridLayer.getCaptureCount = function () {
				return provider._captures.length;
			};
			gridLayer.getCaptureIdx = function () {
				return provider._captureIdx;
			};
			gridLayer.getCaptureDate = function (idx) {
				const c =
					provider._captures[idx !== undefined ? idx : provider._captureIdx];
				return c ? c.captureDate || null : null;
			};
			gridLayer.setCapture = function (idx) {
				if (
					idx < 0 ||
					idx >= provider._captures.length ||
					idx === provider._captureIdx
				)
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

			// 3D mirror: getter form so it works without addProtocol.
			// Returns null while the catalog query is in flight; the
			// catalog resolution fires `capturechange` (we listen for
			// that in Mode3DController) which triggers a resync once
			// `_currentOid` is set. Mapbox's `{bbox-epsg-3857}` token
			// gives us per-tile bbox substitution at the service layer.
			gridLayer._dwMb3DGetUrl = () => {
				if (provider._currentOid == null) {
					// Catalog hasn't resolved — kick off a query so the
					// retry path eventually re-evaluates with an OID.
					const map = gridLayer._map;
					if (map && !provider._fetching) {
						provider._queryCatalog(map, () => {});
					}
					return null;
				}
				const cap = provider._captures[provider._captureIdx];
				const svc = cap ? cap.service : CFG.QLD_HIST_SERVICE;
				const mosaicWhere = cap ? cap.mosaicWhere : "category=1";
				const needsToken = cap && cap.needsToken;
				const tokStr =
					needsToken && provider._qldToken && provider._qldToken.token
						? "&token=" + encodeURIComponent(provider._qldToken.token)
						: "";
				const mosaicRuleObj = {
					mosaicMethod: "esriMosaicLockRaster",
					lockRasterIds: [provider._currentOid],
					ascending: true,
				};
				if (mosaicWhere) mosaicRuleObj.where = mosaicWhere;
				const mosaicRule = encodeURIComponent(
					JSON.stringify(mosaicRuleObj));
				return svc + "/exportImage?bbox={bbox-epsg-3857}" +
					"&bboxSR=3857&imageSR=3857" +
					"&size=" + TILE_PX + "," + TILE_PX +
					"&format=jpg&mosaicRule=" + mosaicRule +
					"&f=image" + tokStr;
			};
			// Event names Mode3DController watches to trigger a
			// re-sync (so the scrubber moving back in time refetches
			// tiles for the new capture).
			gridLayer._dwMb3DReloadOn = ["capturechange"];

			// Legacy dw:// path — unused on builds without addProtocol,
			// kept so a fresh Mapbox build that does expose addProtocol
			// transparently regains the same behaviour.
			const EMPTY_PNG_AB = (() => {
				// 1×1 transparent PNG — fixed bytes so we don't allocate.
				const b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
				const bin = atob(b64);
				const ab  = new ArrayBuffer(bin.length);
				const u8  = new Uint8Array(ab);
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
						`${b.west},${b.south},${b.east},${b.north}`);
					const cap = provider._captures[provider._captureIdx];
					const svc = cap ? cap.service : CFG.QLD_HIST_SERVICE;
					const mosaicWhere = cap ? cap.mosaicWhere : "category=1";
					const needsToken = cap && cap.needsToken;
					const tokenStr =
						needsToken && provider._qldToken && provider._qldToken.token
							? "&token=" + encodeURIComponent(provider._qldToken.token)
							: "";
					const mosaicRuleObj = {
						mosaicMethod: "esriMosaicLockRaster",
						lockRasterIds: [oid],
						ascending: true,
					};
					if (mosaicWhere) mosaicRuleObj.where = mosaicWhere;
					const mosaicRule = encodeURIComponent(
						JSON.stringify(mosaicRuleObj));
					const url =
						svc +
						"/exportImage?bbox=" + bbox +
						"&bboxSR=102100&imageSR=102100" +
						"&size=" + TILE_PX + "%2C" + TILE_PX +
						"&format=jpg&mosaicRule=" + mosaicRule +
						"&f=image" + tokenStr;
					dwMbFetchAB(url).then(resolve, reject);
				});
			}));

			gridLayer.on("add", function () {
				const m = this._map;
				const onMoveEnd = () => {
					if (!provider._lastCenter) return;
					const c = m.getCenter();
					const dist =
						Math.abs(c.lng - provider._lastCenter.lng) +
						Math.abs(c.lat - provider._lastCenter.lat);
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
	}

	// -- Strava Heatmap (anonymous tiles only) ----------------------------

	// Strava's heatmap CDN sends `Vary: Origin` but withholds
	// `Access-Control-Allow-Origin` for non-allowlisted origins (it stopped
	// CORS-allowing arbitrary sites). Consequences + handling:
	//   • 2D: a CORS-enabled <img> (crossOrigin:true) fails its CORS check
	//     even though the tile returns 200 — so we DON'T set crossOrigin.
	//     We never read its pixels in 2D, so a plain (CORS-free) <img>
	//     displays the heatmap fine.
	//   • 3D: Mapbox needs CORS-clean tiles for WebGL textures, which this
	//     endpoint won't provide — so we route Strava through the GM blob
	//     bridge (GM_xmlhttpRequest is exempt from CORS), same as Garmin.
	class StravaHeatmapLayerProvider extends LayerProvider {
		create() {
			const layer = L.tileLayer(CFG.STRAVA_HEATMAP_TILE, {
				tileSize: 256, maxNativeZoom: 10, maxZoom: 25,
				opacity: 0.8, crossOrigin: false,
				attribution: "© Strava",
			});
			dwRegisterMbLayer(layer, (z, x, y) => dwMbGmFetchAB(
				CFG.STRAVA_HEATMAP_TILE
					.replace("{z}", z).replace("{x}", x).replace("{y}", y)));
			return layer;
		}
	}

	// -- Garmin Heatmap ---------------------------------------------------

	class GarminHeatmapLayerProvider extends LayerProvider {
		create() {
			const ACTIVITIES = [
				"RUNNING",
				"HIKING",
				"TRAIL_RUNNING",
				"ROAD_CYCLING",
				"MOUNTAIN_BIKING",
			];

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
						const url =
							"https://connecttile.garmin.com/" + activity + "/" +
							coords.z + "/" + coords.x + "/" + coords.y + ".png";
						canvas._dwHandles.push(
							gmGet(url, { responseType: "arraybuffer" }, (err, r) => {
								if (err || r.status !== 200) {
									failed++; finish(); return;
								}
								const blob   = new Blob([r.response], { type: "image/png" });
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
									failed++; finish();
								};
								img.src = objUrl;
							}),
						);
					}

					return canvas;
				},
			});

			const layer = new GarminHeatGrid({
				tileSize: 256,
				maxNativeZoom: 17,
				maxZoom: 25,
				opacity: 0.8,
				attribution: "© Garmin",
			});
			wireTileAbort(layer);
			// 3D mirror: fetch all 5 activity feeds in parallel, decode
			// each via createImageBitmap, then composite onto an
			// OffscreenCanvas with `globalCompositeOperation: "lighter"`
			// — the same additive blend the Leaflet createTile uses on
			// a regular canvas. Result encoded back to PNG so Mapbox
			// renders it as a single raster tile. Per-feed failures are
			// tolerated (less common activities often 404 outside dense
			// areas); we only reject if every fetch fails.
			dwRegisterMbLayer(layer, async (z, x, y) => {
				const urls = ACTIVITIES.map((a) =>
					"https://connecttile.garmin.com/" + a + "/" +
					z + "/" + x + "/" + y + ".png");
				const blobs = await Promise.all(urls.map((u) =>
					dwMbGmFetchAB(u)
						.then((ab) => new Blob([ab], { type: "image/png" }))
						.catch(() => null)));
				const bitmaps = await Promise.all(blobs.map((b) =>
					b ? createImageBitmap(b).catch(() => null) : null));
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
	}

	/* -- Polling-data layer scaffold -------------------------------------
	 * Captures the identical L.Layer.extend skeleton used by Flights and
	 * Marine: create a pane, manage a layerGroup, poll on a timer, restart
	 * the timer on map move/zoom (debounced), guard fetches by min zoom.
	 * opts.fetch(map, group, self) does the actual data load + render.
	 */
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
				if (this._group) { this._group.remove(); this._group = null; }
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
			getAttribution() { return opts.attribution; },
		});
	}

	/* -- Live Flights (OpenSky Network) ------------------------------------ */

	class FlightsLayerProvider extends LayerProvider {
		create() {
			const OPENSKY = "https://opensky-network.org/api/states/all";
			const renderStates = (group, states) => {
					group.clearLayers();
					for (const s of states) {
						const lon = s[5],
							lat = s[6];
						if (lon == null || lat == null) continue;
						const callsign = (s[1] || "").trim() || s[0];
						const track = s[10] || 0;
						const onGround = s[8];
						const altM = s[7];
						const speedMs = s[9];
						const country = s[2] || "";
						const altStr =
							altM != null ? Math.round(altM) + "\u202fm" : "\u2014";
						const spdStr =
							speedMs != null
								? Math.round(speedMs * 1.944) + "\u202fkts"
								: "\u2014";
						const fill = onGround ? "#aaa" : "#FFE066";
						const stroke = onGround ? "#666" : "#444";
						const plane =
							`<svg viewBox="0 0 20 20" width="20" height="20" xmlns="http://www.w3.org/2000/svg">` +
							`<g transform="translate(10,10) rotate(${track})">` +
							`<ellipse rx="1.5" ry="7" fill="${fill}" stroke="${stroke}" stroke-width="0.6"/>` +
							`<polygon points="0,-2 -9,4 -8,5.5 0,2 8,5.5 9,4" fill="${fill}" stroke="${stroke}" stroke-width="0.6"/>` +
							`<polygon points="0,5 -4,8 -3.5,9 0,7 3.5,9 4,8" fill="${fill}" stroke="${stroke}" stroke-width="0.6"/>` +
							`</g></svg>`;
						const icon = L.divIcon({
							className: "dw-flight-icon",
							html: plane,
							iconSize: [20, 20],
							iconAnchor: [10, 10],
						});
						L.marker([lat, lon], {
							icon,
							pane: "dwFlightsPane",
							interactive: true,
						})
							.bindTooltip(
								`<b>${callsign}</b><br>Alt: ${altStr}&nbsp; Speed: ${spdStr}<br>${country}`,
								{ className: "dw-flight-tip", sticky: true },
							)
							.addTo(group);
					}
			};

			const FlightsLayer = pollingDataLayer({
				pane: "dwFlightsPane", paneZIndex: 450,
				minZoom: 1, pollMs: 10000,
				attribution: 'Flights \u00a9 <a href="https://opensky-network.org" target="_blank" rel="noreferrer">OpenSky Network</a>',
				fetch: (map, group) => {
					const b = map.getBounds();
					const url = OPENSKY +
						"?lamin=" + b.getSouth().toFixed(3) +
						"&lomin=" + b.getWest().toFixed(3) +
						"&lamax=" + b.getNorth().toFixed(3) +
						"&lomax=" + b.getEast().toFixed(3);
					gmJsonGet(url, (err, data) => {
						if (err || !group._map) return;
						renderStates(group, data.states || []);
					});
				},
			});
			return new FlightsLayer();
		}
	}

	/* -- Marine Traffic ---------------------------------------------------- */

	class MarineTrafficLayerProvider extends LayerProvider {
		create() {
			const MAX_TILES = 25;
			const MT_BASE = "https://www.marinetraffic.com/getData/get_data_json_4";

			function latLonToTile(lat, lon, z) {
				lat = Math.max(-85.0511, Math.min(85.0511, lat));
				const n = Math.pow(2, z);
				const x = Math.floor(((lon + 180) / 360) * n);
				const rad = (lat * Math.PI) / 180;
				const y = Math.floor(
					((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n,
				);
				return {
					x: Math.max(0, Math.min(n - 1, x)),
					y: Math.max(0, Math.min(n - 1, y)),
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
				const svg =
					`<svg viewBox="0 0 14 20" width="14" height="20" xmlns="http://www.w3.org/2000/svg">` +
					`<g transform="translate(7,10) rotate(${v.hdg})">` +
					`<polygon points="0,-9 4.5,8 0,5 -4.5,8" fill="${fill}" stroke="#333" stroke-width="0.7"/>` +
					`</g></svg>`;
				const icon = L.divIcon({ className: "dw-marine-icon", html: svg,
					iconSize: [14, 20], iconAnchor: [7, 10] });
				L.marker([v.lat, v.lon], { icon, pane: "dwMarinePane", interactive: true })
					.bindTooltip(
						`<b>${v.name}</b><br>MMSI: ${v.mmsi}<br>Speed: ${v.spdKts} kts Hdg: ${Math.round(v.hdg)}°`,
						{ className: "dw-marine-tip", sticky: true })
					.addTo(group);
			}

			function renderCluster(group, map, lat, lon, vessels) {
				const count = vessels.length;
				const size = count < 6 ? 22 : count < 21 ? 28 : 36;
				const fontPx = Math.round(size * 0.42);
				const fill = count < 6 ? "#5b9bd5" : count < 21 ? "#2e6a98" : "#1c4870";
				const icon = L.divIcon({
					className: "dw-marine-cluster",
					html: `<div style="background:${fill};color:#fff;width:${size}px;height:${size}px;border-radius:50%;display:flex;align-items:center;justify-content:center;font:bold ${fontPx}px/1 sans-serif;border:2px solid rgba(255,255,255,0.85);box-shadow:0 0 4px rgba(0,0,0,.5);">${count}</div>`,
					iconSize: [size, size], iconAnchor: [size / 2, size / 2],
				});
				const sample = vessels.slice(0, 5).map((v) => v.name).join("<br>");
				const more = vessels.length > 5 ? `<br><i>+${vessels.length - 5} more</i>` : "";
				L.marker([lat, lon], { icon, pane: "dwMarinePane", interactive: true })
					.bindTooltip(
						`<b>${count} vessels</b><br><span class="dw-cad-sub">${sample}${more}</span>`,
						{ className: "dw-marine-tip", sticky: true })
					.on("click", () => {
						map.flyTo([lat, lon],
							Math.min(map.getZoom() + 2, map.getMaxZoom()),
							{ duration: 0.5 });
					})
					.addTo(group);
			}

			function renderRows(group, map, rows) {
				group.clearLayers();
				const pick = (obj, ...keys) => {
					for (const k of keys) {
						const v = obj[k];
						if (v !== undefined && v !== null && v !== "") return v;
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
					const hdg  = parseFloat(pick(v, "HEADING", "heading", "COURSE", "course") || "0") || 0;
					const rawSpd = parseFloat(pick(v, "SPEED", "speed") || "0") || 0;
					const spdKts = rawSpd > 102 ? (rawSpd / 10).toFixed(1) : rawSpd.toFixed(1);
					vessels.push({ lat, lon, name, mmsi, type, hdg, spdKts });
				}
				if (!vessels.length) return;
				// 50px screen-grid clustering — overlapping vessels coalesce into a count badge.
				const CELL_PX = 50;
				const zoom = map.getZoom();
				const cells = new Map();
				for (const v of vessels) {
					const pt = map.project([v.lat, v.lon], zoom);
					const key = Math.floor(pt.x / CELL_PX) + "/" + Math.floor(pt.y / CELL_PX);
					let cell = cells.get(key);
					if (!cell) { cell = { vessels: [], sumLat: 0, sumLon: 0 }; cells.set(key, cell); }
					cell.vessels.push(v);
					cell.sumLat += v.lat;
					cell.sumLon += v.lon;
				}
				for (const cell of cells.values()) {
					if (cell.vessels.length === 1) {
						renderShip(group, cell.vessels[0]);
					} else {
						renderCluster(group, map,
							cell.sumLat / cell.vessels.length,
							cell.sumLon / cell.vessels.length,
							cell.vessels);
					}
				}
			}

			const MTLayer = pollingDataLayer({
				pane: "dwMarinePane", paneZIndex: 440,
				minZoom: 1, pollMs: 20000,
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
					const vessels = new Map();
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
								"Referer": referer,
							},
						}, (err, parsed) => {
							if (err) { done(); return; }
							const raw =
								(parsed.data && parsed.data.rows) ||
								(Array.isArray(parsed.data) ? parsed.data : null) ||
								(Array.isArray(parsed) ? parsed : null);
							if (!Array.isArray(raw)) { done(); return; }
							let rows = raw;
							if (rows.length && Array.isArray(rows[0])) {
								const hdrs = rows[0];
								rows = rows.slice(1).map((row) => {
									const obj = {};
									hdrs.forEach((h, i) => { obj[h] = row[i]; });
									return obj;
								});
							}
							for (const v of rows) {
								const key = v.MMSI || v.mmsi ||
									String(v.LAT || v.lat) + "," + String(v.LON || v.lon);
								if (key && !vessels.has(key)) vessels.set(key, v);
							}
							done();
						});
					}
				},
			});
			return new MTLayer();
		}
	}

	/* -- Geocaching.com (public tile API) -----------------------------------
	 *
	 * Renders caches from Groundspeak's PUBLIC tile-based map endpoints.
	 * No login, no session cookie, no API key. Two endpoints in play:
	 *
	 *   1. `tiles{s}.geocaching.com/map.info?x&y&z` — UTFGrid (Mapbox
	 *      spec): a 64x64 char grid + a keys[] + data{} where each
	 *      non-empty cell encodes a single cache as `{i: GC<code>,
	 *      n: <name>}`. The KEY STRING is itself the cell's grid
	 *      coordinates as `(cx, cy)` — verified by reverse-decoding
	 *      multiple tiles, holds 1966/1966 across the Brisbane z=12
	 *      sample — so we extract position directly from the key
	 *      without scanning the grid string.
	 *
	 *   2. `tiles01.geocaching.com/map.details?i=GC<code>` — per-cache
	 *      detail JSON: difficulty, terrain, container, type id, owner,
	 *      favourite points, archived/available flags. Fetched lazily
	 *      on marker click (avoids one extra HTTP per visible cache on
	 *      load).
	 *
	 * Lat/lng comes from `utfGridCellToLatLng(z, tx, ty, cx, cy)`. Cell
	 * precision = tile/64: z=10 ~600 m, z=12 ~150 m, z=14 ~38 m, z=16
	 * ~10 m. We gate the layer at minZoom=10 (12 visible tiles in a
	 * desktop viewport, ~one round-trip per pan via subdomain rotation)
	 * to keep the request cost predictable.
	 *
	 * Cross-tile deduplication: a cache that straddles two tiles will
	 * appear in both UTFGrids; we key markers by GC code so the second
	 * sighting is a no-op.
	 */
	class GeocachingLayerProvider extends LayerProvider {
		create() {
			const MIN_ZOOM    = 10;
			// Groundspeak's UTFGrid is served at z=10..13 reliably. z=14
			// works only for the densest urban tiles; z=15+ returns 204
			// (the original client over-zoomed z=13 cells on the client
			// side). At zooms above FETCH_MAX_Z we drop to z=13 parent
			// tiles so markers keep rendering as the user zooms in.
			const FETCH_MAX_Z = 13;
			const DEBOUNCE_MS = 500;
			// Visible-tile count is ~viewport_px/256 REGARDLESS of zoom, so
			// a desktop viewport (1600x1000) needs up to ~40 tiles to cover
			// it and even a 1366x768 laptop needs ~28. The cap is purely a
			// runaway-guard for pathological cases (huge external monitor,
			// or fetch-zoom logic regressing); set well above any real
			// viewport. Per-tile UTFGrid cache + 4-way subdomain rotation
			// keep the per-pan request burst reasonable. (Was 16 — far too
			// low; silently rendered nothing at the layer's own MIN_ZOOM.)
			const MAX_TILES   = 64;

			// Type id → single-letter marker glyph + colour. The IDs are
			// Groundspeak's; the labels are picked to fit inside a 20px
			// divIcon. Default falls through to "G" / Traditional green.
			const TYPE_LABELS = {
				2:"T", 3:"M", 8:"?", 5:"L", 6:"E", 11:"C",
				137:"E", 1858:"W", 4:"V", 13:"C",
			};
			const TYPE_COLOR = {
				2:"#1f8e3e", 3:"#fcb900", 8:"#1e3fae",
				5:"#5b2a86", 6:"#d33a3a", 11:"#444",
				137:"#7d5a2a", 1858:"#2aa198",
				4:"#888",    13:"#d33a3a",
			};

			// Cached per-cache details (from map.details) so the second
			// marker click on a cache doesn't re-fetch. Persists across
			// pans because the cache GC codes don't change.
			const detailsCache = new Map();
			// Cached per-tile UTFGrid responses so pan-back doesn't re-
			// fetch. Keyed by "z/x/y" with a soft cap (LRU-ish: oldest
			// drops on overflow).
			const tileCache = new Map();
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
				const lngToTx = (lng) =>
					Math.floor(((lng + 180) / 360) * n);
				const latToTy = (lat) => {
					const r = (lat * Math.PI) / 180;
					return Math.floor(
						((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n,
					);
				};
				const xMin = Math.max(0, lngToTx(b.getWest()));
				const xMax = Math.min(n - 1, lngToTx(b.getEast()));
				const yMin = Math.max(0, latToTy(b.getNorth()));
				const yMax = Math.min(n - 1, latToTy(b.getSouth()));
				const tiles = [];
				for (let x = xMin; x <= xMax; x++) {
					for (let y = yMin; y <= yMax; y++) {
						tiles.push({ z, x, y });
					}
				}
				return tiles;
			}

			// The VISIBLE cache symbols come from Groundspeak's own map.png
			// raster tiles (real per-type icons: traditional chest, mystery
			// '?', earthcache, etc.) draped via an L.tileLayer. The markers
			// built here are TRANSPARENT hit-areas sitting over each icon —
			// they exist only to carry click/hover + the `_dwData` the 3D
			// mirror reads. A ~28px box comfortably covers the PNG icon even
			// with UTFGrid cell quantisation (cell centre is within a few
			// screen px of the true position at z12-13).
			function buildHitIcon() {
				return L.divIcon({
					className: "dw-geo-icon",
					html: `<div style="width:28px;height:28px;` +
						`background:transparent;cursor:pointer;"></div>`,
					iconSize:   [28, 28],
					iconAnchor: [14, 14],
				});
			}

			const GeoLayer = L.Layer.extend({
				initialize() {
					this._group    = null;
					this._tiles    = null;
					this._debounce = null;
					this._gen      = 0;
					this._inflight = new Set();
					this._byCode   = new Map();
				},

				onAdd(map) {
					// Visual tiles sit just below the transparent hit-area
					// markers so a click lands on the marker, not the raster.
					if (!map.getPane("dwGeocachingTilePane")) {
						map.createPane("dwGeocachingTilePane");
						map.getPane("dwGeocachingTilePane").style.zIndex = "440";
					}
					if (!map.getPane("dwGeocachingPane")) {
						map.createPane("dwGeocachingPane");
						map.getPane("dwGeocachingPane").style.zIndex = "445";
					}
					// Groundspeak's rendered cache-icon raster. The <img>
					// requests ALSO warm the server-side tiles, which is what
					// makes the map.info UTFGrid (fetched below) return data.
					// map.png works with any Referer, so a plain L.tileLayer
					// is fine — and it auto-mirrors into 3D as a terrain
					// drape via _syncOverlays.
					this._tiles = L.tileLayer(CFG.GEOCACHING_PUBLIC_PNG, {
						pane:          "dwGeocachingTilePane",
						subdomains:    CFG.GEOCACHING_TILE_SUBDOMAINS,
						minZoom:       MIN_ZOOM,
						maxNativeZoom: FETCH_MAX_Z,
						maxZoom:       22,
						tileSize:      256,
						crossOrigin:   true,
						attribution:   'Caches © <a href="https://www.geocaching.com" target="_blank" rel="noreferrer">Geocaching.com</a>',
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
					this._byCode.clear();
				},

				_onViewChange() { this._fetchSoon(); },

				_fetchSoon() {
					clearTimeout(this._debounce);
					this._debounce =
						setTimeout(() => this._fetch(), DEBOUNCE_MS);
				},

				_fetch() {
					const map = this._map;
					if (!map || !this._group) return;
					if (map.getZoom() < MIN_ZOOM) {
						this._group.clearLayers();
						this._byCode.clear();
						return;
					}

					const myGen = ++this._gen;
					for (const h of this._inflight) gmCancel(h);
					this._inflight.clear();

					const tiles = visibleTiles(map);
					if (tiles.length > MAX_TILES) {
						// Zoomed-out edge case (shouldn't happen with
						// MIN_ZOOM=10 in normal viewports) — bail rather
						// than fan out an unreasonable number of requests.
						return;
					}

					// We rebuild from scratch each pan; cross-tile dedup
					// happens via _byCode which we reset here.
					this._group.clearLayers();
					this._byCode.clear();

					for (const t of tiles) {
						const key = `${t.z}/${t.x}/${t.y}`;
						const cached = tileCache.get(key);
						if (cached) {
							this._renderTile(t, cached);
							continue;
						}
						this._fetchTile(t, myGen, key);
					}
				},

				_fetchTile(t, myGen, key) {
					// allowWarm=true on the first attempt: if the tile is
					// cold (HTTP 204), warm it via a map.png GET and retry
					// map.info ONCE. Warm tiles cost a single request.
					this._getInfo(t, myGen, key, true);
				},

				_tileUrl(template, t) {
					return template
						.replace("{s}", nextSubdomain())
						.replace("{x}", String(t.x))
						.replace("{y}", String(t.y))
						.replace("{z}", String(t.z));
				},

				_getInfo(t, myGen, key, allowWarm) {
					const url = this._tileUrl(CFG.GEOCACHING_PUBLIC_INFO, t);
					const handle = gmJsonGet(url, {
						headers: {
							"Accept":  "application/json",
							"Referer": "https://www.geocaching.com/play/map",
						},
						timeout: 15000,
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
						// HTTP 204 (empty body, gmJsonGet surfaces it as an
						// "http 204" error) means the tile is cold. Warm it
						// once, then retry. Any other error: give up quietly.
						const status = raw && raw.status;
						if (status === 204 && allowWarm) {
							this._warmThenRetry(t, myGen, key);
						}
					});
					this._inflight.add(handle);
				},

				_warmThenRetry(t, myGen, key) {
					// A plain GET of the PNG triggers server-side tile
					// generation (HEAD does not). We discard the image —
					// only the side effect of warming the UTFGrid matters.
					const url = this._tileUrl(CFG.GEOCACHING_PUBLIC_PNG, t);
					const warm = gmGet(url, {
						headers: { "Referer": "https://www.geocaching.com/play/map" },
						timeout: 15000,
					}, () => {
						this._inflight.delete(warm);
						if (myGen !== this._gen || !this._group) return;
						// Retry info regardless of the PNG's HTTP result;
						// allowWarm=false so a still-cold tile doesn't loop.
						this._getInfo(t, myGen, key, false);
					});
					this._inflight.add(warm);
				},

				_renderTile(t, grid) {
					if (!this._group) return;
					if (!grid || !Array.isArray(grid.keys)) return;
					const data = grid.data || {};
					for (const k of grid.keys) {
						if (!k) continue;
						const m = /^\((\d+),\s*(\d+)\)$/.exec(k);
						if (!m) continue;
						const cx = +m[1], cy = +m[2];
						// data[k] is an ARRAY — Groundspeak stacks
						// multiple caches in the same grid cell. Iterate
						// every entry so multi-cache cells all render.
						// Accept the bare-object shape defensively in
						// case the schema flips back.
						const raw = data[k];
						const entries = Array.isArray(raw)
							? raw
							: raw && raw.i ? [raw] : [];
						for (const entry of entries) {
							if (!entry || !entry.i) continue;
							const code = entry.i;
							if (this._byCode.has(code)) continue;

							const [lat, lon] =
								utfGridCellToLatLng(t.z, t.x, t.y, cx, cy);
							const name = entry.n || code;
							// Transparent hit-area; the visible icon is the
							// map.png raster underneath.
							const marker = L.marker([lat, lon], {
								icon: buildHitIcon(),
								pane:        "dwGeocachingPane",
								interactive: true,
							}).bindTooltip(
								`<b>${_escHtml(name)}</b>` +
								`<br><span class="dw-cad-sub">${_escHtml(code)}` +
								` · <i>click for details</i></span>`,
								{ className: "dw-flight-tip", sticky: true },
							);

							// 3D mirror metadata used by Mode3DController to
							// project a clickable dot over the terrain drape.
							// Type/colour fields populate on first details
							// fetch (UTFGrid only carries code + name).
							marker._dwData = {
								kind:  "geocache",
								code,
								name,
								color: TYPE_COLOR[2],
								url:   `https://www.geocaching.com/geocache/${code}`,
							};

							marker.on("click", () => this._onClick(marker, code));
							marker.addTo(this._group);
							this._byCode.set(code, marker);
						}
					}
				},

				_onClick(marker, code) {
					const cached = detailsCache.get(code);
					if (cached) {
						this._applyDetails(marker, code, cached);
						return;
					}
					const url = CFG.GEOCACHING_PUBLIC_DETAILS + code;
					gmJsonGet(url, {
						headers: {
							"Accept":  "application/json",
							"Referer": "https://www.geocaching.com/play/map",
						},
						timeout: 10000,
					}, (err, data) => {
						if (err || !data || data.status !== "success") {
							// Fall through to opening the cache page in
							// the browser — Groundspeak handles archived
							// / private caches with its own UI.
							window.open(
								`https://www.geocaching.com/geocache/${code}`,
								"_blank", "noopener");
							return;
						}
						const row = (data.data && data.data[0]) || null;
						if (!row) return;
						detailsCache.set(code, row);
						this._applyDetails(marker, code, row);
					});
				},

				_applyDetails(marker, code, row) {
					const typeId = (row.type && row.type.value) || 2;
					const color = TYPE_COLOR[typeId] || "#1f8e3e";
					const disabled = !row.available;
					const fill = disabled ? "#888" : color;
					const favs = parseInt(row.fp, 10) || 0;
					// No icon recolour — the visible symbol is the map.png
					// raster. We only enrich the tooltip + the `_dwData` the
					// 3D mirror reads (so the 3D dot picks up the real type
					// colour once a cache has been clicked).

					const name  = row.name || code;
					const diff  = (row.difficulty && row.difficulty.value)
						|| (row.difficulty && row.difficulty.text) || "?";
					const terr  = (row.terrain && row.terrain.value)
						|| (row.terrain && row.terrain.text) || "?";
					const size  = (row.container && row.container.text) || "";
					const owner = (row.owner && row.owner.text) || "";
					const typeText = (row.type && row.type.text) || "";

					marker._dwData = Object.assign(marker._dwData || {}, {
						color: fill, disabled, label: TYPE_LABELS[typeId] || "G",
						diff, terr, size, owner, favs,
						typeText,
					});

					if (marker.setTooltipContent) {
						marker.setTooltipContent(
							`<b>${_escHtml(name)}</b>` +
							(disabled ? " <i>(disabled)</i>" : "") +
							`<br><span class="dw-cad-sub">` +
							`${_escHtml(code)} · D ${diff} / T ${terr}` +
							(size ? " · " + _escHtml(String(size)) : "") +
							(favs ? ` · ♥ ${favs}` : "") +
							(typeText ? " · " + _escHtml(typeText) : "") +
							(owner ? "<br>by " + _escHtml(owner) : "") +
							`</span>`);
					}

					// Always open the cache page on click — detail-fetch
					// path is purely for the enriched tooltip / icon.
					window.open(
						`https://www.geocaching.com/geocache/${code}`,
						"_blank", "noopener");
				},

				getAttribution() {
					return 'Caches © <a href="https://www.geocaching.com" target="_blank" rel="noreferrer">Geocaching.com</a>';
				},
			});

			return new GeoLayer();
		}
	}

	/* -- Mobile Coverage Layer --------------------------------------------- */

	// ACCC Mobile Sites and Coverages (national AU). Sublayer 2 = "All
	// Network Operators 4G Outdoor Mobile Coverage".
	// maxNativeZoom 18: ACCC's grid is ~100 m cells, finer queries return
	// the same blocky pixels — let Leaflet stretch z=18 instead.
	const MobileCoverageLayerProvider = arcgisExportProvider({
		baseUrl: CFG.ACCC_MOBILE_COVERAGE_SERVICE,
		showLayers: "2", pane: "dwMobilePane", paneZIndex: 380,
		opacity: 0.5, minZoom: 5, maxNativeZoom: 18, maxZoom: 25,
		attribution: 'Mobile coverage © <a href="https://data.gov.au" target="_blank" rel="noreferrer">ACCC / Dept. of Infrastructure</a>',
	});


	/* -- QLD Topo basemap ------------------------------------------------- */

	// Deep-zoom-eligible base; maxZoom 25 (vs native 16) lets Leaflet stretch.
	const QldTopoLayerProvider = tileProvider(CFG.QLD_TOPO_TILE, {
		maxNativeZoom: 16, maxZoom: 25,
		attribution: "&copy; State of Queensland (Department of Resources)",
	});

	/* -- Hover-identify factory ------------------------------------------
	 *
	 * Both Cadastre and QPWS overlays share the same hover-identify shape:
	 * debounced mousemove → ArcGIS /identify call → render attrs into a
	 * Leaflet tooltip, drop stale callbacks via a generation counter, and
	 * clear on map mouseout. This factory captures that pattern and lets
	 * each layer plug in a custom tolerance, sublayer filter, formatter,
	 * and (optionally) an `afterRender` hook for async enrichment (e.g.
	 * Cadastre's address + Sales link).
	 *
	 * Returns: install(layer, map). Cleans up via layer._dwHoverOff.
	 */
	function makeHoverIdentify(opts) {
		const debounceMs = opts.debounceMs || 200;
		return function install(layer, map) {
			const tooltip = L.tooltip({
				sticky:    true,
				opacity:   0.95,
				className: opts.tipClass,
				direction: "right",
				offset:    [12, 0],
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
				const size  = map.getSize();
				const b     = map.getBounds();
				const mapExtent    = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].join(",");
				const imageDisplay = `${size.x},${size.y},96`;
				const geometry = encodeURIComponent(JSON.stringify({
					x: latlng.lng, y: latlng.lat, spatialReference: { wkid: 4326 },
				}));
				const myGen = ++gen;
				const url =
					`${opts.baseUrl}/identify` +
					`?geometry=${geometry}` +
					`&geometryType=esriGeometryPoint&sr=4326` +
					`&layers=${opts.layers}` +
					`&tolerance=${opts.tolerance || 3}` +
					`&mapExtent=${mapExtent}` +
					`&imageDisplay=${imageDisplay}` +
					`&returnGeometry=false&f=json`;
				gmJsonGet(url, (err, data) => {
					if (err) return;
					if (myGen !== gen) return;
					const feat = (data.results || [])[0];
					if (!feat) { clearTip(); return; }
					const attrs = feat.attributes || {};
					const oid =
						attrs["Object ID"] || attrs.OBJECTID || JSON.stringify(attrs);
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
							// Guard so an async enrichment doesn't overwrite the
							// tooltip after the user has moved to another parcel.
							isCurrent: () =>
								myGen === gen && !!tooltip._map && lastAttrs === attrs,
							setContent: (html) => tooltip.setContent(html),
						});
					}
				});
			};

			const onMove = (e) => {
				if (map.getZoom() < opts.minZoom) { clearTip(); return; }
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
			map.on("mouseout",  onLeave);

			layer._dwHoverOff = () => {
				clearTimeout(debounce);
				gen++;
				map.off("mousemove", onMove);
				map.off("mouseout",  onLeave);
				clearTip();
			};
		};
	}

	/* -- QLD Cadastre + OnTheHouse Sales ----------------------------------
	 * Cadastre hover-identify renders a tooltip with a "Sales ↗" link;
	 * clicking it fires the OnTheHouse fetch pipeline + opens a popup.
	 * `installCadastreHover` is the entry point that wires both.
	 */

	// Filters out QLD's "Null" sentinel strings and genuinely empty values.
	function _cadVal(v) {
		if (v === null || v === undefined) return "";
		const s = String(v).trim();
		return s && s !== "Null" ? s : "";
	}

	// addressInfo is optional: { primary, extra } — primary is the headline
	// address line, extra is a "+N more" hint when several addresses exist
	// for the same lotplan (rural blocks with multiple dwellings, strata).
	function _formatCadastreTooltip(attrs, addressInfo) {
		const lotPlan =
			_cadVal(attrs["Lot/plan"]) ||
			(_cadVal(attrs.Lot) && _cadVal(attrs.Plan)
				? attrs.Lot + attrs.Plan
				: "");
		const lines = [];
		if (lotPlan) lines.push(`<b>${lotPlan}</b>`);

		const name  = _cadVal(attrs.Name);
		const alias = _cadVal(attrs.Alias);
		if (name)                  lines.push(name);
		else if (alias)            lines.push(alias);

		if (addressInfo && addressInfo.primary) {
			let addrLine = addressInfo.primary;
			if (addressInfo.extra) addrLine += ` <span class="dw-cad-sub">${addressInfo.extra}</span>`;
			lines.push(addrLine);
		}

		const bits = [];
		const tenure = _cadVal(attrs.Tenure);
		if (tenure) bits.push(tenure);
		const parcelType = _cadVal(attrs["Parcel type"]);
		// Skip the redundant "Lot" parcel type — tenure already implies it.
		if (parcelType && parcelType.toLowerCase() !== "lot") bits.push(parcelType);
		const area = parseFloat(attrs["Lot area (m²)"]);
		if (isFinite(area) && area > 0) {
			bits.push(
				area >= 10000
					? (area / 10000).toFixed(2) + " ha"
					: Math.round(area) + " m²",
			);
		}
		if (bits.length) lines.push(bits.join(" · "));

		const locality = _cadVal(attrs.Locality);
		const lga      = _cadVal(attrs["Local authority"]);
		if (locality) lines.push(locality);
		if (lga)      lines.push(`<span class="dw-cad-sub">${lga}</span>`);

		const links = [];
		const smis = _cadVal(attrs["SmartMap link"]);
		if (smis && /^https?:\/\//i.test(smis)) {
			links.push(
				`<a class="dw-cad-link" href="${smis}" target="_blank" rel="noreferrer">SmartMap ↗</a>`,
			);
		}
		// Only offer the OTH sales lookup once we have a numbered street
		// address — OTH's /odin/api/locations search only resolves to a
		// propertyId when we feed it both a street number and a street
		// name. Lat/lon is also required so the popup can anchor.
		if (
			addressInfo &&
			isFinite(addressInfo.lat) &&
			isFinite(addressInfo.lon) &&
			addressInfo.streetName &&
			addressInfo.streetNumber
		) {
			links.push(
				`<a class="dw-cad-link dw-cad-sales-link" href="#"` +
				` data-lat="${addressInfo.lat}" data-lon="${addressInfo.lon}"` +
				` data-lotplan="${(_cadVal(attrs["Lot/plan"]) || "").replace(/"/g, "&quot;")}"` +
				`>Sales ↗</a>`,
			);
		}
		if (links.length) lines.push(links.join(" &nbsp; "));

		return lines.join("<br>") || "Parcel";
	}

	/* -- Sales popup orchestration ---------------------------------------- */

	// One-time delegated click handler installed when the cadastre layer is
	// first attached. Catches clicks on the tooltip's "Sales ↗" link and
	// drives the two-stage OnTheHouse lookup, rendering results into a
	// Leaflet popup at the parcel location.
	let _dwSalesHookInstalled = false;
	let _dwSalesMap = null;
	let _dwSalesGen = 0;

	function _escHtml(s) {
		return String(s == null ? "" : s)
			.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;");
	}

	function _fmtPrice(n) {
		if (!isFinite(n) || n <= 0) return "";
		if (n >= 1e6) return "$" + (n / 1e6).toFixed(n % 1e6 ? 2 : 1) + "M";
		if (n >= 1e3) return "$" + Math.round(n / 1e3) + "k";
		return "$" + n;
	}

	function _fmtDate(s) {
		if (!s) return "";
		// "2021-07-21T..." → "Jul 2021"
		const m = /^(\d{4})-(\d{2})/.exec(String(s));
		if (!m) return String(s);
		const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
		return months[parseInt(m[2], 10) - 1] + " " + m[1];
	}

	function _renderSalesContent(result) {
		if (!result || !result.property) {
			const fallback = result && result.fallbackUrl
				? `<div class="dw-sales-row"><a href="${_escHtml(result.fallbackUrl)}" target="_blank" rel="noreferrer">Open OnTheHouse search ↗</a></div>`
				: "";
			return `<div class="dw-sales-pop">
				<div class="dw-sales-err">${_escHtml((result && result.error) || "No sales data.")}</div>
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
		const statsLine = stats.length
			? `<div class="dw-sales-stats">${stats.join(" · ")}${p.type ? ` <span class="dw-sales-sub">${_escHtml(p.type)}</span>` : ""}</div>`
			: "";

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

		// Sale events history (only "SoldEvent" type, last 6, oldest at bottom).
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

		const lotplan = (p.legalAttributes && p.legalAttributes["Lot/Plan"]) || "";
		const lotBlock = lotplan
			? `<div class="dw-sales-row"><span class="dw-sales-k">Lot/Plan</span><span class="dw-sales-v">${_escHtml(lotplan)}</span></div>`
			: "";

		const sourceLink = result.sourceUrl
			? `<a class="dw-sales-source" href="${_escHtml(result.sourceUrl)}" target="_blank" rel="noreferrer">Open on OnTheHouse ↗</a>`
			: "";

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
			className: "dw-sales-pop-wrap",
		})
			.setLatLng(latlng)
			.setContent(`<div class="dw-sales-pop"><div class="dw-sales-loading">Loading OnTheHouse data…</div></div>`)
			.openOn(map);

		const gen = ++_dwSalesGen;

		const finish = (result) => {
			if (gen !== _dwSalesGen) return;
			if (!popup.isOpen()) return;
			popup.setContent(_renderSalesContent(result));
		};

		// Cache the assembled popup model by lotplan in GM storage so a
		// re-hover on the same parcel hours later renders instantly. The
		// underlying OTH endpoints are themselves cached at finer grain
		// (locations / property / events) — this is the user-facing layer.
		if (!lotplan) { fetchOthSales(addrInfo, finish); return; }
		cachedFetch(
			"oth_sales_" + lotplan,
			_CACHE_TTL.OTH_PROPERTY,
			(done) => fetchOthSales(addrInfo, (result) => {
				// Don't persist transient network failures — only cache
				// definitive results (ok:true or ok:false with a structural
				// reason like "address not indexed").
				const persistable =
					result && (result.ok === true ||
					           (result.ok === false && !/rate-limit|status \d{3}/.test(result.error || "")));
				done(null, persistable ? result : null);
				if (!persistable) finish(result); // surface transient errors immediately
			}),
			(err, cached) => { if (cached) finish(cached); },
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
		// Address wasn't pre-resolved by hover (user clicked too fast or
		// the cache was wiped) — fetch on demand, then open the popup.
		fetchCadastreAddress(lotplan, (info) => {
			if (!info) return;
			_openSalesPopup(L.latLng(lat, lon), info, lotplan);
		});
	}

	function _ensureSalesHook(map) {
		_dwSalesMap = map;
		if (_dwSalesHookInstalled) return;
		_dwSalesHookInstalled = true;
		// Capture-phase so we intercept before the underlying map gets the
		// click and tries to drop a waypoint at that location.
		document.addEventListener("click", _onSalesLinkClick, true);
	}

	function _formatAddressLine(rec) {
		if (!rec) return "";
		// Query results are keyed by field name, not alias.
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
		if (!lotplan) { cb(null); return; }
		cachedFetch(
			"cad_addr_" + lotplan,
			_CACHE_TTL.CAD_ADDRESS,
			(done) => {
				const url =
					`${CFG.QLD_CADASTRE_SERVICE}/0/query` +
					`?where=${encodeURIComponent(`lotplan='${lotplan.replace(/'/g, "''")}'`)}` +
					`&outFields=street_full,unit_number,unit_type,property_name,` +
						`street_number,street_name,street_type,locality,latitude,longitude` +
					`&returnGeometry=false&f=json`;
				gmJsonGet(url, (err, data) => {
					if (err) { done(null, null); return; }
					const feats = (data.features || []).map((f) => f.attributes || {});
					const primaryRec =
						feats.find((a) => (a.street_full || "").trim()) || feats[0];
					const primary = _formatAddressLine(primaryRec);
					if (!primary) { done(null, null); return; }
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
						locality: (primaryRec.locality || "").trim(),
					});
				});
			},
			(err, info) => cb(err ? null : info),
		);
	}

	// Public probe (no fetch) — used by the hover tooltip to render an
	// address line synchronously if one was previously resolved.
	function getCachedCadastreAddress(lotplan) {
		if (!lotplan) return null;
		try {
			const raw = GM_getValue("dw_cache_cad_addr_" + lotplan, null);
			if (!raw) return null;
			const parsed = JSON.parse(raw);
			if (!parsed || (parsed.e !== 0 && parsed.e <= Date.now())) return null;
			return parsed.v || null;
		} catch (_) { return null; }
	}

	/* -- OnTheHouse sales lookup (click-triggered from cadastre tooltip) ---
	 *
	 *  Stage 1: resolve the address → propertyId via OTH's address
	 *           autocomplete endpoint `/odin/api/locations?query=…`. Tiny
	 *           JSON response, cached for a week. Found in OTH's main.js
	 *           as the `addressSearchSagas` target.
	 *  Stage 2: pull `/odin/api/properties/{id}` (core attributes) and
	 *           `/odin/api/properties/{id}/events` (sales timeline) in
	 *           parallel — about 5 KB combined, vs ~5 MB for the SSR HTML
	 *           we previously scraped. Cached per propertyId (6 h for core,
	 *           24 h for events).
	 *
	 *  Caching uses the shared `cachedFetch` helper (GM_setValue-backed,
	 *  with TTLs in _CACHE_TTL). The api-gateway-alb.*.corelogic.io
	 *  endpoints these reach are CORS-locked from browser JS but reachable
	 *  via GM_xmlhttpRequest's privileged bypass.
	 */

	// (Persistent sales-popup caching lives in cachedFetch — see _openSalesPopup.)

	function _slugify(s) {
		return String(s || "")
			.toLowerCase()
			.replace(/&/g, " and ")
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "");
	}

	// Map QLD's long-form street types to OnTheHouse's short slug form.
	// Unknown types pass through slugified — OTH's URL routing is lenient
	// enough that a near-miss still returns the fallback list, which is
	// all we need to discover the focal property's othPropertyId.
	const _OTH_STREET_TYPE = {
		STREET: "st", ROAD: "rd", AVENUE: "ave", DRIVE: "dr", LANE: "la",
		CRESCENT: "cres", PLACE: "pl", TERRACE: "tce", COURT: "ct",
		BOULEVARD: "bvd", BOULEVARDE: "bvd", CIRCUIT: "cct",
		HIGHWAY: "hwy", PARADE: "pde", CLOSE: "cl", WAY: "way",
		ESPLANADE: "esp", QUAY: "qy", CIRCLE: "cir", LINK: "lnk",
		MEWS: "mews", SQUARE: "sq", WALK: "wlk", ARCADE: "arc",
		ALLEY: "al", ROW: "row", VIEW: "vw", RIDGE: "rdge", RISE: "ri",
		BEND: "bend", LOOP: "loop", TRACK: "trk", TRAIL: "trl",
	};

	function _othStreetTypeSlug(type) {
		const up = String(type || "").trim().toUpperCase();
		return _OTH_STREET_TYPE[up] || _slugify(type);
	}

	// Canonical OTH property URL — used only as the "Open on OnTheHouse ↗"
	// link in the sales popup (we get the data itself via the JSON
	// endpoints). Built from the locations API's authoritative fields so
	// it always lands on a valid focal-property page. Example:
	//   /property/qld/petrie-terrace-4000/256-petrie-tce-petrie-terrace-qld-4000-14995257
	function _othCanonicalUrlFromLocation(loc) {
		const suburbSlug = _slugify(loc.suburb);
		const streetSlug = _slugify(
			`${loc.streetNumber} ${loc.streetName} ${_othStreetTypeSlug(loc.streetType)}`,
		);
		const tail = `${streetSlug}-${suburbSlug}-qld-${loc.postCode}`;
		return `${CFG.OTH_BASE}/property/qld/${suburbSlug}-${loc.postCode}/${tail}-${loc.propertyId}`;
	}

	// OTH's address autocomplete endpoint. Returns up to 10 candidates
	// keyed by free-text query — discovered in OTH's main.js as the
	// `addressSearchSagas` target. Street-level placeholder rows (like
	// { propertyId: "NAMBOUR+QLD+4560+ERBACHER+RD", streetNumber: "" })
	// share the response and are filtered out by callers that require a
	// numeric propertyId. Cached for a week — autocomplete suggestions
	// don't change meaningfully on shorter timescales.
	function fetchOthLocations(query, cb) {
		cachedFetch(
			"oth_loc_" + query.toLowerCase().replace(/\s+/g, "_"),
			_CACHE_TTL.OTH_LOCATIONS,
			(done) => {
				const url =
					`${CFG.OTH_BASE}/odin/api/locations?query=` + encodeURIComponent(query);
				gmJsonGet(url, (err, data, raw) => {
					if (err) { done(null, { error: err.message, status: raw && raw.status }); return; }
					done(null, { content: Array.isArray(data.content) ? data.content : [] });
				});
			},
			(_err, result) => cb(result || { error: "cache miss" }),
		);
	}

	// Resolve a parcel's address to an OTH property and pull its detail.
	// Three API calls (each tiny JSON, cached aggressively):
	//   1. /odin/api/locations?query=…       → candidate list with propertyIds
	//   2. /odin/api/properties/{id}         → core attributes + lastSale
	//   3. /odin/api/properties/{id}/events  → sales/listings history timeline
	//
	// Steps 2+3 fire in parallel. The combined object matches the shape
	// `_renderSalesContent` expects (events merged into the property).
	//
	// Calls cb(result) with:
	//   { ok: true,  property, sourceUrl }   — focal property data
	//   { ok: false, error }                 — couldn't resolve
	function fetchOthSales(addrInfo, cb) {
		if (!addrInfo.streetNumber) {
			cb({
				ok: false,
				error: "This parcel has no street number in QLD's cadastre — OnTheHouse can't look it up.",
			});
			return;
		}

		// Build the autocomplete query. Suburb + state disambiguate same-
		// named streets in other states; postcode is harmless if present.
		const qParts = [];
		if (addrInfo.streetNumber) qParts.push(addrInfo.streetNumber);
		if (addrInfo.streetName)   qParts.push(addrInfo.streetName);
		if (addrInfo.streetType)   qParts.push(addrInfo.streetType);
		if (addrInfo.locality)     qParts.push(addrInfo.locality);
		qParts.push("QLD");
		const query = qParts.join(" ").trim();

		fetchOthLocations(query, (locResult) => {
			if (locResult && locResult.error) {
				cb({
					ok: false,
					error: locResult.status === 429
						? "OnTheHouse is rate-limiting us — try again in a minute."
						: `Couldn't reach OnTheHouse (${locResult.error}).`,
				});
				return;
			}

			// Filter to candidates with a numeric propertyId (real
			// property, not the street-level "ERBACHER+RD+NAMBOUR"
			// placeholder rows). Prefer exact street-number + name match.
			const candidates = (locResult.content || []).filter(
				(p) => p && /^\d+$/.test(String(p.propertyId || "")),
			);
			const wantNum  = String(addrInfo.streetNumber || "").toUpperCase();
			const wantName = String(addrInfo.streetName   || "").toUpperCase();
			const match =
				candidates.find(
					(p) =>
						String(p.streetNumber || "").toUpperCase() === wantNum &&
						String(p.streetName   || "").toUpperCase() === wantName,
				) ||
				candidates.find(
					(p) => String(p.streetNumber || "").toUpperCase() === wantNum,
				) ||
				candidates[0];

			if (!match) {
				cb({
					ok: false,
					error: "OnTheHouse doesn't have a record for this address.",
				});
				return;
			}

			const pid = match.propertyId;
			const sourceUrl = _othCanonicalUrlFromLocation(match);

			// Stage 2: fetch property core + events in parallel.
			let coreRes = null, eventsRes = null, done = false;
			const finish = () => {
				if (done) return;
				if (coreRes === null || eventsRes === null) return;
				done = true;
				if (coreRes.error) {
					cb({
						ok: false,
						error: "Couldn't fetch OnTheHouse property data.",
						fallbackUrl: sourceUrl,
					});
					return;
				}
				const property = Object.assign({}, coreRes.data, {
					events: (eventsRes.data && eventsRes.data.content) || [],
				});
				cb({ ok: true, property, sourceUrl });
			};

			cachedFetch(
				"oth_prop_" + pid,
				_CACHE_TTL.OTH_PROPERTY,
				(d) => gmJsonGet(
					`${CFG.OTH_BASE}/odin/api/properties/${pid}`,
					(err, data) => d(null, err ? { error: err.message } : { data }),
				),
				(_e, r) => { coreRes = r || { error: "cache miss" }; finish(); },
			);
			cachedFetch(
				"oth_evt_" + pid,
				_CACHE_TTL.OTH_EVENTS,
				(d) => gmJsonGet(
					`${CFG.OTH_BASE}/odin/api/properties/${pid}/events`,
					(err, data) => d(null, err ? { error: err.message } : { data }),
				),
				(_e, r) => { eventsRes = r || { error: "cache miss" }; finish(); },
			);
		});
	}

	const _installCadastreHoverInner = makeHoverIdentify({
		baseUrl:    CFG.QLD_CADASTRE_SERVICE,
		layers:     "all:" + CFG.QLD_CADASTRE_IDENTIFY_LAYER,
		tolerance:  3,
		minZoom:    CFG.QLD_CADASTRE_HOVER_MIN_ZOOM,
		debounceMs: 180,
		tipClass:   "dw-cad-tip",
		formatTooltip: (attrs) => {
			const lotplan = _cadVal(attrs["Lot/plan"]);
			return _formatCadastreTooltip(attrs, getCachedCadastreAddress(lotplan));
		},
		afterRender: (attrs, ctx) => {
			const lotplan = _cadVal(attrs["Lot/plan"]);
			if (!lotplan) return;
			if (getCachedCadastreAddress(lotplan)) return; // already rendered
			fetchCadastreAddress(lotplan, (info) => {
				if (!info || !ctx.isCurrent()) return;
				ctx.setContent(_formatCadastreTooltip(attrs, info));
			});
		},
	});

	function installCadastreHover(layer, map) {
		_ensureSalesHook(map);
		_installCadastreHoverInner(layer, map);
	}

	const QldCadastreLayerProvider = arcgisExportProvider({
		baseUrl: CFG.QLD_CADASTRE_SERVICE,
		showLayers: String(CFG.QLD_CADASTRE_LAYER_ID),
		pane: "dwCadastrePane", paneZIndex: 385,
		opacity: 0.75, minZoom: 11, maxZoom: 25,
		attribution: 'Cadastre &copy; <a href="https://www.qld.gov.au/dnrme" target="_blank" rel="noreferrer">State of Queensland (DCDB)</a>',
		onAdd: (layer, map) => installCadastreHover(layer, map),
		onRemove: (layer) => {
			if (layer._dwHoverOff) { layer._dwHoverOff(); layer._dwHoverOff = null; }
		},
	});

	/* -- QPWS Estate (QLD Parks & Wildlife) ------------------------------- */

	// Hover-identify for QPWS — protected-area name + manage type from
	// sublayer 10. Tooltip-only, no async enrichment, so the factory's
	// afterRender hook is unused.
	const installQpwsHover = makeHoverIdentify({
		baseUrl:    CFG.QLD_QPWS_SERVICE,
		layers:     "all:10",
		tolerance:  5,
		minZoom:    CFG.QLD_QPWS_HOVER_MIN_ZOOM,
		tipClass:   "dw-qpws-tip",
		formatTooltip: (a) => {
			const name = a.NAME || a.name || a.PARK_NAME || a.park_name || "";
			const type = a.FEAT_TYPE || a.feat_type || a.MANAGE_TYPE || a.manage_type || "";
			const lines = [];
			if (name) lines.push(`<b>${name}</b>`);
			if (type) lines.push(type);
			return lines.join("<br>") || "Protected area";
		},
	});

	// Server-rendered tile overlay covering protected areas, walking tracks,
	// great walks, horse/MTB/trail-bike trails. Same ArcGIS export pattern as
	// Cadastre/MobileCoverage. Suppressed below zoom 9 — the polygons
	// dominate the view at small scales and the trails aren't visible
	// anyway.
	const QpwsLayerProvider = arcgisExportProvider({
		baseUrl: CFG.QLD_QPWS_SERVICE,
		showLayers: CFG.QLD_QPWS_LAYER_IDS,
		pane: "dwQpwsPane", paneZIndex: 396,
		opacity: 0.85, minZoom: 9, maxZoom: 25,
		attribution: 'QPWS &copy; <a href="https://parks.qld.gov.au/" target="_blank" rel="noreferrer">State of Queensland (DETSI)</a>',
		onAdd: (layer, map) => installQpwsHover(layer, map),
		onRemove: (layer) => {
			if (layer._dwHoverOff) { layer._dwHoverOff(); layer._dwHoverOff = null; }
		},
	});

	/* -- OpenSeaMap -------------------------------------------------------- */

	// Public transparent overlay tiles — nautical seamarks (buoys, lights,
	// lanes, harbour features). No key required, polite to cache.
	const OpenSeaMapLayerProvider = tileProvider(
		CFG.OPENSEAMAP_TILE,
		{ maxNativeZoom: 18, maxZoom: 25,
		  attribution: '&copy; <a href="https://www.openseamap.org/" target="_blank" rel="noreferrer">OpenSeaMap</a> contributors' },
	);

	/* -- OpenInfraMap shared helpers -------------------------------------- */

	// Shared svg-circle-with-glyph icon used by Power, Telecoms, Water.
	// `className` is the only meaningful per-layer variant (CSS hook).
	function oimIcon(className, glyph, fill, size) {
		size = size || 15;
		return L.divIcon({
			className,
			html: `<svg viewBox="0 0 16 16" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">` +
				  `<circle cx="8" cy="8" r="6.5" fill="${fill}" stroke="#222" stroke-width="1" opacity="0.92"/>` +
				  `<text x="8" y="11.5" text-anchor="middle" font-size="9" font-family="sans-serif" fill="#fff">${glyph}</text>` +
				  `</svg>`,
			iconSize: [size, size], iconAnchor: [size / 2, size / 2],
		});
	}

	/* -- Power Infrastructure (OpenInfraMap vector tiles) ---------------- */

	// Transmission/distribution lines, substations, power plants and generator
	// farms, sourced straight from OpenInfraMap's global power vector tiles
	// (the same data its own map renders) rather than live Overpass queries —
	// CDN-served and reliable. Tiles for the view are decoded, projected, and
	// fed to the same voltage-coloured renderer the Overpass version used.
	class PowerInfraLayerProvider extends LayerProvider {
		create() {
			// Format raw OSM voltage (stored in V) as human-readable kV/V.
			function fmtVoltage(v) {
				const n = parseInt(v, 10) || 0;
				if (!n) return null;
				if (n >= 1000) {
					const kv = n / 1000;
					return (Number.isInteger(kv) ? kv : kv.toFixed(1)) + " kV";
				}
				return n + " V";
			}

			function lineColor(voltageStr) {
				const v = parseInt(voltageStr, 10) || 0;
				if (v >= 300000) return "#D9534F";  // ≥300 kV: backbone transmission
				if (v >= 100000) return "#F0A500";  // 100–299 kV: sub-transmission
				if (v >=  33000) return "#FFD93D";  // 33–99 kV: HV distribution
				if (v >       0) return "#9CCC65";  // <33 kV: LV distribution
				return "#aaa";
			}

			function lineWeight(power, voltageStr) {
				const v = parseInt(voltageStr, 10) || 0;
				if (power === "line") return v >= 300000 ? 3 : v >= 100000 ? 2.5 : 2;
				if (power === "cable") return 1.6;
				return 1.2; // minor_line
			}

			const pointIcon = (g, f, s) => oimIcon("dw-infra-icon", g, f, s || 16);

			// OpenInfraMap stores voltage in kV and output in MW; the renderer
			// (and lineColor/fmtVoltage) expect OSM-style volts, so convert.
			function kvToV(v) {
				const x = parseFloat(v);
				return x ? String(Math.round(x * 1000)) : "";
			}
			function fmtMW(v) {
				const x = parseFloat(v);
				if (!x) return "";
				return (Number.isInteger(x) ? x
					: (x < 10 ? x.toFixed(2) : x.toFixed(1))) + " MW";
			}

			return makeVectorTileLayer({
				label:         "PowerInfra",
				pane:          "dwInfraPane",
				paneZIndex:    410,
				minZoom:       9,   // show major transmission lines from z9
				padBounds:     0.1,
				maxNativeZoom: CFG.OIM_MAX_NATIVE_Z,
				attribution:   'Power data © <a href="https://openinframap.org/" target="_blank" rel="noreferrer">OpenInfraMap</a> / <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>',
				tileUrl: (z, x, y) => `${CFG.OIM_POWER_TILES}/${z}/${x}/${y}.pbf`,

				// Map OpenInfraMap's power layers into the element shape the
				// renderer below consumes. Individual generator points
				// (power_generator — every solar panel, thousands per tile) and
				// towers are intentionally skipped; generator *areas* (farms) are
				// kept. Substations/plants ship as both a polygon and a centroid
				// point — both carry a shared `_id` so the factory keeps the
				// polygon and drops the redundant point.
				toElements: (layerName, p, gtype, rings) => {
					if (p.disused) return null;
					if (layerName === "power_line") {
						const t = p.type;
						const power = t === "cable" ? "cable"
							: t === "minor_line" ? "minor_line" : "line";
						const tags = { power, voltage: kvToV(p.voltage),
							name: p.name, operator: p.operator, ref: p.ref };
						return rings.map((r) => ({ type: "way", geometry: r, tags }));
					}
					if (layerName === "power_substation") {
						const tags = { power: "substation", voltage: kvToV(p.voltage),
							name: p.name, operator: p.operator };
						return rings.map((r) => ({ type: "way", geometry: r, tags,
							_id: "sub/" + p.osm_id }));
					}
					if (layerName === "power_substation_point") {
						const r = rings[0]; if (!r || !r.length) return null;
						return [{ type: "node", lat: r[0].lat, lon: r[0].lon,
							_id: "sub/" + p.osm_id, tags: { power: "substation",
								voltage: kvToV(p.voltage), name: p.name,
								operator: p.operator } }];
					}
					if (layerName === "power_plant") {
						const tags = { power: "plant", "plant:source": p.source,
							"plant:output:electricity": fmtMW(p.output),
							name: p.name, operator: p.operator };
						return rings.map((r) => ({ type: "way", geometry: r, tags,
							_id: "plant/" + p.osm_id }));
					}
					if (layerName === "power_plant_point") {
						const r = rings[0]; if (!r || !r.length) return null;
						return [{ type: "node", lat: r[0].lat, lon: r[0].lon,
							_id: "plant/" + p.osm_id, tags: { power: "plant",
								"plant:source": p.source,
								"plant:output:electricity": fmtMW(p.output),
								name: p.name, operator: p.operator } }];
					}
					if (layerName === "power_generator_area") {
						const tags = { power: "generator",
							"generator:source": p.source,
							"generator:output:electricity": fmtMW(p.output),
							name: p.name, operator: p.operator };
						return rings.map((r) => ({ type: "way", geometry: r, tags }));
					}
					return null; // power_generator (points), power_tower, …
				},

				render: (group, elements, zoom) => {
					for (const el of elements) {
						const tags  = el.tags || {};
						const power = tags.power;
						if (!power) continue;
						const geom  = el.geometry || [];

						// ----- overhead / underground lines -----
						if (el.type === "way" && geom.length &&
							(power === "line" || power === "minor_line" || power === "cable")) {
							const latlngs = geom.map(g => [g.lat, g.lon]);
							const color   = lineColor(tags.voltage);
							const weight  = lineWeight(power, tags.voltage);
							const vLabel  = fmtVoltage(tags.voltage);
							const tip =
								`<b>${vLabel || (power === "cable" ? "Underground cable" : "Power line")}</b>` +
								(tags.name     ? `<br>${tags.name}` : "") +
								(tags.operator ? `<br>${tags.operator}` : "") +
								(tags.ref      ? `<br>Ref: ${tags.ref}` : "");
							// Dark casing first (non-interactive) for visibility on any basemap
							L.polyline(latlngs, {
								pane: "dwInfraPane", color: "#222",
								weight: weight + 2.5, opacity: 0.35, interactive: false,
							}).addTo(group);
							L.polyline(latlngs, {
								pane: "dwInfraPane", color,
								weight, opacity: 0.92,
								dashArray: power === "cable" ? "6 4" : null,
							}).bindTooltip(tip, { className: "dw-infra-tip", sticky: true })
							  .addTo(group);
							continue;
						}

						// ----- substation / plant polygons -----
						if (el.type === "way" && geom.length &&
							(power === "substation" || power === "plant")) {
							const latlngs = geom.map(g => [g.lat, g.lon]);
							const isPlant = power === "plant";
							const fill    = isPlant ? "#9B59B6" : "#F0A500";
							const vLabel  = fmtVoltage(tags.voltage);
							const tip =
								`<b>${tags.name || (isPlant ? "Power plant" : "Substation")}</b>` +
								(vLabel                           ? `<br>${vLabel}` : "") +
								(tags.operator                    ? `<br>${tags.operator}` : "") +
								(tags["plant:source"]             ? `<br>Source: ${tags["plant:source"]}` : "") +
								(tags["plant:output:electricity"] ? `<br>Output: ${tags["plant:output:electricity"]}` : "");
							L.polygon(latlngs, {
								pane: "dwInfraPane", color: fill, weight: 1.5,
								opacity: 0.9, fillColor: fill, fillOpacity: 0.2,
							}).bindTooltip(tip, { className: "dw-infra-tip", sticky: true })
							  .addTo(group);
							continue;
						}

						// ----- solar farm polygons -----
						if (el.type === "way" && geom.length &&
							power === "generator" && tags["generator:source"] === "solar") {
							const latlngs = geom.map(g => [g.lat, g.lon]);
							const tip =
								`<b>${tags.name || "Solar farm"}</b>` +
								(tags["generator:output:electricity"] ? `<br>Output: ${tags["generator:output:electricity"]}` : "") +
								(tags.operator                        ? `<br>${tags.operator}` : "");
							L.polygon(latlngs, {
								pane: "dwInfraPane", color: "#F6C90E", weight: 1.5,
								opacity: 0.9, fillColor: "#F6C90E", fillOpacity: 0.25,
							}).bindTooltip(tip, { className: "dw-infra-tip", sticky: true })
							  .addTo(group);
							continue;
						}

						// ----- point features -----
						let lat, lon;
						if (el.type === "node") {
							lat = el.lat; lon = el.lon;
						} else if (geom.length) {
							let sLat = 0, sLon = 0;
							for (const g of geom) { sLat += g.lat; sLon += g.lon; }
							lat = sLat / geom.length; lon = sLon / geom.length;
						} else { continue; }
						if (!isFinite(lat) || !isFinite(lon)) continue;

						const src = tags["generator:source"] || "";
						let glyph, fill, label;
						if      (power === "substation")   { glyph = "⚡"; fill = "#F0A500"; label = tags.name || "Substation"; }
						else if (power === "plant")        { glyph = "⚙"; fill = "#9B59B6"; label = tags.name || "Power plant"; }
						else if (power === "transformer")  { glyph = "T";  fill = "#E67E22"; label = "Transformer"; }
						else if (src   === "wind")         { glyph = "〇"; fill = "#5B9BD5"; label = tags.name || "Wind turbine"; }
						else if (src   === "solar")        { glyph = "☀"; fill = "#F6C90E"; label = tags.name || "Solar generator"; }
						else                               { glyph = "⚡"; fill = "#aaa";    label = tags.name || power; }

						const sz  = power === "transformer" ? 12 : 16;
						const vLabel = fmtVoltage(tags.voltage);
						let tip = `<b>${label}</b>`;
						if (vLabel)                                   tip += `<br>${vLabel}`;
						if (tags.operator)                            tip += `<br>${tags.operator}`;
						if (tags["generator:output:electricity"])     tip += `<br>Output: ${tags["generator:output:electricity"]}`;
						if (tags["plant:source"])                     tip += `<br>Source: ${tags["plant:source"]}`;

						L.marker([lat, lon], { icon: pointIcon(glyph, fill, sz), pane: "dwInfraPane", interactive: true })
							.bindTooltip(tip, { className: "dw-infra-tip", sticky: true })
							.addTo(group);
					}
				},
			});
		}
	}

	/* -- Telecoms Infrastructure (OpenInfraMap vector tiles) ------------- */

	// Telephone exchanges / data centres (named, with operator — Telstra,
	// NBN Co, …), plus communications masts and antennas, from OpenInfraMap's
	// global telecoms vector tiles. Same vector-tile pipeline as Power; data
	// centres ship as both polygon and centroid point (shared `_id` → polygon
	// wins). Masts/antennas are usually unnamed points.
	class TelecomsLayerProvider extends LayerProvider {
		create() {
			const dotIcon = (g, f, s) => oimIcon("dw-telecom-icon", g, f, s || 15);
			const DC_FILL = "#00897B";   // teal — data centre / exchange
			const MAST_FILL = "#26A69A";

			return makeVectorTileLayer({
				label:         "Telecoms",
				pane:          "dwTelecomPane",
				paneZIndex:    409,
				minZoom:       10,
				padBounds:     0.1,
				maxNativeZoom: CFG.OIM_MAX_NATIVE_Z,
				attribution:   'Telecoms data © <a href="https://openinframap.org/" target="_blank" rel="noreferrer">OpenInfraMap</a> / <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>',
				tileUrl: (z, x, y) => `${CFG.OIM_TELECOM_TILES}/${z}/${x}/${y}.pbf`,

				toElements: (layerName, p, gtype, rings) => {
					if (p.disused) return null;
					if (layerName === "telecoms_data_center") {
						const tags = { kind: "datacenter", name: p.name,
							operator: p.operator, dtype: p.type };
						return rings.map((r) => ({ type: "way", geometry: r, tags,
							_id: "dc/" + p.osm_id }));
					}
					if (layerName === "telecoms_data_center_point") {
						const r = rings[0]; if (!r || !r.length) return null;
						return [{ type: "node", lat: r[0].lat, lon: r[0].lon,
							_id: "dc/" + p.osm_id, tags: { kind: "datacenter",
								name: p.name, operator: p.operator, dtype: p.type } }];
					}
					if (layerName === "telecoms_mast" || layerName === "telecoms_antenna") {
						const r = rings[0]; if (!r || !r.length) return null;
						return [{ type: "node", lat: r[0].lat, lon: r[0].lon,
							tags: { kind: layerName === "telecoms_mast" ? "mast" : "antenna",
								name: p.name, operator: p.operator } }];
					}
					return null;
				},

				render: (group, elements) => {
					for (const el of elements) {
						const t = el.tags || {};
						if (el.type === "way" && el.geometry && el.geometry.length) {
							const latlngs = el.geometry.map((g) => [g.lat, g.lon]);
							const tip =
								`<b>${t.name || "Telephone exchange / data centre"}</b>` +
								(t.dtype    ? `<br>${t.dtype}` : "") +
								(t.operator ? `<br>${t.operator}` : "");
							L.polygon(latlngs, {
								pane: "dwTelecomPane", color: DC_FILL, weight: 1.5,
								opacity: 0.9, fillColor: DC_FILL, fillOpacity: 0.2,
							}).bindTooltip(tip, { className: "dw-infra-tip", sticky: true })
							  .addTo(group);
							continue;
						}
						if (el.type !== "node" || !isFinite(el.lat) || !isFinite(el.lon))
							continue;
						let glyph, fill, label;
						if (t.kind === "datacenter") {
							glyph = "▣"; fill = DC_FILL;
							label = t.name || "Telephone exchange / data centre";
						} else if (t.kind === "mast") {
							glyph = "T"; fill = MAST_FILL; label = t.name || "Comms mast";
						} else {
							glyph = "Y"; fill = MAST_FILL; label = t.name || "Antenna";
						}
						let tip = `<b>${label}</b>`;
						if (t.dtype)    tip += `<br>${t.dtype}`;
						if (t.operator) tip += `<br>${t.operator}`;
						L.marker([el.lat, el.lon], {
							icon: dotIcon(glyph, fill, t.kind === "datacenter" ? 16 : 13),
							pane: "dwTelecomPane", interactive: true,
						}).bindTooltip(tip, { className: "dw-infra-tip", sticky: true })
						  .addTo(group);
					}
				},
			});
		}
	}

	/* -- Water Infrastructure (OpenInfraMap vector tiles) --------------- */

	// Water & wastewater facilities worldwide from OpenInfraMap's water tiles:
	// treatment & wastewater plants, reservoirs, water towers, wells, pumping
	// stations, plus named trunk pipelines. Note this is a *facilities* map,
	// not a pipe network — OSM has little reticulation — so it replaced the old
	// Unitywater layer (authoritative pipe-level, but SE-QLD only) with global
	// coverage. Same vector-tile pipeline as Power/Telecoms; polygon+centroid
	// pairs share an `_id` so the polygon wins.
	class WaterLayerProvider extends LayerProvider {
		create() {
			const dotIcon = (g, f, s) => oimIcon("dw-water-icon", g, f, s || 14);
			// water-kind → marker glyph/colour + label (pipelines styled below).
			const STYLE = {
				plant_water: { fill: "#0277BD", glyph: "≈", label: "Water treatment plant" },
				plant_waste: { fill: "#6D4C41", glyph: "≈", label: "Wastewater plant" },
				reservoir:   { fill: "#0288D1", glyph: "R", label: "Reservoir" },
				tower:       { fill: "#0288D1", glyph: "T", label: "Water tower" },
				well:        { fill: "#0288D1", glyph: "○", label: "Well" },
				pump:        { fill: "#00897B", glyph: "P", label: "Pumping station" },
			};
			const WASTE = /waste|sewage|sewer|drain/i;

			return makeVectorTileLayer({
				label:         "Water",
				pane:          "dwWaterPane",
				paneZIndex:    400,
				minZoom:       10,
				padBounds:     0.1,
				maxNativeZoom: CFG.OIM_MAX_NATIVE_Z,
				attribution:   'Water data © <a href="https://openinframap.org/" target="_blank" rel="noreferrer">OpenInfraMap</a> / <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>',
				tileUrl: (z, x, y) => `${CFG.OIM_WATER_TILES}/${z}/${x}/${y}.pbf`,

				toElements: (layerName, p, gtype, rings) => {
					if (p.disused) return null;
					const tagsFor = (wk) => ({ wk: wk, name: p.name,
						operator: p.operator, substance: p.substance });
					const ways = (wk, id) => rings.map((r) => ({ type: "way",
						geometry: r, tags: tagsFor(wk), _id: id }));
					const point = (wk, id) => {
						const r = rings[0]; if (!r || !r.length) return null;
						return [{ type: "node", lat: r[0].lat, lon: r[0].lon,
							_id: id, tags: tagsFor(wk) }];
					};
					switch (layerName) {
						case "water_pipeline": {
							const wk = WASTE.test(p.substance || "")
								? "pipe_waste" : "pipe_water";
							return rings.map((r) => ({ type: "way", geometry: r,
								tags: tagsFor(wk) }));
						}
						case "water_treatment_plant_polygon": return ways("plant_water", "wtp/" + p.osm_id);
						case "water_treatment_plant_point":   return point("plant_water", "wtp/" + p.osm_id);
						case "wastewater_plant_polygon":      return ways("plant_waste", "wwp/" + p.osm_id);
						case "wastewater_plant_point":        return point("plant_waste", "wwp/" + p.osm_id);
						case "water_reservoir":               return ways("reservoir", "res/" + p.osm_id);
						case "water_reservoir_point":         return point("reservoir", "res/" + p.osm_id);
						case "pumping_station_polygon":       return ways("pump", "pmp/" + p.osm_id);
						case "pumping_station_point":         return point("pump", "pmp/" + p.osm_id);
						case "water_tower":                   return point("tower");
						case "water_well":                    return point("well");
						default: return null; // water_cabinet, etc.
					}
				},

				render: (group, elements) => {
					for (const el of elements) {
						const t = el.tags || {};
						const extra = (t.operator ? `<br>${t.operator}` : "") +
							(t.substance ? `<br>${t.substance}` : "");
						if (el.type === "way" && el.geometry && el.geometry.length) {
							const latlngs = el.geometry.map((g) => [g.lat, g.lon]);
							if (t.wk === "pipe_water" || t.wk === "pipe_waste") {
								const waste = t.wk === "pipe_waste";
								L.polyline(latlngs, {
									pane: "dwWaterPane",
									color: waste ? "#8D6E63" : "#039BE5",
									weight: 2, opacity: 0.9,
									dashArray: waste ? "5 4" : null,
								}).bindTooltip(`<b>${t.name ||
									(waste ? "Wastewater pipeline" : "Water pipeline")}</b>` + extra,
									{ className: "dw-infra-tip", sticky: true }).addTo(group);
								continue;
							}
							const st = STYLE[t.wk] || STYLE.reservoir;
							L.polygon(latlngs, {
								pane: "dwWaterPane", color: st.fill, weight: 1.5,
								opacity: 0.9, fillColor: st.fill, fillOpacity: 0.2,
							}).bindTooltip(`<b>${t.name || st.label}</b>` + extra,
								{ className: "dw-infra-tip", sticky: true }).addTo(group);
							continue;
						}
						if (el.type !== "node" || !isFinite(el.lat) || !isFinite(el.lon))
							continue;
						const st = STYLE[t.wk]; if (!st) continue;
						L.marker([el.lat, el.lon], {
							icon: dotIcon(st.glyph, st.fill, t.wk === "well" ? 12 : 14),
							pane: "dwWaterPane", interactive: true,
						}).bindTooltip(`<b>${t.name || st.label}</b>` + extra,
							{ className: "dw-infra-tip", sticky: true }).addTo(group);
					}
				},
			});
		}
	}

	/* -- ArcGIS REST query → GeoJSON overlay ------------------------------ */

	// Vector overlay backed by an ArcGIS REST `query` endpoint returning
	// GeoJSON. Debounced + generation-guarded + redraw-on-move; a single
	// GET passes the view bbox as an envelope with server-side geometry
	// simplification (maxAllowableOffset, keyed to zoom) so payloads stay
	// small and polygons arrive pre-assembled — holes + multipart included
	// — for L.geoJSON to render directly. The pane is left interactive
	// (no pointerEvents:none) so the hover name tooltip works.
	//
	// opts: { label, pane, paneZIndex, minZoom, queryUrl, where, outFields,
	//         style, tooltip(props)->html, tipClass, attribution,
	//         debounceMs=400, timeoutMs=30000, padBounds=0 }
	function makeArcgisQueryLayer(opts) {
		const debounceMs = opts.debounceMs || 400;
		const timeoutMs = opts.timeoutMs || 30000;
		const padBounds = opts.padBounds || 0;

		const Layer = L.Layer.extend({
			initialize() {
				this._group = null;
				this._debounce = null;
				this._lastBbox = null;
				this._gen = 0;
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
				this._gen++; // invalidate any in-flight response
				map.off("moveend zoomend", this._onViewChange, this);
				if (this._group) { this._group.remove(); this._group = null; }
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
					this._lastBbox = null;
					return;
				}

				const b = padBounds ? map.getBounds().pad(padBounds) : map.getBounds();
				const bbox = `${b.getWest().toFixed(4)},${b.getSouth().toFixed(4)},` +
					`${b.getEast().toFixed(4)},${b.getNorth().toFixed(4)}`;
				if (bbox === this._lastBbox) return;
				this._lastBbox = bbox;

				const myGen = ++this._gen;
				// Simplify geometry to ~2 screen pixels at the current zoom.
				const offset = (360 / (256 * Math.pow(2, z))) * 2;
				const url = opts.queryUrl + "?f=geojson&returnGeometry=true" +
					"&geometryType=esriGeometryEnvelope&inSR=4326&outSR=4326" +
					"&spatialRel=esriSpatialRelIntersects&geometryPrecision=5" +
					"&where=" + encodeURIComponent(opts.where) +
					"&outFields=" + encodeURIComponent(opts.outFields) +
					"&geometry=" + encodeURIComponent(bbox) +
					"&maxAllowableOffset=" + offset;

				gmJsonGet(url, { timeout: timeoutMs }, (err, geojson) => {
					if (myGen !== this._gen || !this._group) return;
					if (err || (geojson && geojson.error)) {
						console.warn(`[CustomTiles] ${opts.label} request error`,
							err ? err.message : JSON.stringify(geojson.error));
						return;
					}
					this._group.clearLayers();
					L.geoJSON(geojson, {
						pane: opts.pane,
						style: () => opts.style,
						onEachFeature: (f, lyr) => {
							const tip = opts.tooltip && opts.tooltip(f.properties || {});
							if (tip) lyr.bindTooltip(tip, {
								className: opts.tipClass || "dw-park-tip", sticky: true,
							});
						},
					}).addTo(this._group);
				});
			},

			getAttribution() { return opts.attribution; },
		});

		return new Layer();
	}

	/* -- INTVL Global Map (public Mapbox Vector Tile pyramid) ------------
	 *
	 * Renders the INTVL app's public global territory map: every cell
	 * owned by whoever last ran a closed loop around it. URL pattern
	 * (`/single-player/run/{z}/{x}/{y}.pbf`) reverse-engineered from
	 * v3.4.3 APK; CFG.INTVL_TILES_BASE carries the resolved base and
	 * CFG.INTVL_TILES_MAX_NATIVE_Z carries the actual native max zoom (11).
	 *
	 * Tile contents: MVT layer `territories` with POLYGON features whose
	 * props are { runId, activityId, colour, currentArea (m²), startTime
	 * (integer day count against a custom ~1977-09-03 app epoch, i.e. 2802
	 * days behind the Unix day number — see
	 * CFG.INTVL_START_TIME_EPOCH_OFFSET_DAYS) }. Extent 4096.
	 *
	 * Renderer: per Leaflet tile, fetch the .pbf, run mvtDecode →
	 * prepareLayers, paint each polygon's fill onto a canvas (no library).
	 * The old auth-gated "your runs only" layer was removed in 7.9.5 —
	 * unknown overlay names in localStorage are silently skipped by the
	 * restorer, so no migration is needed.
	 */

	// ------ Minimal MVT (Mapbox Vector Tile) PBF parser ------------------
	// Implements just what we need:
	//   - top-level Tile message → repeated Layer (field 3)
	//   - Layer: name(1), features(2 repeated), keys(3 repeated string),
	//     values(4 repeated Value), extent(5 uint32), version(15)
	//   - Feature: tags(2 packed uint32), type(3 enum), geometry(4 packed uint32)
	//   - Value: string(1) / float(2) / double(3) / int(4) / uint(5) / sint(6) / bool(7)
	// Geometry commands: MoveTo=1, LineTo=2, ClosePath=7. Coords are
	// zigzag-encoded relative-to-previous tile pixels (0..extent).
	function mvtDecode(buf) {
		const layers = [];
		const view = new Uint8Array(buf);
		let off = 0;
		while (off < view.length) {
			const tag = readVarint(view, off); off = tag.end;
			const fn = tag.v >>> 3, wt = tag.v & 7;
			if (fn === 3 && wt === 2) {
				const len = readVarint(view, off); off = len.end;
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
			result |= (b & 0x7f) << shift;
			shift += 7;
		} while (b & 0x80);
		return { v: result >>> 0, end: off };
	}

	function skipField(buf, off, wireType) {
		if (wireType === 0)        { return readVarint(buf, off).end; }
		else if (wireType === 1)   { return off + 8; }
		else if (wireType === 2)   { const r = readVarint(buf, off); return r.end + r.v; }
		else if (wireType === 5)   { return off + 4; }
		return off;
	}

	function parseLayer(buf) {
		const info = { name: "", extent: 4096, keys: [], values: [], features: [] };
		let off = 0;
		while (off < buf.length) {
			const tag = readVarint(buf, off); off = tag.end;
			const fn = tag.v >>> 3, wt = tag.v & 7;
			if      (fn === 1 && wt === 2) {
				const r = readVarint(buf, off); off = r.end;
				info.name = utf8(buf, off, r.v); off += r.v;
			} else if (fn === 5 && wt === 0) {
				const r = readVarint(buf, off); off = r.end; info.extent = r.v;
			} else if (fn === 3 && wt === 2) {
				const r = readVarint(buf, off); off = r.end;
				info.keys.push(utf8(buf, off, r.v)); off += r.v;
			} else if (fn === 4 && wt === 2) {
				const r = readVarint(buf, off); off = r.end;
				info.values.push(parseValue(buf.subarray(off, off + r.v))); off += r.v;
			} else if (fn === 2 && wt === 2) {
				const r = readVarint(buf, off); off = r.end;
				info.features.push(parseFeature(buf.subarray(off, off + r.v))); off += r.v;
			} else {
				off = skipField(buf, off, wt);
			}
		}
		return info;
	}

	function parseValue(buf) {
		let off = 0;
		while (off < buf.length) {
			const tag = readVarint(buf, off); off = tag.end;
			const fn = tag.v >>> 3, wt = tag.v & 7;
			if (fn === 1 && wt === 2) {
				const r = readVarint(buf, off); off = r.end;
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
				return (v >>> 1) ^ -(v & 1);
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
			const tag = readVarint(buf, off); off = tag.end;
			const fn = tag.v >>> 3, wt = tag.v & 7;
			if (fn === 2 && wt === 2) {
				const r = readVarint(buf, off); off = r.end;
				const end = off + r.v;
				while (off < end) {
					const x = readVarint(buf, off); off = x.end;
					f.tags.push(x.v);
				}
			} else if (fn === 3 && wt === 0) {
				const r = readVarint(buf, off); off = r.end; f.type = r.v;
			} else if (fn === 4 && wt === 2) {
				const r = readVarint(buf, off); off = r.end;
				const end = off + r.v;
				while (off < end) {
					const x = readVarint(buf, off); off = x.end;
					f.geom.push(x.v);
				}
			} else {
				off = skipField(buf, off, wt);
			}
		}
		return f;
	}

	// Decode a feature's geometry stream into an array of rings of
	// [tilePxX, tilePxY] points. Each ring is closed implicitly by the
	// ClosePath command (we don't repeat the first point).
	function decodeGeometry(geom) {
		const rings = [];
		let ring = null;
		let i = 0, x = 0, y = 0;
		while (i < geom.length) {
			const cmd = geom[i] & 0x7;
			const count = geom[i] >>> 3;
			i++;
			if (cmd === 1) {       // MoveTo
				for (let k = 0; k < count; k++) {
					x += zig(geom[i++]); y += zig(geom[i++]);
					if (ring && ring.length) rings.push(ring);
					ring = [[x, y]];
				}
			} else if (cmd === 2) { // LineTo
				for (let k = 0; k < count; k++) {
					x += zig(geom[i++]); y += zig(geom[i++]);
					ring.push([x, y]);
				}
			} else if (cmd === 7) { // ClosePath
				if (ring) { rings.push(ring); ring = null; }
			}
		}
		if (ring && ring.length) rings.push(ring);
		return rings;
	}

	function zig(n) { return (n >>> 1) ^ -(n & 1); }

	function utf8(buf, off, len) {
		// Fast path for ASCII; fall back to TextDecoder for unicode
		let s = "";
		let allAscii = true;
		for (let i = 0; i < len; i++) {
			const b = buf[off + i];
			if (b > 127) { allAscii = false; break; }
			s += String.fromCharCode(b);
		}
		return allAscii ? s : new TextDecoder().decode(buf.subarray(off, off + len));
	}

	// One-pass preprocessor: turn raw MVT layers into a render-ready form.
	// For each POLYGON feature we extract its property dict, pre-decode its
	// geometry, and stash an axis-aligned bbox so hover hit-tests can
	// short-circuit before the per-ring point-in-poly walk. We also resolve
	// each unique `colour` to its rgba fillStyle string once via a
	// per-batch memo — dozens of features typically share a handful of
	// player colours. Features are sorted by startTime ASC so the renderer
	// paints oldest-first → newest claims end up on top, matching across
	// adjacent tiles. Only the `territories` layer is kept (the only one
	// the renderer + identify use); other MVT layers (if any) are dropped
	// at source rather than wasted-decoded then ignored downstream.
	function prepareLayers(layers, fillAlpha) {
		const out = [];
		const fillCache = new Map();   // colour → rgba string
		for (const layer of layers) {
			if (layer.name !== "territories") continue;
			const features = [];
			for (const f of layer.features) {
				if (f.type !== 3) continue; // POLYGON only
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
				// Bbox over all rings — cheap to compute once, lets hover
				// reject features without walking the geometry.
				let mnX = Infinity, mnY = Infinity, mxX = -Infinity, mxY = -Infinity;
				for (const ring of rings) {
					for (const p of ring) {
						const x = p[0], y = p[1];
						if (x < mnX) mnX = x; if (x > mxX) mxX = x;
						if (y < mnY) mnY = y; if (y > mxY) mxY = y;
					}
				}
				features.push({
					props,
					colour,
					fillStyle,
					startTime: typeof props.startTime === "number"
						? props.startTime : 0,
					rings,
					mnX, mnY, mxX, mxY,
				});
			}
			features.sort((a, b) => a.startTime - b.startTime);
			out.push({ name: layer.name, extent: layer.extent, features });
		}
		return out;
	}

	// ------ INTVL Global Map layer ---------------------------------------

	// Stable cache key for a Leaflet tile coord. Used in both the renderer
	// (to stash the prepared layer) and the hover-identify (to look it up
	// again), so a helper avoids any chance of drift between the two.
	const tileKey = (z, x, y) => `${z}/${x}/${y}`;

	/* -- INTVL hover formatting helpers ----------------------------------
	 *
	 * The public tiles ship only { runId, activityId, colour, currentArea,
	 * startTime } — deliberately anonymised: there is NO username/userId in
	 * the data and NO public way to resolve one. Confirmed by enumerating
	 * the INTVL tRPC router at https://www.intvl.com.au/api/trpc — every
	 * run/user lookup (run.getRun, user.getRun, user.byId,
	 * user.byIdProfileImage, …) requires BOTH a Clerk login AND a `userId`
	 * the tiles never carry, so runId/activityId cannot be turned into a
	 * name without an authed session that already knows the owner. So we
	 * make the data we DO have as useful as possible instead.
	 *
	 * One bonus: most activityIds are cuid v1 (`c` + 8 base36 chars of
	 * creation-time ms + counter/fingerprint/random). Decoding that recovers
	 * the precise time-of-day the run was recorded — `startTime` itself is
	 * only day-resolution. Older rows use a different id scheme; we sanity-
	 * check the decoded date and silently skip when it isn't a sane cuid. */
	function intvlActivityTime(activityId) {
		if (typeof activityId !== "string" || activityId.length < 9 ||
		    activityId[0] !== "c") return null;
		const ms = parseInt(activityId.slice(1, 9), 36);
		// Plausible only if it lands in the app's lifetime (2018..now+1d).
		if (!Number.isFinite(ms) ||
		    ms < Date.UTC(2018, 0, 1) || ms > Date.now() + 864e5) return null;
		return new Date(ms);
	}

	// "3 days ago" / "today" / "2 months ago" — coarse, good enough for a
	// hover. Input is a Date; future/invalid → "".
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

	// Area string: m² under 0.1 km² (so small claims read sensibly instead
	// of collapsing to "0.01 km²"), else km² with magnitude-aware precision.
	function intvlArea(m2) {
		const v = Number(m2) || 0;
		if (v < 1e5) return Math.round(v).toLocaleString() + " m²";
		const km2 = v / 1e6;
		return (km2 < 10 ? km2.toFixed(2) : km2.toFixed(1)) + " km²";
	}

	class IntvlGlobalTilesLayerProvider extends LayerProvider {
		create() {
			const TILE_PX = 256;
			const FILL_ALPHA = 0.55;

			const IntvlGlobalGrid = L.GridLayer.extend({
				onAdd(map) {
					if (!map.getPane("dwIntvlGlobalPane")) {
						map.createPane("dwIntvlGlobalPane");
						map.getPane("dwIntvlGlobalPane").style.zIndex = "404";
						// Pane is non-interactive so the underlying map
						// still receives waypoint clicks. The hover-identify
						// listens on the map's mousemove directly.
						map.getPane("dwIntvlGlobalPane").style.pointerEvents = "none";
					}
					L.GridLayer.prototype.onAdd.call(this, map);

					// Hover-identify: debounced mousemove → ray-cast against
					// the cached, pre-decoded polygons of the tile under the
					// cursor. Reusing the prepared per-tile feature list (the
					// same one the renderer drew from) means no MVT decode
					// in the hot path.
					//
					// Skip wiring on touch-primary devices. Browsers synthesise
					// `mousemove` during touch-drag panning, which makes every
					// pan run identify and pop a tooltip; the tooltip then
					// lingers because `mouseout` doesn't fire on touch-end.
					// `(hover: none)` is the standards-track "no hover capability"
					// signal; we fall back to Leaflet's UA-based mobile flag.
					this._tooltip = L.tooltip({
						sticky:    true,
						opacity:   0.95,
						className: "dw-intvl-tip",
						direction: "right",
						offset:    [12, 0],
					});
					this._hoverDebounce = null;
					this._lastFeatKey   = null;

					const noHover = L.Browser.mobile ||
						(window.matchMedia &&
						 window.matchMedia("(hover: none)").matches);
					if (!noHover) {
						this._onMove = (e) => {
							// Leaflet occasionally fires mousemove from layer
							// cascade events (e.g. when a layer add triggers
							// re-projection) without a real latlng — guard so
							// the debounced identify call never blows up.
							if (!e?.latlng) return;
							clearTimeout(this._hoverDebounce);
							const latlng = e.latlng;
							this._hoverDebounce = setTimeout(
								() => this._identifyHover(latlng), 60);
						};
						this._onLeave = () => {
							clearTimeout(this._hoverDebounce);
							this._clearTooltip();
						};
						map.on("mousemove", this._onMove);
						map.on("mouseout",  this._onLeave);
					}

					// Free a tile's prepared feature data when Leaflet
					// evicts the tile from its cache. Without this the
					// Map grows unbounded — every panned-away tile leaks
					// its prepared features (200-500 polygons each, with
					// nested vertex arrays) for the rest of the session.
					this._onTileUnload = (e) => {
						// Abort the in-flight pbf fetch so a fast pan doesn't
						// keep streaming bytes for tiles Leaflet has already
						// discarded — biggest win on flaky mobile networks.
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
						map.off("mouseout",  this._onLeave);
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
					// Internal canvas resolution is multiplied by devicePixelRatio
					// so the polygon edges stay crisp on HiDPI displays. CSS size
					// stays at TILE_PX (256px logical) — Leaflet places the tile
					// at logical-pixel coordinates and the browser samples the
					// higher-resolution backing store.
					const dpr = Math.max(1, window.devicePixelRatio || 1);
					canvas.width  = TILE_PX * dpr;
					canvas.height = TILE_PX * dpr;
					canvas.style.width  = TILE_PX + "px";
					canvas.style.height = TILE_PX + "px";
					const ctx = canvas.getContext("2d");
					ctx.scale(dpr, dpr);

					// Leaflet caps `coords.z` to maxNativeZoom and scales the
					// canvas in CSS for over-zoom, so we just fetch at
					// coords.z directly — no manual sub-tile cropping needed.
					const url =
						`${CFG.INTVL_TILES_BASE}/${coords.z}/${coords.x}/${coords.y}.pbf`;

					canvas._dwHandle = gmGet(url, {
						responseType: "arraybuffer",
						timeout: 15000,
					}, (err, r) => {
						canvas._dwHandle = null;
						// 404 (no coverage) and network errors both render empty —
						// caller relies on a canvas-shaped tile either way.
						if (err || r.status !== 200 || !r.response) {
							safeDone(); return;
						}
						try {
							const layers   = mvtDecode(r.response);
							const prepared = prepareLayers(layers, FILL_ALPHA);
							this._renderTile(ctx, prepared, TILE_PX);
							if (!this._tileFeatures) this._tileFeatures = new Map();
							this._tileFeatures.set(
								tileKey(coords.z, coords.x, coords.y), prepared);
						} catch (e) {
							console.warn("[CustomTiles] INTVL global decode:", e);
						}
						safeDone();
					});
					// Guard against the case where a rapid layer-toggle (or
					// 3D mode hide/show) evicts the tile after the request
					// fired but before it resolved. Leaflet's _tileReady
					// then null-derefs the tile element. Wrap done() so
					// the unmount race doesn't surface as a runtime error.
					function safeDone() {
						try { done(null, canvas); }
						catch (e) {
							// Only swallow the specific null-tile race; rethrow others.
							if (!String(e?.message || "").includes("style")) throw e;
						}
					}

					return canvas;
				},

				_renderTile(ctx, prepared, tilePx) {
					ctx.clearRect(0, 0, tilePx, tilePx);
					// No explicit clip — canvas clips naturally at its bounds.
					// Features are pre-sorted by startTime ASC so older claims
					// paint first and the latest claim ends up on top —
					// resolves "last runner owns it" consistently within each
					// tile. Adjacent tile seams can still show colour breaks
					// when the server didn't include the same polygons in
					// both tiles (server-side MVT generation quirk); fill
					// alone, with no per-polygon stroke, makes those
					// transitions read as natural colour boundaries rather
					// than emphasised outlines. Nonzero winding rule (canvas
					// default) matches MVT's outer-CW / inner-CCW convention.
					for (const layer of prepared) {
						const scale = tilePx / layer.extent;
						for (const f of layer.features) {
							ctx.beginPath();
							for (const ring of f.rings) {
								if (ring.length < 3) continue;
								let started = false;
								for (const [tx, ty] of ring) {
									const px = tx * scale, py = ty * scale;
									if (!started) { ctx.moveTo(px, py); started = true; }
									else ctx.lineTo(px, py);
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
					const z       = map.getZoom();
					const cappedZ = Math.min(z, CFG.INTVL_TILES_MAX_NATIVE_Z);

					// Project to pixel coords at the FETCH zoom — that's the
					// zoom the cached tile data is keyed at.
					const proj   = map.project(latlng, cappedZ);
					const tileX  = Math.floor(proj.x / TILE_PX);
					const tileY  = Math.floor(proj.y / TILE_PX);

					const prepared = this._tileFeatures.get(
						tileKey(cappedZ, tileX, tileY));
					if (!prepared) { this._clearTooltip(); return; }

					for (const layer of prepared) {
						// Convert the click point ONCE from canvas pixels to
						// MVT-extent coords (0..extent). Then per-feature
						// bbox tests and the ray-cast work directly on the
						// raw stored rings — no per-vertex Array allocation,
						// no per-ring `.map()`. With ~200 features per tile
						// at z=11 this drops hover work from O(rings·verts)
						// to O(features) for the common case where the
						// cursor is outside the feature's bbox.
						const scaleInv = layer.extent / TILE_PX;
						const ex = (proj.x - tileX * TILE_PX) * scaleInv;
						const ey = (proj.y - tileY * TILE_PX) * scaleInv;

						// Walk newest-first (reverse of paint order): the
						// topmost rendered polygon is the "owner" at this point.
						for (let fi = layer.features.length - 1; fi >= 0; fi--) {
							const f = layer.features[fi];
							if (ex < f.mnX || ex > f.mxX ||
							    ey < f.mnY || ey > f.mxY) continue;

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

							// Captured date from startTime (day-resolution) —
							// startTime is an integer day count against a custom
							// app epoch (~1977-09-03), not the Unix epoch, so
							// shift it onto the Unix day number first. See
							// CFG.INTVL_START_TIME_EPOCH_OFFSET_DAYS.
							let dayDate = null;
							if (typeof f.props.startTime === "number") {
								const unixDay = f.props.startTime +
									CFG.INTVL_START_TIME_EPOCH_OFFSET_DAYS;
								dayDate = new Date(unixDay * 86400 * 1000);
							}
							// Precise recorded time from the activityId cuid, when
							// decodable — recovers the time-of-day startTime lacks.
							const actDate = intvlActivityTime(f.props.activityId);
							const fmtDay = (d) => d.toLocaleDateString(undefined,
								{ day: "numeric", month: "short", year: "numeric" });
							const fmtDateTime = (d) => d.toLocaleString(undefined, {
								day: "numeric", month: "short", year: "numeric",
								hour: "numeric", minute: "2-digit",
							});

							let whenLine;
							if (actDate) {
								whenLine = `Recorded ${fmtDateTime(actDate)}` +
									` <span class="dw-cad-sub">(${intvlAgo(actDate)})</span>`;
							} else if (dayDate) {
								whenLine = `Captured ${fmtDay(dayDate)}` +
									` <span class="dw-cad-sub">(${intvlAgo(dayDate)})</span>`;
							} else {
								whenLine = "Capture date unknown";
							}

							const swatch =
								`<span style="display:inline-block;width:10px;` +
								`height:10px;background:${f.colour};` +
								`border:1px solid #444;vertical-align:middle"></span>`;
							// The public tiles carry no username/userId and there's
							// no public way to resolve one (see intvlActivityTime
							// comment), so the runId/activityId are dead weight in a
							// hover — show only what's actually meaningful: the
							// territory's colour, area, and when it was claimed.
							const html =
								`<b>${swatch} ${area}</b> territory<br>` +
								`${whenLine}`;
							this._tooltip.setLatLng(latlng).setContent(html);
							if (!this._tooltip._map) this._tooltip.addTo(map);
							return;
						}
					}
					this._clearTooltip();
				},

				getAttribution() {
					return 'Global territories © <a href="https://www.intvl.com.au" target="_blank" rel="noreferrer">INTVL</a>';
				},
			});

			const layer = new IntvlGlobalGrid({
				tileSize: TILE_PX,
				minZoom: 4,
				maxNativeZoom: CFG.INTVL_TILES_MAX_NATIVE_Z,
				maxZoom: 25,
				opacity: 1,
				pane: "dwIntvlGlobalPane",
			});
			// 3D mirror: same PBF tileset, decoded natively by Mapbox.
			// Source-layer "territories" carries polygons with a
			// `colour` string property (no leading #). CloudFront
			// serves CORS-allowed PBFs, so Mapbox can fetch directly —
			// no addProtocol indirection needed (which is good because
			// some Mapbox builds dynamic.watch loads don't expose
			// addProtocol at all).
			layer._dwMb3DStyle = {
				sources: {
					src: {
						type: "vector",
						tiles: [`${CFG.INTVL_TILES_BASE}/{z}/{x}/{y}.pbf`],
						minzoom: 0,
						maxzoom: CFG.INTVL_TILES_MAX_NATIVE_Z,
					},
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
						"fill-color": ["case",
							["has", "colour"], ["to-color", ["get", "colour"]],
							"#888",
						],
						"fill-opacity": 0.55,
						"fill-emissive-strength": 0.85,
					},
				}],
			};
			return layer;
		}
	}

	/* -- INTVL canvas + hit-test helpers ---------------------------------
	 * These are INTVL-internal — hexAlpha is consumed by the canvas
	 * fill in `IntvlGlobalTilesLayerProvider`, and pointInRing is the
	 * hover-hit-test for picking which territory is under the cursor.
	 * Kept after the class because they're tiny + function-declared
	 * (hoisted), but logically they belong with the INTVL block above.
	 */

	// Append alpha to a #rrggbb colour → 'rgba(r,g,b,a)' for canvas fill.
	function hexAlpha(hex, a) {
		const m = /^#([0-9a-f]{6})$/i.exec(hex);
		if (!m) return hex;
		const v = parseInt(m[1], 16);
		return `rgba(${(v >> 16) & 0xff},${(v >> 8) & 0xff},${v & 0xff},${a})`;
	}

	// Ray-casting point-in-polygon for hit testing.
	function pointInRing(px, py, ring) {
		let inside = false;
		for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
			const xi = ring[i][0], yi = ring[i][1];
			const xj = ring[j][0], yj = ring[j][1];
			const intersect = ((yi > py) !== (yj > py)) &&
				(px < (xj - xi) * (py - yi) / (yj - yi + 1e-12) + xi);
			if (intersect) inside = !inside;
		}
		return inside;
	}

	/* -- Light Pollution (lightpollutionmap.info WMS) --------------------- */

	// WMS GetMap served via GeoServer's GWC tile cache. We compute the
	// EPSG:3857 bbox per Leaflet tile (z/x/y) and slot it into the WMS
	// request — the cache hits for tile-aligned bboxes, so this is fast.
	class LightPollutionLayerProvider extends LayerProvider {
		create() {
			const TILE_PX = 256;
			const wmsParams =
				"?REQUEST=GetMap&SERVICE=WMS&VERSION=1.3.0&FORMAT=image%2Fpng" +
				"&STYLES=" +
				encodeURIComponent(CFG.LIGHTPOL_WMS_STYLE) +
				"&TRANSPARENT=TRUE" +
				"&LAYERS=" +
				encodeURIComponent(CFG.LIGHTPOL_WMS_LAYER) +
				"&TILED=true&SRS=EPSG%3A3857&CRS=EPSG%3A3857" +
				"&WIDTH=" +
				TILE_PX +
				"&HEIGHT=" +
				TILE_PX;

			const LightPolWmsLayer = L.TileLayer.extend({
				getTileUrl(coords) {
					const bb = tileToBBox3857(coords.z, coords.x, coords.y);
					return (
						CFG.LIGHTPOL_WMS_BASE +
						wmsParams +
						"&BBOX=" +
						bb.west +
						"," +
						bb.south +
						"," +
						bb.east +
						"," +
						bb.north
					);
				},
			});

			const layer = new LightPolWmsLayer("", {
				tileSize: TILE_PX,
				minZoom: 0,
				maxNativeZoom: 12,
				maxZoom: 25,
				opacity: 0.65,
				attribution:
					'Light pollution © <a href="https://www.lightpollutionmap.info/" target="_blank" rel="noreferrer">lightpollutionmap.info</a>',
			});
			// 3D mirror: WMS is bbox-driven, and Mapbox supports
			// `{bbox-epsg-3857}` natively. Drop the wmsParams `SRS` /
			// `CRS` to match Mapbox's 3857 default (the WMS server
			// accepts either).
			layer._dwMb3DUrl =
				CFG.LIGHTPOL_WMS_BASE + wmsParams + "&BBOX={bbox-epsg-3857}";
			return layer;
		}
	}

	/* -- 3D Mode (Mapbox GL JS terrain overlay) ---------------------------
	 *
	 * Toggle that lazily loads mapbox-gl-js, mounts a Mapbox canvas inside
	 * Leaflet's mapPane (above the now-hidden tile pane, below all the
	 * overlay/marker panes so dynamic.watch's routes + waypoints continue
	 * to render on top), enables `mapbox.terrain-rgb` as the DEM source,
	 * and mirrors the currently-active Leaflet basemap as a Mapbox raster
	 * layer draped over the terrain. Viewport syncs both directions so
	 * pans inside Leaflet (e.g. dragging a waypoint) update the 3D view,
	 * and pans inside the 3D view update Leaflet's logical state.
	 *
	 * Overlays that are Leaflet-rendered (vectors, GeoJSON, custom canvas
	 * tiles like INTVL) still float in 2D pixel space — they don't track
	 * the terrain. To make them follow the 3D surface they'd need to be
	 * re-implemented as Mapbox sources; see the scope-2 path in the
	 * README's roadmap for that.
	 */

	// dynamic.watch already ships its own Mapbox public token (for route
	// thumbnails, 3D Preview, etc.); we scrape it instead of embedding
	// one. Order: react-prop blob → any string in the page HTML → an
	// inert placeholder (Mapbox GL JS requires *some* non-empty token at
	// init even when no Mapbox-hosted tiles are requested).
	function pickMapboxToken() {
		if (pageWin.mapboxgl?.accessToken && /^pk\./.test(pageWin.mapboxgl.accessToken)) {
			return pageWin.mapboxgl.accessToken;
		}
		try {
			const html = document.documentElement.outerHTML;
			const m = html.match(/pk\.eyJ[A-Za-z0-9._-]{30,}/);
			if (m) return m[0];
		} catch (_) {}
		return "pk.no-mapbox-tiles-needed";
	}

	function ensureMapboxLoaded() {
		const win = pageWin;
		if (win.mapboxgl) return Promise.resolve(win.mapboxgl);
		if (!ensureMapboxLoaded._p) {
			ensureMapboxLoaded._p = new Promise((resolve, reject) => {
				// CSS first so the canvas sizing rules are in place before
				// the script fires its DOM construction.
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
						// Silence telemetry. The borrowed token is URL-restricted
						// to dynamic.watch, so events.mapbox.com rejects every
						// beacon with a CORS error — harmless but spammy. Nulling
						// EVENTS_URL stops the library from firing them at all.
						try {
							if (win.mapboxgl.config) win.mapboxgl.config.EVENTS_URL = null;
							if (typeof win.mapboxgl.setTelemetryEnabled === "function") win.mapboxgl.setTelemetryEnabled(false);
						} catch (e) { /* best-effort */ }
						// Register `dw://` so raster sources backed by our
						// custom Leaflet fetchers (Stamen, ArcGIS Exports,
						// QLD Roads/Historical, INTVL) can flow through Mapbox.
						// Firefox's userscript sandbox wraps closures into
						// XPCNativeWrappers that the page-context Mapbox
						// can't call — so we use `exportFunction` (when
						// available) to expose a page-callable shim that
						// bounces back into our sandbox handler. On Chrome /
						// Tampermonkey's "main world" mode this is a no-op
						// and the raw function works directly.
						try {
							if (typeof win.mapboxgl.addProtocol === "function") {
								const handler = typeof exportFunction === "function"
									? exportFunction(dwMbProtocolHandler, win, { allowCrossOriginArguments: true })
									: dwMbProtocolHandler;
								win.mapboxgl.addProtocol("dw", handler);
								_dwMbHasProtocol = true;
							} else {
								console.info(
									"[CustomTiles] mapboxgl.addProtocol unavailable in this build " +
									"(v" + (win.mapboxgl.version || "?") + " — Mapbox v3 dropped it); " +
									"Stamen / QLD Historical / Garmin Heatmap render in 3D via the " +
									"transformRequest blob bridge instead.");
							}
						} catch (e) {
							console.warn("[CustomTiles] addProtocol failed:", e.message);
						}
						resolve(win.mapboxgl);
					}
					else reject(new Error("mapboxgl global missing after load"));
				};
				script.onerror = () => reject(new Error("script tag load failed"));
				document.head.appendChild(script);
			});
		}
		return ensureMapboxLoaded._p;
	}

	class Mode3DController {
		constructor(app) {
			this._app = app;
			this._active = false;
			this._loading = false;
			this._mbMap = null;
			this._mbContainer = null;
			this._handler3DMove = null;
			this._baseTracker = null;
		}

		isActive() { return this._active || this._loading; }

		enable(map) {
			if (this._active || this._loading) return;
			// Defensive cleanup of any leftover state from a prior
			// session that didn't fully tear down (fast-toggle race).
			const stale = document.getElementById("dw-mb-container");
			if (stale && stale.parentNode) stale.parentNode.removeChild(stale);
			this._loading = true;
			// Generation counter — every enable starts a new "session"
			// and every disable bumps the gen so any in-flight async
			// path (e.g. mapbox-gl.js still loading from a previous
			// enable, layer fetches, deferred mounts) checks `myGen
			// !== this._gen` and bails. This is what makes rapid
			// stress-toggling stable: superseded enables/disables
			// silently no-op rather than racing each other to mount
			// or tear down DOM the other side is already touching.
			this._gen = (this._gen || 0) + 1;
			const myGen = this._gen;
			ensureMapboxLoaded().then((mapboxgl) => {
				if (myGen !== this._gen) return;  // superseded
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
					e.message);
			});
		}

		disable(map) {
			if (this._loading) {
				// Bump gen so the in-flight enable's `.then` bails,
				// reset _loading so the NEXT click on the toggle can
				// proceed (without this, the controller stays stuck
				// in "loading" forever and isActive() keeps returning
				// true — exactly the rapid-toggle stuck state the
				// stress test was hitting).
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
				try { this._mbMap.remove(); } catch (_) {}
				this._mbMap = null;
			}
			// `_popup` + `_hoverBound` reference the destroyed mbMap;
			// drop them so the next enable() creates fresh ones.
			this._popup = null;
			this._hoverBound = null;
			// Cancel any pending getter-retry timer that was scheduled
			// while 3D was active (would otherwise fire after we've
			// already torn the controller down and call into a null
			// `_mbMap`).
			if (this._pendingRetry) {
				clearTimeout(this._pendingRetry);
				this._pendingRetry = null;
			}
			this._unmount(map);
			this._active = false;
			console.info("[CustomTiles] 3D Mode disabled");
		}

		_mount(map) {
			this._hiddenPanes = [];
			this._hideHiddenable(map);
			// Mount the Mapbox container ONCE per enable. Previously
			// this happened inside `_hideHiddenable` which is also
			// called from `_baseTracker` and `_syncOverlaysImpl` on
			// every layer event — so a second/third dw-mb-container
			// could end up in DOM with the same id while
			// `this._mbContainer` only tracked the most recent one.
			// On disable, `_unmount` removed the tracked div but the
			// older one (still parenting the live Mapbox canvas)
			// leaked. On re-enable, a fresh container went IN FRONT
			// of the leaked one — and the leaked Leaflet panes /
			// list items on top of it intercepted pointer events,
			// which is what made the camera "unable to be moved".
			// Cleanup is now strictly enable→mount, disable→unmount.
			if (!document.getElementById("dw-mb-container")) {
				const root = map.getContainer();
				const div = document.createElement("div");
				div.id = "dw-mb-container";
				div.style.cssText =
					"position:absolute;top:0;left:0;width:100%;height:100%;" +
					// `z-index: 200` lifts us above Leaflet's tilePane
					// (z-index 200 too — equal beats nothing) and below
					// the marker / popup panes (600+) so user-clickable
					// UI still works.
					"z-index:200;pointer-events:auto;";
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
			// Inject a global CSS rule with `!important` so even if
			// Leaflet (or dynamic.watch) resets pane.style.opacity
			// inline during a setView / animation, the hidden panes
			// stay invisible. Without `!important`, the route SVG in
			// overlayPane and the basemap tiles in tilePane briefly
			// flash through the Mapbox canvas mid-motion — that's the
			// "route shows as 2D while in motion before snapping" bug.
			// The class `dw-3d-active` is added to the leaflet root in
			// the mount block below; removed on `disable`.
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
			this._hiddenPanes ??= [];
			const tracked = new Set(this._hiddenPanes.map(p => p.name));
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
			// Hide tooltipPane — every layer with hover-identify
			// (Cadastre, QPWS, INTVL) drops its tooltip here, and in
			// 3D they all fire on every mousemove regardless of which
			// hidden pane the tile data lives in, so the user ends up
			// seeing multiple stacked popovers for the same hover. The
			// Mapbox-side popups for ported layers (INTVL, geocaches,
			// flights, vessels) render through the Mapbox canvas, not
			// tooltipPane, so they still show. `popupPane` stays
			// visible so click-driven popups (Cadastre Sales link,
			// Street View, etc.) keep working.
			hide("tooltipPane");
			for (const key of Object.keys(map._panes || {})) {
				if (key.startsWith("dw")) hide(key);
			}
		}

		_unmount(map) {
			// Belt + braces: remove every dw-mb-container in the DOM,
			// not just the one we tracked. If anything (a stale enable
			// from a prior session, an external script, etc.) left a
			// stray container behind, we don't want it leaking past
			// disable and intercepting pointer events on the next
			// enable.
			for (const el of document.querySelectorAll("#dw-mb-container")) {
				el.parentNode?.removeChild(el);
			}
			this._mbContainer = null;
			map.getContainer().classList.remove("dw-3d-active");
			for (const entry of (this._hiddenPanes || [])) {
				const pane = map.getPane(entry.name);
				if (pane) pane.style.opacity = entry.prev || "";
			}
			this._hiddenPanes = null;
			// Clear our `!important` transform overrides so Leaflet's
			// normal repositioning takes effect again. Without this,
			// the markers would stay frozen at their last 3D position
			// even after the user toggles 3D off.
			map.eachLayer((lyr) => {
				if (!(lyr instanceof L.Marker)) return;
				const el = lyr._icon || lyr.getElement?.();
				if (el) el.style.removeProperty("transform");
			});
			// Force Leaflet to re-emit positions so the cleared
			// transforms get repopulated by Leaflet's flat projection.
			try { map.fire("viewreset"); } catch (_) {}
		}

		_initMbMap(map, mapboxgl) {
			// Mapbox Terrain-DEM v1 — Mapbox's current global DEM
			// (replaces the legacy `mapbox.terrain-rgb`). Higher
			// effective resolution than AWS Terrarium, especially in
			// blended/lidar regions, and tiles serve as 512px WebP so
			// fewer requests per visible area. Using the `mapbox://`
			// URL form lets Mapbox GL JS fetch the TileJSON and
			// inject the access_token automatically — no addProtocol
			// needed, which is critical for the build dynamic.watch
			// ships (no addProtocol export). If the borrowed page
			// token doesn't have terrain-dem-v1 scope, fall back via
			// the `error` listener wired below.
			const sources = {
				"mapbox-dem": {
					type: "raster-dem",
					url: "mapbox://mapbox.mapbox-terrain-dem-v1",
					tileSize: 512,
					maxzoom: 14,
				},
			};
			// Solid background layer FIRST so the canvas always has a
			// non-transparent fill. Without this, when no basemap is
			// detected (custom-createTile layers, or before the raster
			// loads) the canvas stays transparent and Leaflet's default
			// `#ddd` container background bleeds through — grey screen.
			const layers = [
				{ id: "bg", type: "background", paint: { "background-color": "#c8c4b8" } },
			];
			const base = this._activeBaseTiles(map);
			if (base) {
				sources["active-base"] = {
					type: "raster",
					tiles: base.tiles,
					tileSize: 256,
					maxzoom: base.maxzoom,
				};
				layers.push({
					id: "active-base",
					type: "raster",
					source: "active-base",
					paint: { "raster-fade-duration": 0 },
				});
			} else {
				console.info(
					"[CustomTiles] 3D Mode: no URL-template basemap on map; " +
					"showing bare terrain. Switch to Google Hybrid / QLD Globe " +
					"/ MapTiler for draped imagery.");
			}
			layers.push({
				id: "sky",
				type: "sky",
				paint: { "sky-type": "atmosphere" },
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
					glyphs: "mapbox://fonts/mapbox/{fontstack}/{range}.pbf",
				},
				center: [c.lng, c.lat],
				zoom: Math.max(0, z - 1),  // Mapbox zoom is offset 1 below Leaflet
				pitch: 60,                  // Tilt for the actual 3D effect
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
				transformRequest: (url, resourceType) =>
					this._dwTransformRequest(url, resourceType),
			});
			mbMap.on("style.load", () => {
				mbMap.setTerrain({ source: "mapbox-dem", exaggeration: 1.5 });
				// Belt-and-braces resize: even with the right parent,
				// Mapbox's first layout pass occasionally beats CSS
				// settling on slower runs. Force a recomputation.
				try { mbMap.resize(); } catch (_) {}
				// Mirror every active Leaflet overlay tile-layer as a
				// Mapbox raster source so toggling layers in 2D shows
				// up draped on the 3D terrain. Then render every
				// Leaflet vector / marker shape (National Parks,
				// Geocaches, Flights, Vessels, OIM Power / Telecoms /
				// Water) as Mapbox GeoJSON layers. Route + waypoints
				// go on top last, then wire hover-popups for the
				// feature layers (INTVL, geocaches, flights, vessels).
				this._syncOverlays(map, mbMap);
				this._renderLeafletShapes(map, mbMap);
				this._renderRoute(map, mbMap);
				this._wireHoverPopups(mapboxgl, mbMap);
				// Initial marker sync — overrides Leaflet's flat-
				// projection positioning with Mapbox's tilted one so
				// the waypoint dots land on the correct terrain pixel
				// from the first frame, not after the user starts panning.
				this._syncMarkersToMapbox(map, mbMap);
				// Watch markerPane for any subsequent style mutations
				// (drag, zoom, programmatic setLatLng) so we re-sync
				// without depending on a Mapbox `move` event to fire.
				this._wireMarkerObserver(map, mbMap);
				// Watch the route's SVG path for in-place `setLatLngs`
				// updates (waypoint added / removed / re-routed) so the
				// 3D-rendered line stays in lock-step.
				this._wireRoutePathObserver(map, mbMap);
			});
			this._mbMap = mbMap;
			// Reset per-session caches: a fresh Mapbox instance has
			// no layers yet, so any "skip if signature matches" path
			// MUST run on its first call.
			this._wiredClick   = new Set();
			this._lastRouteSig = null;
			// Reset move-state flags so a previous session that
			// disabled mid-move can't leave the new session thinking
			// it's already moving (which would suppress marker sync
			// and keep markerPane hidden).
			this._isMoving = false;
			this._markerPanePrevVis = null;
			this._syncRequested = false;
			// Patch Leaflet's flat (Point → LatLng) methods to route
			// through Mapbox's terrain-aware unproject — fixes clicks
			// landing at the wrong terrain spot AND keeps dragged
			// marker latLngs honest.
			this._patchLeafletProjection(map);
			// Debug hooks: every reference console snippets need to
			// introspect the 3D state without re-deriving anything.
			//   _dwMb        — the Mapbox GL Map instance
			//   _dwMbBase    — the basemap spec mirrored from Leaflet
			//   _dwMap       — the Leaflet map (not exposed by dw)
			//   _dw3D        — this controller (so we can call methods)
			//   _dwRegistry  — the dw:// fetcher registry
			try {
				pageWin._dwMb        = mbMap;
				pageWin._dwMbBase    = base;
				pageWin._dwMap       = map;
				pageWin._dw3D        = this;
				pageWin._dwRegistry  = _dwMbLayers;
			} catch (_) {}
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
					const flat = (Array.isArray(latlngs[0]) ? latlngs.flat(Infinity) : latlngs)
						.filter(p => p && typeof p.lat === "number");
					if (flat.length < 2) return;
					lineFeatures.push({
						type: "Feature",
						geometry: { type: "LineString", coordinates: flat.map(p => [p.lng, p.lat]) },
						properties: {
							color: lyr.options?.color || "#9400D3",
							weight: Math.min(lyr.options?.weight || 5, 8),
						},
					});
				} else if (lyr instanceof L.Marker) {
					const p = lyr.getLatLng?.();
					if (!p) return;
					const el = lyr.getElement?.() || lyr._icon;
					const cls = el?.className || "";
					let color = null, radius = 9, label = "";
					if (cls.includes("dist-marker")) {
						color = "#9400D3"; radius = 7;
						label = (el.textContent || el.title || "").trim();
					} else if (cls.includes("lightgreen")) color = "#7fd14b";
					else if (cls.includes(" red"))        color = "#ff3030";
					else if (cls.includes(" blue"))       color = "#3b82f6";
					else if (cls.includes(" white"))      color = "#ffffff";
					else if (cls.includes("transparent")) return;
					else return;  // Skip non-route markers (Flights, Marine, Geocaches, etc.)
					pointFeatures.push({
						type: "Feature",
						geometry: { type: "Point", coordinates: [p.lng, p.lat] },
						properties: { color, radius, label },
					});
				}
			});
			return {
				line:   { type: "FeatureCollection", features: lineFeatures },
				points: { type: "FeatureCollection", features: pointFeatures },
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
			if (mb.isStyleLoaded && mb.isStyleLoaded()) { go(); return; }
			let fired = false;
			const once = () => { if (fired) return; fired = true; go(); };
			try { mb.once("idle", once); } catch (_) {}
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
				// Style isn't ready (e.g. _syncOverlays just added raster
				// sources at 3D init). Defer instead of dropping, so
				// overlays already active when 3D toggled on still mirror.
				// Dedup so rapid re-entry registers only one deferral.
				if (!this._shapesRetryPending) {
					this._shapesRetryPending = true;
					this._runWhenStyleReady(mbMap, () => {
						this._shapesRetryPending = false;
						this._renderLeafletShapes(map, mbMap);
					});
				}
				return;
			}
			const byPane = new Map();
			const bucket = (pane) => {
				let b = byPane.get(pane);
				if (!b) { b = { lines: [], polygons: [], points: [] }; byPane.set(pane, b); }
				return b;
			};
			// Recursive walker — `map.eachLayer` only iterates direct
			// children of the map, NOT the contents of L.LayerGroup /
			// L.FeatureGroup containers. Power / Telecoms / Water all
			// wrap their per-feature L.Polyline/Polygon/Marker
			// instances inside a feature group, so without the
			// recursion we'd see only the (empty-shaped) wrapper and
			// miss every actual feature.
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
				// Skip the default panes — those are handled elsewhere
				// (tile pane = base imagery, overlay pane = route SVG,
				// marker pane = waypoints, mapPane = container only).
				if (pane === "tilePane" || pane === "overlayPane" ||
					pane === "markerPane" || pane === "mapPane" ||
					pane === "tooltipPane" || pane === "popupPane" ||
					pane === "shadowPane") return;

				if (lyr instanceof L.Polygon) {
					const ll = lyr.getLatLngs();
					if (!ll || !ll.length) return;
					// L.Polygon nesting:
					//   [LatLng,…]                — simple polygon, one ring
					//   [[LatLng,…],[LatLng,…]]    — polygon with holes
					//   [[[LatLng,…],…],…]         — multipolygon
					const isLatLng = (x) => x && typeof x.lat === "number";
					let coordinates, type;
					if (isLatLng(ll[0])) {
						coordinates = [ll.map(p => [p.lng, p.lat])];
						coordinates[0].push(coordinates[0][0]);
						type = "Polygon";
					} else if (isLatLng(ll[0]?.[0])) {
						coordinates = ll.map(ring => {
							const c = ring.map(p => [p.lng, p.lat]);
							c.push(c[0]);
							return c;
						});
						type = "Polygon";
					} else {
						coordinates = ll.map(poly => poly.map(ring => {
							const c = ring.map(p => [p.lng, p.lat]);
							c.push(c[0]);
							return c;
						}));
						type = "MultiPolygon";
					}
					bucket(pane).polygons.push({
						type: "Feature",
						geometry: { type, coordinates },
						properties: {
							color:       opts.color       || "#888",
							fillColor:   opts.fillColor   || opts.color || "#888",
							fillOpacity: opts.fillOpacity != null ? opts.fillOpacity : 0.25,
							opacity:     opts.opacity     != null ? opts.opacity : 0.9,
							weight:      opts.weight      || 1,
						},
					});
				} else if (lyr instanceof L.Polyline) {
					const ll = lyr.getLatLngs();
					if (!ll || !ll.length) return;
					const flat = (Array.isArray(ll[0]) ? ll.flat(Infinity) : ll)
						.filter(p => p && typeof p.lat === "number");
					if (flat.length < 2) return;
					bucket(pane).lines.push({
						type: "Feature",
						geometry: { type: "LineString", coordinates: flat.map(p => [p.lng, p.lat]) },
						properties: {
							color:   opts.color   || "#888",
							opacity: opts.opacity != null ? opts.opacity : 1,
							weight:  opts.weight  || 2,
						},
					});
				} else if (lyr instanceof L.CircleMarker || lyr instanceof L.Circle) {
					const p = lyr.getLatLng?.();
					if (!p) return;
					bucket(pane).points.push({
						type: "Feature",
						geometry: { type: "Point", coordinates: [p.lng, p.lat] },
						properties: {
							color:  opts.fillColor || opts.color || "#888",
							radius: opts.radius     || 5,
						},
					});
				} else if (lyr instanceof L.Marker) {
					const p = lyr.getLatLng?.();
					if (!p) return;
					const el  = lyr.getElement?.() || lyr._icon;
					const cls = el?.className || "";
					// `_dwData` is the per-layer hook (geocaches +
					// future planes/vessels). When present it overrides
					// the per-pane defaults so 3D dots match the 2D
					// colour-coding (e.g. found-cache grey vs available
					// type colour) and carry whatever url/code the
					// click handler needs to open the right page.
					const dwData = lyr._dwData || null;
					const paneColor = {
						dwGeocachingPane: "#2da44e",
						dwFlightsPane:    "#0066ff",
						dwMarinePane:     "#00a3c9",
						dwInfraPane:      "#F0A500",
						dwTelecomPane:    "#7C3AED",
						dwWaterPane:      "#0EA5E9",
					}[pane] || "#888";
					bucket(pane).points.push({
						type: "Feature",
						geometry: { type: "Point", coordinates: [p.lng, p.lat] },
						properties: {
							color:  dwData?.color || paneColor,
							radius: dwData?.radius || 5,
							label:  dwData?.label || "",
							url:    dwData?.url   || "",
							kind:   dwData?.kind  || "",
							// Full data for hover popups. Mapbox JSON-
							// serialises feature properties, so primitives
							// only — booleans + strings + numbers.
							name:    dwData?.name  || "",
							code:    dwData?.code  || "",
							diff:    dwData?.diff,
							terr:    dwData?.terr,
							favs:    dwData?.favs,
							size:    dwData?.size  || "",
							owner:   dwData?.owner || "",
							found:   !!dwData?.found,
							dnf:     !!dwData?.dnf,
							className: cls,
						},
					});
				}
			};
			map.eachLayer(visit);

			// Two-pass drop. Several shape sources have multiple
			// dependent layers (point + label, polygon fill + outline),
			// and Mapbox throws if you try to drop a source while a
			// layer still uses it.
			const oldIds = this._shapeIds || [];
			for (const id of oldIds) {
				try { if (mbMap.getLayer(id)) mbMap.removeLayer(id); } catch (_) {}
			}
			for (const id of oldIds) {
				try { if (mbMap.getSource(id)) mbMap.removeSource(id); } catch (_) {}
			}
			this._shapeIds = [];

			const beforeId = mbMap.getLayer("dw-route-line") ? "dw-route-line" :
				(mbMap.getLayer("sky") ? "sky" : undefined);

			for (const [pane, b] of byPane) {
				if (b.polygons.length) {
					const id = `dw-shapes-poly-${pane}`;
					mbMap.addSource(id, {
						type: "geojson",
						data: { type: "FeatureCollection", features: b.polygons },
					});
					mbMap.addLayer({
						id, type: "fill", source: id,
						paint: {
							"fill-color":   ["coalesce", ["get", "fillColor"], "#888"],
							"fill-opacity": ["coalesce", ["get", "fillOpacity"], 0.25],
						},
					}, beforeId);
					this._shapeIds.push(id);
					const outlineId = id + "-outline";
					mbMap.addLayer({
						id: outlineId, type: "line", source: id,
						paint: {
							"line-color":   ["coalesce", ["get", "color"], "#888"],
							"line-width":   ["coalesce", ["get", "weight"], 1],
							"line-opacity": ["coalesce", ["get", "opacity"], 0.9],
							"line-emissive-strength": 1,
						},
					}, beforeId);
					this._shapeIds.push(outlineId);
				}
				if (b.lines.length) {
					const id = `dw-shapes-line-${pane}`;
					mbMap.addSource(id, {
						type: "geojson",
						data: { type: "FeatureCollection", features: b.lines },
					});
					mbMap.addLayer({
						id, type: "line", source: id,
						layout: { "line-cap": "round", "line-join": "round" },
						paint: {
							"line-color":   ["coalesce", ["get", "color"], "#888"],
							"line-width":   ["coalesce", ["get", "weight"], 2],
							"line-opacity": ["coalesce", ["get", "opacity"], 1],
							"line-emissive-strength": 1,
						},
					}, beforeId);
					this._shapeIds.push(id);
				}
				if (b.points.length) {
					const id = `dw-shapes-point-${pane}`;
					mbMap.addSource(id, {
						type: "geojson",
						data: { type: "FeatureCollection", features: b.points },
					});
					mbMap.addLayer({
						id, type: "circle", source: id,
						paint: {
							"circle-radius":       ["coalesce", ["get", "radius"], 5],
							"circle-color":        ["coalesce", ["get", "color"], "#888"],
							"circle-stroke-width": 1,
							"circle-stroke-color": "#ffffff",
							"circle-emissive-strength": 1,
						},
					}, beforeId);
					this._shapeIds.push(id);
					// Add a single-letter type label (caches show G/M/T/etc.,
					// drone-style; flights/vessels carry empty labels so the
					// symbol layer renders nothing for them).
					const labelId = id + "-label";
					mbMap.addLayer({
						id: labelId, type: "symbol", source: id,
						filter: ["all", ["has", "label"], ["!=", ["get", "label"], ""]],
						layout: {
							"text-field":            ["get", "label"],
							"text-font":             ["Open Sans Bold", "Arial Unicode MS Bold"],
							"text-size":             9,
							"text-allow-overlap":    true,
							"text-ignore-placement": true,
						},
						paint: {
							"text-color":             "#ffffff",
							"text-halo-color":        "#000",
							"text-halo-width":        1,
							"text-emissive-strength": 1,
						},
					}, beforeId);
					this._shapeIds.push(labelId);
					// One click handler per circle layer that opens
					// whatever URL the source feature carries. Wire it
					// once per source — Mapbox dedups by (layer, type).
					if (!this._wiredClick) this._wiredClick = new Set();
					if (!this._wiredClick.has(id)) {
						this._wiredClick.add(id);
						mbMap.on("click", id, (e) => {
							const url = e.features?.[0]?.properties?.url;
							if (url) window.open(url, "_blank", "noopener");
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
					closeButton:  false,
					closeOnClick: false,
					className:    "dw-mb-popup",
					offset:       12,
				});
			}
			const popup = this._popup;
			const bind = (layerId, fmt) => {
				if (!mbMap.getLayer(layerId)) return;
				if (!this._hoverBound) this._hoverBound = new Set();
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

			// INTVL territories — currentArea (m²), startTime (day
			// offset), colour, activityId (cuid → precise time).
			bind("dw-cust-0-fill", (f) => {
				const p = f.properties || {};
				const swatch = p.colour
					? `<span style="display:inline-block;width:12px;height:12px;background:${p.colour};border:1px solid #888;vertical-align:middle;margin-right:6px;"></span>`
					: "";
				const area = p.currentArea != null ? intvlArea(p.currentArea) : "?";
				const dt   = p.activityId ? intvlActivityTime(p.activityId) : null;
				const ago  = dt ? intvlAgo(dt) : "";
				return `${swatch}<b>${area}</b>` +
					(ago ? `<br><span style="font-size:11px;color:#666">${ago}</span>` : "");
			});

			// Geocaches — name, code, D/T, size, favs, owner.
			bind("dw-shapes-point-dwGeocachingPane", (f) => {
				const p = f.properties || {};
				if (!p.name && !p.code) return "";
				const lines = [`<b>${_escHtml(p.name || p.code)}</b>` +
					(p.found ? " ✓" : p.dnf ? " ✗" : "")];
				const meta = [];
				if (p.code) meta.push(_escHtml(p.code));
				if (p.diff != null && p.terr != null) meta.push(`D ${p.diff} / T ${p.terr}`);
				if (p.size) meta.push(_escHtml(String(p.size)));
				if (p.favs) meta.push(`♥ ${p.favs}`);
				if (meta.length) lines.push(
					`<span style="font-size:11px;color:#666">${meta.join(" · ")}</span>`);
				if (p.owner) lines.push(
					`<span style="font-size:11px;color:#666">by ${_escHtml(p.owner)}</span>`);
				return lines.join("<br>");
			});

			// Flights — currently just a placeholder dot; richer data
			// would come from the layer provider attaching _dwData.
			bind("dw-shapes-point-dwFlightsPane", (f) => {
				const p = f.properties || {};
				return p.label || p.name || "Aircraft";
			});

			// Marine vessels — same placeholder.
			bind("dw-shapes-point-dwMarinePane", (f) => {
				const p = f.properties || {};
				return p.label || p.name || "Vessel";
			});
		}

		_renderRoute(map, mbMap) {
			// Don't gate on `isStyleLoaded()` — Mapbox sometimes
			// returns false INSIDE the very `style.load` callback that
			// called us. `mbMap.once("style.load", ...)` then schedules
			// a handler that never fires (style.load already fired),
			// and the route line silently never gets added. Same race
			// already fixed for `_syncOverlays`. Probe via `getStyle()`
			// which returns truthy as soon as the style object exists,
			// and re-poll on the next frame if not.
			if (!mbMap.getStyle?.()) {
				requestAnimationFrame(() => this._renderRoute(map, mbMap));
				return;
			}
			const { line } = this._extractRouteGeojson(map);
			// Cheap content-equality check — skip the source-remove +
			// re-add cycle if nothing about the geometry changed.
			// Per feature we hash: coord count + first coord + last
			// coord + mid coord. Catches every kind of in-place edit
			// (waypoint add/remove changes counts; midpoint drag
			// changes the mid; endpoint drag changes first/last)
			// without serialising every coord.
			const sig = line.features.map((f) => {
				const c = f.geometry.coordinates;
				const n = c.length;
				if (!n) return "0";
				const fst = c[0],   lst = c[n - 1], mid = c[n >> 1];
				return `${n}:${fst[0]},${fst[1]}|${mid[0]},${mid[1]}|${lst[0]},${lst[1]}`;
			}).join(";");
			if (sig === this._lastRouteSig) return;
			this._lastRouteSig = sig;
			// Only the line layer is Mapbox-rendered now — the
			// waypoint dots + distance numbers come from Leaflet's
			// markerPane (which we no longer hide in 3D mode) so
			// drag-to-edit keeps working. Avoid double-rendering by
			// dropping the dw-route-points / dw-route-labels layers.
			for (const id of ["dw-route-line", "dw-route-points", "dw-route-labels"]) {
				try { if (mbMap.getLayer(id)) mbMap.removeLayer(id); } catch (_) {}
			}
			for (const id of ["dw-route-line", "dw-route-points"]) {
				try { if (mbMap.getSource(id)) mbMap.removeSource(id); } catch (_) {}
			}
			const beforeId = mbMap.getLayer("sky") ? "sky" : undefined;
			mbMap.addSource("dw-route-line", { type: "geojson", data: line });
			mbMap.addLayer({
				id: "dw-route-line", type: "line", source: "dw-route-line",
				layout: { "line-cap": "round", "line-join": "round" },
				paint: {
					"line-color":   ["coalesce", ["get", "color"], "#9400D3"],
					"line-width":   ["coalesce", ["get", "weight"], 6],
					"line-opacity": 0.9,
					"line-emissive-strength": 1,
				},
			}, beforeId);
		}

		// Hook layer-internal events that should trigger a re-sync.
		// Used by QLD Historical's `capturechange` (scrubber moved) so
		// the 3D mirror swaps to the new mosaicRule URL. Idempotent —
		// listeners are tracked per (layer, event) pair so we don't
		// double-hook on repeat syncs.
		_wireReloadEvents(map, mbMap) {
			if (!this._reloadHooks) this._reloadHooks = new WeakSet();
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
					try { lyr.on(evt, handler); } catch (_) {}
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
			// Authoritative base/overlay split via the layer control's
			// own registry. Falls back to a pane heuristic (default
			// tilePane → base) if the control isn't reachable yet.
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
				isBase,
			};
			// Layers that publish a full Mapbox style spec (INTVL
			// vector, future OIM vector ports) are added separately by
			// _syncOverlays' custom-style walker — skip the raster
			// path so we don't add a redundant (and wrongly-shaped)
			// raster source too.
			if (lyr._dwMb3DStyle) return null;
			// Getter form — evaluated at every sync so token-aware
			// URLs (QLD Roads, QLD Globe — tokens rotate every few
			// hours) always reflect the current credential. Empty /
			// nullish return drops the layer for this sync; the
			// pending flag triggers a 3s retry from _syncOverlays so
			// the layer pops into 3D once the dependency resolves.
			if (typeof lyr._dwMb3DGetUrl === "function") {
				const url = lyr._dwMb3DGetUrl();
				if (url) return { ...base, url };
				this._hadPendingGetter = true;
				return null;
			}
			// Static Mapbox-native URL template (`{z}/{x}/{y}` or
			// `{bbox-epsg-3857}`). For layers whose URL doesn't depend
			// on anything that changes mid-session.
			if (lyr._dwMb3DUrl) {
				return { ...base, url: lyr._dwMb3DUrl };
			}
			// GM-fetcher-backed layers (Stamen Origin-spoof, QLD
			// Historical async catalog, Garmin canvas composite). On a
			// Mapbox build with addProtocol we'd use dw://; since v3 has
			// none, emit the sentinel template that the map's
			// transformRequest bridge serves from GM-fetched blobs.
			if (lyr._dwMbKey) {
				const url = _dwMbHasProtocol
					? `dw://${lyr._dwMbKey}/{z}/{x}/{y}.png`
					: dwTileSentinel(lyr._dwMbKey);
				return { ...base, url };
			}
			// Plain L.TileLayer with a `{z}/{x}/{y}` URL template.
			if (!(lyr instanceof L.TileLayer)) return null;
			const url = lyr._url;
			if (typeof url !== "string" || url.length < 5) return null;
			if (!/\{z\}/.test(url)) return null;
			if (!/\{[xy]\}/.test(url)) return null;
			const subs = opts.subdomains;
			const sub = Array.isArray(subs) ? subs[0] :
				(typeof subs === "string" && subs.length ? subs[0] : "a");
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
			// https://dwtile.local/<key>/<z>/<x>/<y>.png[?r=N]
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
			if (!fetcher) { _dwTileFailed.set(cacheKey, Date.now()); return; }
			_dwTileInflight.add(cacheKey);
			Promise.resolve()
				.then(() => fetcher(z, x, y))
				.then((ab) => {
					_dwTileInflight.delete(cacheKey);
					if (!ab) { _dwTileFailed.set(cacheKey, Date.now()); return; }
					_dwTileFailed.delete(cacheKey);
					const blobUrl = URL.createObjectURL(
						new Blob([ab], { type: "image/png" }));
					_dwTileBlobs.set(cacheKey, blobUrl);
					_dwTileEvict();
					this._dwTilesDirty = true;
					this._scheduleTileReload();
				})
				.catch(() => {
					_dwTileInflight.delete(cacheKey);
					_dwTileFailed.set(cacheKey, Date.now());
					// A completed fetch (even a failure) may be the last one
					// blocking a deferred reload — re-evaluate.
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
				if (_dwTileInflight.size > 0) { this._scheduleTileReload(); return; }
				if (!this._dwTilesDirty) return;
				this._dwTilesDirty = false;
				const sources = mb.getStyle().sources || {};
				const r = (this._dwReloadCounter = (this._dwReloadCounter || 0) + 1);
				for (const [id, src] of Object.entries(sources)) {
					const t = src && src.tiles && src.tiles[0];
					if (src.type !== "raster" || !t ||
						t.lastIndexOf(DW_TILE_PREFIX, 0) !== 0) continue;
					const base = t.split("?")[0];
					const s = mb.getSource(id);
					if (s && s.setTiles) {
						try { s.setTiles([`${base}?r=${r}`]); } catch (_) {}
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
			// Standalone entry — `_fullResync` calls the same code but
			// owns the `_hadPendingGetter` reset because it ALSO calls
			// `_activeBaseTiles` (which can set the flag). Re-zero it
			// here only when invoked directly (e.g. from style.load).
			if (!this._inFullResync) this._hadPendingGetter = false;
			return this._syncOverlaysImpl(map, mbMap);
		}

		_syncOverlaysImpl(map, mbMap) {
			if (!mbMap) return;
			// Don't gate on `isStyleLoaded()` — Mapbox sometimes
			// returns false *inside* the style.load callback (race
			// between event dispatch and the internal flag). Instead
			// wrap the actual addSource/addLayer calls in try/catch
			// and re-run on next animation frame if Mapbox isn't ready.
			if (!mbMap.getStyle?.()) {
				requestAnimationFrame(() => this._syncOverlaysImpl(map, mbMap));
				return;
			}
			// Re-hide any panes created since the last sync (e.g.
			// when a custom-canvas layer like INTVL or OIM Power is
			// toggled on AFTER 3D was enabled — its onAdd creates a
			// custom pane that defaults to opacity 1, so without
			// this it would render its 2D content on top of the
			// 3D scene, producing the double-render artefact).
			this._hideHiddenable(map);
			// Hook any `_dwMb3DReloadOn` events so layer-internal
			// state changes (e.g. QLD Historical's `capturechange`
			// when the scrubber moves to a different date) trigger a
			// resync — which re-runs the URL getter and refetches
			// tiles for the new capture.
			this._wireReloadEvents(map, mbMap);
			// Two-pass remove (layers, then sources). INTVL's vector
			// source has a dependent fill layer; OIM future port will
			// have multiple. Without two passes, source removal fails.
			const oldIds = this._overlayIds || [];
			for (const id of oldIds) {
				try { if (mbMap.getLayer(id)) mbMap.removeLayer(id); } catch (_) {}
			}
			for (const id of oldIds) {
				try { if (mbMap.getSource(id)) mbMap.removeSource(id); } catch (_) {}
			}
			this._overlayIds = [];
			// Insert overlay layers BEFORE the route line so the route
			// stays visible on top. Sky stays above everything.
			const beforeId = mbMap.getLayer("dw-route-line") ? "dw-route-line" :
				(mbMap.getLayer("sky") ? "sky" : undefined);
			const specs = this._extractOverlayLayers(map);
			specs.forEach((spec, i) => {
				const id = `dw-overlay-${i}`;
				try {
					mbMap.addSource(id, {
						type: "raster", tiles: [spec.url],
						tileSize: 256, maxzoom: spec.maxzoom,
					});
					mbMap.addLayer({
						id, type: "raster", source: id,
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
							"raster-emissive-strength": 1,
						},
					}, beforeId);
					this._overlayIds.push(id);
				} catch (e) {
					console.warn("[CustomTiles] 3D overlay mirror failed:", spec.url, e.message);
				}
			});
			// Custom Mapbox styles attached via `_dwMb3DStyle` (e.g.
			// INTVL's vector source). Each prefix-namespaces its
			// sources / layer ids so multiple layers don't collide,
			// and IDs are tracked on `_overlayIds` for the next purge.
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
				for (const layer of (style.layers || [])) {
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
			// One-shot retry if any token-aware getter returned null
			// — gives the QLD CSRF/token bootstrap time to complete on
			// its async path, then re-mirrors so QLD Roads / QLD Globe
			// pop in once their tokens land.
			if (this._hadPendingGetter && !this._pendingRetry) {
				this._pendingRetry = setTimeout(() => {
					this._pendingRetry = null;
					if (this._active && this._mbMap) {
						this._syncOverlays(map, this._mbMap);
					}
				}, 3000);
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
			// Self-pruning: when dynamic.watch removes a marker via
			// a path that DOESN'T fire `layerremove` (e.g. inside a
			// LayerGroup whose parent is removed, or a marker reused
			// for a different waypoint), the icon ends up detached
			// from the markerPane but our cache still holds it. We
			// then keep writing translate3d() to a detached DOM
			// node — invisible but cosmetic garbage. Worse, if the
			// marker's icon is re-attached later (Leaflet caches
			// elements), we re-position a phantom that the user
			// thought was deleted. Pruning at sync time keeps the
			// cache honest with no per-frame DOM cost beyond what
			// we're already doing for the live markers.
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
			// Project markers via plain `mb.project([lng, lat])`. This
			// puts them at the sea-level pixel for the lng/lat, which
			// is what the Mapbox line layer also uses for the route
			// without `line-elevation-reference: "ground"`. The
			// terrain-aware path through `transform.locationPoint3D`
			// returns coordinates in a different space and pushes
			// markers off-screen — keeping plain project for now.
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
				// Keep Leaflet's tracked position in lock-step with
				// the visual transform — L.Draggable's drag math
				// reads it as `_startPos`, so leaving it stale at
				// Leaflet's flat-projection value causes the drag
				// to compute a cursor position offset from where
				// the user actually sees the marker.
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
			this._markerCache = new Set();
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
			map.on("layeradd",    this._onMarkerAdd);
			map.on("layerremove", this._onMarkerRemove);
		}

		_unwireMarkerCache(map) {
			if (this._onMarkerAdd)    map.off("layeradd",    this._onMarkerAdd);
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
			// Mapbox can return extreme (or NaN) lat/lng when asked
			// to unproject a screen point above the horizon in a
			// pitched view, or any pixel beyond the canvas. Falling
			// back to Leaflet's flat unproject in those cases stops
			// dragged waypoints from jumping to the antipode.
			const project = (sx, sy) => {
				const mb = controller._mbMap;
				const canvas = mb.getCanvas?.();
				const w = canvas?.clientWidth  || 0;
				const h = canvas?.clientHeight || 0;
				if (sx < 0 || sy < 0 || (w && sx > w) || (h && sy > h)) return null;
				const ll = mb.unproject([sx, sy]);
				if (!ll || !isFinite(ll.lat) || !isFinite(ll.lng)) return null;
				if (Math.abs(ll.lat) > 85 || Math.abs(ll.lng) > 180) return null;
				return L.latLng(ll.lat, ll.lng);
			};
			map.containerPointToLatLng = function (point) {
				if (controller._active && controller._mbMap) {
					try {
						const ll = project(point.x, point.y);
						if (ll) return ll;
					} catch (_) {}
				}
				return origCPtoLL(point);
			};
			map.layerPointToLatLng = function (point) {
				if (controller._active && controller._mbMap) {
					try {
						// `_getMapPanePos()` reads Leaflet's own
						// authoritative `_leaflet_pos` on the
						// mapPane — more reliable than parsing the
						// `style.transform` CSS (different browsers
						// sometimes serialise the value differently).
						const pp = map._getMapPanePos?.() || L.point(0, 0);
						const ll = project(point.x + pp.x, point.y + pp.y);
						if (ll) return ll;
					} catch (_) {}
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
			const isDragging = () =>
				document.body.classList.contains("leaflet-dragging");
			this._markerObserver = new MutationObserver(() => {
				if (syncing || !this._mbMap) return;
				if (isDragging()) return;
				syncing = true;
				try { this._requestMarkerSync(map, mbMap); }
				finally {
					requestAnimationFrame(() => { syncing = false; });
				}
			});
			this._markerObserver.observe(markerPane, {
				attributes: true,
				subtree: true,
				attributeFilter: ["style"],
			});
			// Body-class observer: catches the transition from
			// `leaflet-dragging` → not-dragging so we can re-sync
			// once after a drag ends (the marker-pane observer
			// doesn't fire again on its own at that moment because
			// Leaflet's finishDrag doesn't mutate marker styles).
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
				attributeFilter: ["class"],
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
				attributeFilter: ["d"],
			});
		}

		_wireSync(map) {
			// One-way sync: Mapbox → Leaflet. Every Mapbox `move` frame
			// (drag, scroll, orbit, fly) feeds back into Leaflet so the
			// underlying 2D state stays in sync — when the user toggles
			// 3D off, Leaflet is already where the Mapbox camera left
			// it. The reverse direction (Leaflet → Mapbox) is NOT
			// wired: while 3D is on Mapbox owns gestures and Leaflet's
			// `zoomend` events from our own sync would snap Mapbox back
			// mid-animation, producing a double-zoom artefact.
			// Hide markerPane on movestart, show + resync on moveend.
			// Per-frame Mapbox→Leaflet reprojection of every marker
			// can't keep up cleanly during fast rotation / zoom —
			// markers visually slide along curves that look glitchy
			// even when the math is right (Leaflet's marker icon is a
			// CSS-positioned div that doesn't share Mapbox's 3D
			// projection pipeline). Hiding the whole pane during
			// motion is both perfect-looking (no slide) AND much
			// cheaper than projecting N markers at 60 Hz.
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
					// Mapbox z = Leaflet z - 1 because our raster sources
					// declare tileSize: 256 while Mapbox defaults to 512.
					// Without the +1, the mirrored basemap renders at
					// half the user's expected scale.
					map.setView([c.lat, c.lng], Math.round(z + 1),
						{ animate: false });
					// Skip the per-frame marker sync while the pane is
					// hidden — it's invisible, no point projecting.
					if (!this._isMoving) {
						this._syncMarkersToMapbox(map, this._mbMap);
					}
				} catch (_) {}
			};
			this._handler3DMoveEnd = () => {
				this._isMoving = false;
				const p = map.getPane("markerPane");
				if (p && this._markerPanePrevVis != null) {
					p.style.visibility = this._markerPanePrevVis;
					this._markerPanePrevVis = null;
				}
				// Final sync at rest so markers land on the new
				// camera state before the pane unhides.
				try { this._syncMarkersToMapbox(map, this._mbMap); } catch (_) {}
			};
			this._handlerResize = () => {
				if (!this._mbMap) return;
				try { this._mbMap.resize(); } catch (_) {}
			};
			this._mbMap.on("movestart", this._handler3DMoveStart);
			this._mbMap.on("move",      this._handler3DMove);
			this._mbMap.on("moveend",   this._handler3DMoveEnd);
			map.on("resize", this._handlerResize);
		}

		_unwireSync(map) {
			if (this._mbMap) {
				try { if (this._handler3DMoveStart) this._mbMap.off("movestart", this._handler3DMoveStart); } catch (_) {}
				try { if (this._handler3DMove)      this._mbMap.off("move",      this._handler3DMove); } catch (_) {}
				try { if (this._handler3DMoveEnd)   this._mbMap.off("moveend",   this._handler3DMoveEnd); } catch (_) {}
			}
			if (this._handlerResize) {
				map.off("resize", this._handlerResize);
			}
			// Restore markerPane visibility if we were in a mid-move
			// state when disable fired (no moveend would arrive after
			// mbMap is gone).
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
				// GM-bridge raster layers (Garmin is an L.GridLayer, not a
				// TileLayer) mirror as raster overlays via `_syncOverlays`,
				// which only the FULL resync runs. Without this they'd take
				// the light (shapes-only) path when toggled on in 3D and
				// silently never appear until a 3D off/on cycle.
				if (lyr._dwMbKey) return true;
				return false;
			};
			// `aliveCheck` runs inside every queued setTimeout so a
			// debounce that was scheduled while 3D was active but
			// fires after `disable()` (mbMap removed, _active=false)
			// becomes a silent no-op rather than calling into a
			// destroyed Mapbox style. The "Cannot read properties of
			// undefined (reading 'getOwnLayer')" warnings the stress
			// test was seeing came from this race.
			const aliveCheck = (mb) =>
				this._active && this._mbMap === mb && mb.getStyle?.();
			this._baseTracker = (e) => {
				const mb = this._mbMap;
				if (!mb) return;
				// Synchronously hide any newly-created pane BEFORE
				// the 80ms debounce fires. Cadastre / QPWS / Mobile
				// Coverage etc. create their custom pane in onAdd;
				// during the debounce window the pane is visible and
				// the Leaflet tile cache paints into it as a flat
				// overlay — visible to the user as the layer "showing
				// in 2D" until the next sync finally hides the pane.
				// (DOM-only; safe even before the Mapbox style is ready.)
				this._hideHiddenable(map);
				const isBase = e?.type === "baselayerchange";
				const wantsFull = isBase || needsFullResync(e?.layer);
				// NB: do NOT gate the whole handler on isStyleLoaded() —
				// removing the previous base flips it false transiently,
				// so a switch made before the prior layer finished
				// rendering would be dropped (the "changing layers
				// doesn't update the imagery" bug). Debounce, then run
				// once the style is ready via `_runWhenStyleReady`.
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
			// Own the pending-getter reset for this whole pass so the
			// base + overlay flag tracking are unified — otherwise
			// `_syncOverlays` would reset the flag set by
			// `_activeBaseTiles` and we'd lose the retry signal.
			this._hadPendingGetter = false;
			this._inFullResync = true;
			try {
				const t = this._activeBaseTiles(map);
				// Always tear down + re-add the base in a known order
				// rather than `setTiles`-in-place. The reason: when
				// QLD Historical's catalog resolves AFTER overlays
				// have been added, an in-place addLayer (beforeId:
				// "sky") lands between the overlays and sky — i.e.
				// ON TOP of the overlays. Re-inserting it just above
				// `bg` guarantees the correct stacking regardless of
				// the order events arrived in.
				if (mb.getLayer("active-base")) mb.removeLayer("active-base");
				if (mb.getSource("active-base")) mb.removeSource("active-base");
				if (t) {
					mb.addSource("active-base", {
						type: "raster", tiles: t.tiles,
						tileSize: 256, maxzoom: t.maxzoom,
					});
					// Insert immediately after `bg` (the background
					// solid colour). Without `bg` (it should always
					// exist) fall back to whatever's first.
					const allLayers = mb.getStyle().layers;
					const bgIdx = allLayers.findIndex(l => l.id === "bg");
					const afterBgId = allLayers[bgIdx + 1]?.id;
					mb.addLayer({
						id: "active-base", type: "raster",
						source: "active-base",
						paint: { "raster-fade-duration": 0 },
					}, afterBgId);
				}
			} catch (e) {
				console.warn("[CustomTiles] 3D basemap swap failed:", e.message);
			}
			this._syncOverlays(map, mb);
			this._renderLeafletShapes(map, mb);
			this._renderRoute(map, mb);
			// Enforce final layer order so neither a late addLayer
			// (Strava re-mirrored after active-base was rebuilt) nor
			// a Mapbox style-load reorder can leave the base painted
			// ON TOP of the overlays. The "Strava heatmap not
			// rendering above the base" symptom was exactly this
			// race. Bottom-to-top:
			//   bg → active-base → overlays → shapes → route → sky
			try {
				const want = ["bg", "active-base",
					...(this._overlayIds || []),
					...(this._shapeIds   || []),
					"dw-route-line", "sky"];
				for (let i = 0; i < want.length - 1; i++) {
					const id = want[i], next = want[i + 1];
					if (mb.getLayer(id) && mb.getLayer(next)) {
						mb.moveLayer(id, next);
					}
				}
				if (mb.getLayer("sky")) mb.moveLayer("sky");
			} catch (_) {}
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
	}

	// Injects a 3D-toggle button into dynamic.watch's native
	// `.leaflet-planner-controls` row (the bar with travel-mode / undo /
	// save / elevation / distance). The row is rendered late by the
	// site's planner React tree, so we wait for it via MutationObserver.
	// The button mimics the native `btn btn-default fixed-width` styling
	// so it sits flush; an `active` class darkens it when 3D is on.
	class Mode3DButton {
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
				// Restore prior on/off state. Defer the actual enable so the
				// site's planner finishes initialising — Mapbox GL grabbing
				// the canvas before Leaflet is settled tends to thrash.
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
			// If after 15s we still haven't found `.leaflet-planner-controls`,
			// dynamic.watch most likely renamed or restructured the DOM. Log a
			// clear, actionable warning so the user knows it's not their setup.
			const timeoutId = setTimeout(() => {
				if (document.querySelector(".dw-3d-btn")) return;
				obs.disconnect();
				console.warn(
					"[CustomTiles] 3D button not injected after 15s — couldn't find" +
					" `.leaflet-planner-controls` in dynamic.watch's DOM. The site" +
					" likely renamed or restructured its planner toolbar. Please file" +
					" an issue at" +
					" https://github.com/CalculatedCausality/dynamicWatch-Custom-Tiles/issues" +
					" with a screenshot + browser version. The userscript will" +
					" continue running, only the 3D toggle is affected.",
				);
			}, 15_000);
		}
	}

	/* -- Layer Manager UI -------------------------------------------------- */

	class LayerManagerUI {
		constructor(ctrl) {
			this._ctrl = ctrl;
		}

		// -- Archive persistence ------------------------------------------

		getArchived() {
			try {
				return new Set(
					JSON.parse(localStorage.getItem(CFG.ARCHIVE_KEY) || "[]"),
				);
			} catch (e) {
				return new Set();
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
				grp.style.display =
					all.length && all.every((l) => l.style.display === "none")
						? "none"
						: "";
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
			wrap.innerHTML =
				'<a href="#" class="dw-manage-link">&#9881;&#160;Manage layers</a>';
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
				return (
					`<label class="dw-manager-row${isActive ? " dw-manager-row--active" : ""}">` +
					`<input type="checkbox" id="${_escHtml(chkId)}"` +
					` data-name="${_escHtml(item.name)}"` +
					(checked ? " checked" : "") +
					(isActive
						? ' disabled title="Switch to another layer before archiving this one"'
						: "") +
					`><span class="dw-manager-name">${_escHtml(displayName || item.name)}</span>` +
					(isActive ? '<span class="dw-badge">active</span>' : "") +
					"</label>"
				);
			};
			const usedNames = new Set();
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
			panel.innerHTML =
				'<p class="dw-manager-hint">Uncheck a layer to hide it from the map&#8209;type selector.</p>' +
				`<div class="dw-manager-list">${rows}</div>` +
				'<div class="dw-manager-footer"><a href="#" class="dw-back-link">&#8592;&#160;Back</a></div>';
			base.appendChild(panel);

			panel
				.querySelector(".dw-manager-list")
				.addEventListener("change", (e) => {
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
	}

	/* -- Application ------------------------------------------------------- */

	class CustomTilesApp {
		constructor() {
			this.qldToken = new QldTokenManager({
				serviceUrl: CFG.QLD_SERVICE,
				storageKey: "qld_token",
				label: "QLD Globe",
			});
			// Separate manager scoped to the QImagery service; the public-token
			// endpoint scopes by the `url` it's POSTed with, and the Globe token
			// gets 403s on QImagery (historical aerial photos).
			this.qldPhotosToken = new QldTokenManager({
				serviceUrl: CFG.QLD_HIST_PHOTOS_SERVICE,
				storageKey: "qld_photos_token",
				label: "QLD Photos",
			});
			this.appleToken = new AppleTokenManager();
			this.layers = {};
			this.injected = false;
			this.histCompass = null;
			this.waybackHistControl = null;

			// Wire token refresh callbacks so the managers don't need layer references.
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
							err.message,
						);
				});
			}

			this._patchControlLayers();
		}

		// -- Leaflet interception -----------------------------------------

		_patchControlLayers() {
			if (
				typeof pageWin.L !== "undefined" &&
				pageWin.L.control &&
				pageWin.L.tileLayer
			) {
				this._applyPatch();
			} else {
				try {
					Object.defineProperty(pageWin, "L", {
						configurable: true,
						enumerable: true,
						set: (val) => {
							Object.defineProperty(pageWin, "L", {
								value: val,
								writable: true,
								configurable: true,
								enumerable: true,
							});
							if (val && val.control && val.tileLayer) this._applyPatch();
						},
					});
				} catch (e) {
					console.warn("[CustomTiles] defineProperty fallback:", e.message);
					const poll = () => {
						if (
							typeof pageWin.L !== "undefined" &&
							pageWin.L.control &&
							pageWin.L.tileLayer
						) {
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
			L.control.layers = function (baseLayers, overlays, opts) {
				const ctrl = orig.apply(this, arguments);
				const isMain = baseLayers && Object.keys(baseLayers).length >= 1;
				if (isMain) {
					const _addTo = ctrl.addTo.bind(ctrl);
					ctrl.addTo = function (m) {
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
			// Mode3DController reads `this._app._ctrl` to decide which
			// layers are bases vs overlays (the L.Control.Layers
			// internal registry has the authoritative `overlay`
			// boolean — needed to correctly classify overlays that
			// LIVE in tilePane like Strava Heatmap). Set here so the
			// `_layerToMbSpec` path doesn't fall back to the pane
			// heuristic, which would misclassify Strava as a base.
			this._ctrl = ctrl;
			// Expose for the e2e harness (Playwright) so it can flip
			// overlays directly via Leaflet's control registry without
			// fighting the DOM layer-panel that's covered by modals at
			// boot. Harmless in production.
			try { pageWin._dwLayerCtrl = ctrl; } catch (_) {}

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

				const wayLyr = addBase(CFG.LAYER_WAYBACK, new WaybackLayerProvider());
				this.waybackHistControl = this._makeHistoryBar({
					layer: wayLyr, event: "histchange",
					getCount: () => wayLyr.getHistCount(),
					getIdx:   () => wayLyr.getHistIdx(),
					setIdx:   (i) => wayLyr.setHistIdx(i),
					getLabel: (i) => wayLyr.getHistLabel(i),
				});

				addBase(CFG.LAYER_QLD, new QldGlobeLayerProvider(this.qldToken));
				const qldLyr = addBase(CFG.LAYER_HIST,
					new QldHistoricalLayerProvider(this.qldPhotosToken));
				this.histCompass = this._makeHistoryBar({
					layer: qldLyr, event: "capturechange",
					getCount: () => qldLyr.getCaptureCount(),
					getIdx:   () => qldLyr.getCaptureIdx(),
					setIdx:   (i) => qldLyr.setCapture(i),
					getLabel: (i) => qldLyr.getCaptureDate(i),
				});
				addBase(CFG.LAYER_TOPO, new QldTopoLayerProvider());

				this._injectGroupHeaders(ctrl);

				addOverlay(CFG.LAYER_STRAVA,     new StravaHeatmapLayerProvider());
				addOverlay(CFG.LAYER_GARMIN,     new GarminHeatmapLayerProvider());
				addOverlay(CFG.LAYER_WATER,      new WaterLayerProvider());
				addOverlay(CFG.LAYER_FLIGHTS,    new FlightsLayerProvider());
				addOverlay(CFG.LAYER_MARINE,     new MarineTrafficLayerProvider());
				addOverlay(CFG.LAYER_GEOCACHING, new GeocachingLayerProvider());
				addOverlay(CFG.LAYER_MOBILE,     new MobileCoverageLayerProvider());
				addOverlay(CFG.LAYER_SEAMARKS,   new OpenSeaMapLayerProvider());
				addOverlay(CFG.LAYER_INFRA,      new PowerInfraLayerProvider());
				addOverlay(CFG.LAYER_TELECOM,    new TelecomsLayerProvider());
				addOverlay(CFG.LAYER_LIGHTPOL,   new LightPollutionLayerProvider());
				addOverlay(CFG.LAYER_CADASTRE,   new QldCadastreLayerProvider());
				addOverlay(CFG.LAYER_QPWS,       new QpwsLayerProvider());
				addOverlay(CFG.LAYER_INTVL_GLOBAL,
					new IntvlGlobalTilesLayerProvider());

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
					this.qldToken,
				).create();
				this.layers[CFG.LAYER_LABELS] = new QldLabelsLayerProvider().create();

				map.on("baselayerchange", () => {
					this._syncLabelsLayer(map);
					this._syncHistCompass(map);
					this._syncWaybackHistControl(map);
					this._syncZoomLevel(map);
				});
				map.on("layeradd", (e) => {
					if (
						e.layer === this.layers[CFG.LAYER_QLD]    ||
						e.layer === this.layers[CFG.LAYER_GOOGLE]  ||
						e.layer === this.layers[CFG.LAYER_HIST]    ||
						e.layer === this.layers[CFG.LAYER_TOPO]    ||
						e.layer === this.layers[CFG.LAYER_WAYBACK]
					) {
						this._syncLabelsLayer(map);
						this._syncHistCompass(map);
						this._syncWaybackHistControl(map);
						this._syncZoomLevel(map);
					}
				});

				// Defensive try/catch wrap on every injected layer's
				// onAdd/onRemove so a thrown error during async setup
				// (e.g. token bootstrap fails, in-flight fetch aborts
				// mid-decode) doesn't break Leaflet's L.Control.Layers
				// state. Without this, if `removeLayer` throws inside
				// the control's _onInputClick loop, the rest of the
				// loop never runs and the checkbox / map.hasLayer
				// state can desync — the user sees the toggle move
				// but the layer doesn't actually add or remove,
				// and the layer becomes "stuck".
				for (const [name, layer] of Object.entries(this.layers || {})) {
					if (!layer) continue;
					const origOnAdd    = layer.onAdd;
					const origOnRemove = layer.onRemove;
					if (typeof origOnAdd === "function") {
						layer.onAdd = function (m) {
							try { return origOnAdd.call(this, m); }
							catch (e) { console.warn(`[CustomTiles] onAdd '${name}':`, e); }
						};
					}
					if (typeof origOnRemove === "function") {
						layer.onRemove = function (m) {
							try { return origOnRemove.call(this, m); }
							catch (e) { console.warn(`[CustomTiles] onRemove '${name}':`, e); }
						};
					}
				}

				this._restoreLayer(map);
				this._restoreOverlays(map, ctrl);
				new LayerManagerUI(ctrl).setup();
				this._hookSitePopup(map);
			} catch (e) {
				this.injected = false;
				throw e;
			}
		}

		// -- Layer sync ---------------------------------------------------

		_syncLabelsLayer(map) {
			const isQld =
				map.hasLayer(this.layers[CFG.LAYER_QLD]) ||
				map.hasLayer(this.layers[CFG.LAYER_HIST]);
			for (const lyr of [
				this.layers[CFG.LAYER_ROADS],
				this.layers[CFG.LAYER_LABELS],
			]) {
				if (!lyr) continue;
				if (isQld) {
					if (!map.hasLayer(lyr)) map.addLayer(lyr);
				} else {
					if (map.hasLayer(lyr)) map.removeLayer(lyr);
				}
			}
		}

		_syncHistCompass(map) {
			const hist = this.histCompass;
			if (!hist) return;
			const isHist = !!(
				this.layers[CFG.LAYER_HIST] && map.hasLayer(this.layers[CFG.LAYER_HIST])
			);
			if (isHist && !hist._map) hist.addTo(map);
			else if (!isHist && hist._map) hist.remove();
		}

		_syncWaybackHistControl(map) {
			const ctrl = this.waybackHistControl;
			if (!ctrl) return;
			const active = !!(
				this.layers[CFG.LAYER_WAYBACK] &&
				map.hasLayer(this.layers[CFG.LAYER_WAYBACK])
			);
			if (active && !ctrl._map) ctrl.addTo(map);
			else if (!active && ctrl._map) ctrl.remove();
		}

		_syncZoomLevel(map) {
			const isDeep =
				map.hasLayer(this.layers[CFG.LAYER_QLD])  ||
				map.hasLayer(this.layers[CFG.LAYER_HIST]) ||
				map.hasLayer(this.layers[CFG.LAYER_TOPO]) ||
				map.hasLayer(this.layers[CFG.LAYER_WAYBACK]);
			const newMax = isDeep ? 25 : 22;
			map.setMaxZoom(newMax);
			if (map.getZoom() > newMax) map.setZoom(newMax);
		}

		// -- Layer restore ------------------------------------------------

		// Save which overlays are active to localStorage so they survive page
		// reloads. Restore is called once after all overlays are registered;
		// saving happens on every overlayadd/overlayremove event.
		_restoreOverlays(map, ctrl) {
			const overlayNames = new Set(
				ctrl._layers.filter(l => l.overlay).map(l => l.name)
			);
			try {
				const saved = JSON.parse(localStorage.getItem(CFG.OVERLAY_STATE_KEY) || "[]");
				for (const name of saved) {
					const lyr = this.layers[name];
					if (lyr && overlayNames.has(name) && !map.hasLayer(lyr)) {
						map.addLayer(lyr);
					}
				}
			} catch (_) {}

			const save = () => {
				const active = [];
				for (const [name, lyr] of Object.entries(this.layers)) {
					if (lyr && overlayNames.has(name) && map.hasLayer(lyr)) active.push(name);
				}
				try { localStorage.setItem(CFG.OVERLAY_STATE_KEY, JSON.stringify(active)); } catch (_) {}
			};
			map.on("overlayadd overlayremove", save);
		}

		_restoreLayer(map) {
			const saved = this._readPageCookie(CFG.MAPTYPE_COOKIE);
			const target = saved ? this.layers[saved] : null;
			if (!target) return;

			// map.whenReady fires immediately if the map already loaded,
			// or once on the next `load` event otherwise — exact and
			// event-driven, vs. the prior 7.5-second poll budget that
			// silently gave up.
			map.whenReady(() => {
				const toRemove = [];
				map.eachLayer((l) => {
					if (l instanceof L.TileLayer && l !== target) toRemove.push(l);
				});
				toRemove.forEach((l) => map.removeLayer(l));
				if (!map.hasLayer(target)) map.addLayer(target);
				console.info("[CustomTiles] Restored layer:", saved);
			});
		}

		_readPageCookie(name) {
			const m = document.cookie.match(
				new RegExp(
					"(?:^|;\\s*)" +
						name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
						"=([^;]*)",
				),
			);
			return m ? decodeURIComponent(m[1]) : null;
		}

		// -- Street View popup injection --------------------------------

		_hookSitePopup(map) {
			map.on("popupopen", (e) => {
				const el = e.popup.getElement
					? e.popup.getElement()
					: e.popup._container;
				if (!el) return;
				const pod = el.querySelector(".popup-on-location");
				if (!pod || pod.querySelector(".dw-sv-btn")) return;

				const titleEl = pod.querySelector("#waypoint-popup-title");
				if (!titleEl) return;
				const parts = (titleEl.textContent || "").trim().split(",");
				if (parts.length < 2) return;
				const lat = parseFloat(parts[0]);
				const lng = parseFloat(parts[1]);
				if (isNaN(lat) || isNaN(lng)) return;

				// Give the coordinate title a class we can style, and make it
				// click-to-copy so "lat,lng" lands on the clipboard instantly.
				titleEl.classList.add("dw-popup-coords");
				titleEl.title = "Click to copy coordinates";
				titleEl.addEventListener("click", () => {
					const text = `${lat.toFixed(6)},${lng.toFixed(6)}`;
					navigator.clipboard.writeText(text).then(() => {
						titleEl.classList.add("dw-popup-coords--copied");
						setTimeout(() => titleEl.classList.remove("dw-popup-coords--copied"), 1400);
					}).catch(() => {});
				});

				// Street View button — matches the native button shape; blue
				// accent signals "leaves the app". Appended at the end of the
				// pod rather than wrapped in a row, because the site applies
				// its own block/full-width button styling we'd be fighting.
				const btn = document.createElement("button");
				btn.className = "dw-sv-btn";
				btn.type = "button";
				btn.innerHTML =
					'<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
					'<circle cx="12" cy="5" r="3.5"/>' +
					'<path d="M12 10c-3 0-5 1.8-5 4v1h10v-1c0-2.2-2-4-5-4z"/>' +
					'<path d="M9 19l1-5h4l1 5H9z"/>' +
					"</svg>" +
					"<span>Street View</span>";
				btn.addEventListener("click", () => {
					const svUrl =
						"https://www.google.com/maps/@" +
						lat.toFixed(6) +
						"," +
						lng.toFixed(6) +
						",3a,75y,90t/data=!3m7!1e1";
					window.open(svUrl, "_blank", "noopener,noreferrer");
				});
				pod.appendChild(btn);
			});
		}

		_injectGroupHeaders(ctrl) {
			const collapsedGroups = new Set(
				JSON.parse(GM_getValue("dw_collapsed_groups", "[]")),
			);

			// Render one set of groups (base or overlay) into its section.
			const injectSection = (sectionEl, groups) => {
				if (!sectionEl) return;
				const labelMap = new Map();
				for (const lbl of sectionEl.querySelectorAll(":scope > label")) {
					const span = lbl.querySelector("span");
					if (!span) continue;
					const name = span.textContent.trim();
					lbl.dataset.dwName = name;
					labelMap.set(name, lbl);
				}
				for (const group of groups) {
					const labels = group.names
						.map((n) => labelMap.get(n))
						.filter(Boolean);
					if (!labels.length) continue;
					const grpDiv = document.createElement("div");
					grpDiv.className = "dw-layer-group";
					if (collapsedGroups.has(group.header))
						grpDiv.classList.add("dw-layer-group--closed");
					const hdr = document.createElement("div");
					hdr.className = "dw-layer-group-header";
					hdr.textContent = group.header;
					hdr.addEventListener("click", () => {
						const nowClosed = grpDiv.classList.toggle("dw-layer-group--closed");
						if (nowClosed) collapsedGroups.add(group.header);
						else collapsedGroups.delete(group.header);
						GM_setValue(
							"dw_collapsed_groups",
							JSON.stringify([...collapsedGroups]),
						);
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
					DW_LAYER_GROUPS,
				);
				injectSection(
					container.querySelector(".leaflet-control-layers-overlays"),
					DW_OVERLAY_GROUPS,
				);
			};
			const origUpdate = ctrl._update.bind(ctrl);
			ctrl._update = function () {
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
				if (!count) return "Loading\u2026";
				const s = lab ? String(lab) : "?";
				const trimmed =
					s.length > 10 && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s;
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
					count,
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
				},
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
				".dw-history-bar { position: absolute; top: 10px; left: 50%; transform: translateX(-50%); z-index: 1000; display: flex; align-items: center; gap: 8px; padding: 5px 10px; background: rgba(255,255,255,0.95); border-radius: 6px; box-shadow: 0 1px 6px rgba(0,0,0,0.35); font-size: 11px; font-family: sans-serif; white-space: nowrap; pointer-events: auto; width: min(82vw, 720px); box-sizing: border-box; }",
				".dw-history-slider { flex: 1; min-width: 0; margin: 0; accent-color: #4a8; cursor: pointer; }",
				".dw-history-slider:disabled { cursor: not-allowed; opacity: 0.4; }",
				".dw-history-bar-label { min-width: 130px; text-align: right; color: #333; font-variant-numeric: tabular-nums; }",
				".dw-vxh-btn { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; background: #fff; border: 1px solid #bbb; border-radius: 3px; font-size: 11px; color: #444; text-decoration: none; cursor: pointer; flex-shrink: 0; }",
				".dw-vxh-btn:hover:not(.dw-vxh-disabled) { background: #e8f0fb; color: #000; border-color: #888; }",
				".dw-vxh-disabled { opacity: 0.3; cursor: default; pointer-events: none; }",
				".dw-layer-group { margin: 1px 0; }",
				".dw-layer-group-header { font-size: 10px; font-weight: 700; color: #aaa; text-transform: uppercase; letter-spacing: 0.05em; padding: 5px 8px 1px; cursor: pointer; user-select: none; }",
				".dw-layer-group:not(.dw-layer-group--closed) > .dw-layer-group-header::before { content: '\u25be  '; }",
				".dw-layer-group--closed > .dw-layer-group-header::before { content: '\u25b8  '; }",
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
				".dw-marine-icon { background: none !important; border: none !important; }",
				".dw-marine-cluster { background: none !important; border: none !important; overflow: visible !important; cursor: pointer; }",
				".dw-marine-tip { font-size: 11px; line-height: 1.4; }",
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
				".dw-sales-pop .dw-sales-source:hover { text-decoration: underline; }",
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
	}

	new CustomTilesApp().boot();
})();
