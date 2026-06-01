// ==UserScript==
// @name         dynamicWatch – Map Layers & Overlays
// @namespace    https://dynamic.watch
// @version      7.9.19
// @description  Multi-source basemaps (QLD Globe/Historical/Topo, Google Hybrid, Apple Maps, Stamen Toner, Esri Wayback) plus overlays: QPWS Estate, QLD Cadastre, Mobile Coverage, Marine Vessels, Live Flights, Strava/Garmin heatmaps, Light Pollution, Power Infrastructure, National Parks, OpenSeaMap, Unity Water, QLD Relief, INTVL Global Map. Includes overlay persistence, QPWS hover-identify, cadastre Sales lookup via OnTheHouse, coordinate click-to-copy, and auto-refreshing access tokens for QLD and Apple MapKit.
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
// @connect      services2.arcgis.com
// @connect      opensky-network.org
// @connect      www.marinetraffic.com
// @connect      overpass.kumi.systems
// @connect      spatial.infrastructure.gov.au
// @connect      tiles.openseamap.org
// @connect      www2.lightpollutionmap.info
// @connect      www.onthehouse.com.au
// @connect      d1yalngj9nsyl4.cloudfront.net
// @run-at       document-start
// ==/UserScript==

(function () {
	"use strict";

	const pageWin = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;

	/* -- Configuration ----------------------------------------------------- */

	const CFG = {
		LAYER_QLD: "QLD Globe",
		LAYER_GOOGLE: "Google Hybrid",
		LAYER_APPLE: "Apple Maps",
		LAYER_STAMEN_TONER: "Stamen Toner",
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

		LAYER_UW: "Unity Water",
		LAYER_FLIGHTS: "Live Flights",
		LAYER_MARINE: "Marine Vessels",
		LAYER_MOBILE: "Mobile Coverage",
		LAYER_SEAMARKS: "OpenSeaMap",
		LAYER_INFRA: "Power Infrastructure",
		LAYER_PARKS: "National Parks",
		LAYER_LIGHTPOL: "Light Pollution",
		LAYER_CADASTRE: "QLD Cadastre",
		LAYER_QPWS:    "QPWS Estate",
		LAYER_TOPO:    "QLD Topo",
		LAYER_RELIEF:  "QLD Relief",
		LAYER_INTVL_GLOBAL: "INTVL Global Map",
		OVERLAY_STATE_KEY: "dw_active_overlays",

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

		UW_FS_BASE: "https://services2.arcgis.com/tQg86iShPXJPWQWw",

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
				CFG.LAYER_STAMEN_TONER,
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
			names:  [CFG.LAYER_CADASTRE, CFG.LAYER_QPWS, CFG.LAYER_RELIEF],
		},
		{
			header: "Infrastructure",
			names:  [CFG.LAYER_INFRA, CFG.LAYER_MOBILE, CFG.LAYER_UW],
		},
		{
			header: "Environment",
			names:  [CFG.LAYER_PARKS, CFG.LAYER_LIGHTPOL, CFG.LAYER_SEAMARKS],
		},
		{
			header: "Live data",
			names:  [CFG.LAYER_FLIGHTS, CFG.LAYER_MARINE,
			         CFG.LAYER_INTVL_GLOBAL],
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

	/* -- Layer Providers --------------------------------------------------- */

	class LayerProvider {
		/** @returns {L.Layer} */
		create() {
			throw new Error(`${this.constructor.name}.create() not implemented`);
		}
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

		return new Layer("", {
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
	}

	// Global rate-limiter for Overpass API requests. Allows at most 2 concurrent
	// fetches so Power Infrastructure and National Parks don't hammer the
	// endpoint simultaneously when both are visible.
	const _overpassQueue = (() => {
		const MAX = 2;
		let running = 0;
		const pending = [];
		function next() {
			if (!pending.length || running >= MAX) return;
			running++;
			pending.shift()(function done() { running--; next(); });
		}
		return {
			run(fn) { pending.push(fn); next(); },
		};
	})();

	// Factory for OSM/Overpass-backed vector overlays (Power Infrastructure,
	// National Parks, …). All such layers share the same skeleton: debounced
	// per-bbox fetch, render into a layerGroup, clear-and-redraw on view
	// change. A generation counter drops stale responses so fast panning
	// can't paint old data on top of new.
	//
	// opts: {
	//   label:        used in console warnings
	//   pane:         Leaflet pane name
	//   paneZIndex:   numeric z-index
	//   minZoom:      below this, the group is cleared and no fetch fires
	//   buildQuery(bbox):       returns the Overpass QL string
	//   render(group, elements): paints features into group (already cleared)
	//   attribution:  static attribution string
	//   debounceMs=400, timeoutMs=60000, padBounds=0, clickThrough=true
	// }
	function makeOverpassLayer(opts) {
		const OVERPASS = "https://overpass.kumi.systems/api/interpreter";
		const debounceMs = opts.debounceMs || 400;
		const timeoutMs = opts.timeoutMs || 60000;
		const padBounds = opts.padBounds || 0;
		const clickThrough = opts.clickThrough !== false;

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
					const el = map.getPane(opts.pane);
					el.style.zIndex = String(opts.paneZIndex);
					if (clickThrough) el.style.pointerEvents = "none";
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
				if (this._group) {
					this._group.remove();
					this._group = null;
				}
			},

			_onViewChange() {
				clearTimeout(this._debounce);
				this._debounce = setTimeout(() => this._fetch(), debounceMs);
			},

			_fetch() {
				const map = this._map;
				if (!map || !this._group) return;
				if (map.getZoom() < opts.minZoom) {
					this._group.clearLayers();
					this._lastBbox = null;
					return;
				}

				const b = padBounds ? map.getBounds().pad(padBounds) : map.getBounds();
				const bbox = `${b.getSouth().toFixed(4)},${b.getWest().toFixed(4)},${b.getNorth().toFixed(4)},${b.getEast().toFixed(4)}`;
				if (bbox === this._lastBbox) return;
				this._lastBbox = bbox;

				const myGen = ++this._gen;
				const zoom  = map.getZoom();
				_overpassQueue.run((done) => {
					// Bail immediately if the view has already changed.
					if (myGen !== this._gen) { done(); return; }
					gmJsonGet(OVERPASS, {
						method:  "POST",
						headers: { "Content-Type": "application/x-www-form-urlencoded" },
						data:    "data=" + encodeURIComponent(opts.buildQuery(bbox, zoom)),
						timeout: timeoutMs,
					}, (err, json) => {
						done();
						if (myGen !== this._gen || !this._group) return;
						if (err) {
							console.warn(
								`[CustomTiles] ${opts.label} request error`, err.message);
							return;
						}
						// Deduplicate by OSM type+id — ways belonging to a relation
						// are returned twice by `out geom tags`.
						const seen = new Set();
						const elements = (json.elements || []).filter(el => {
							const key = el.type + "/" + el.id;
							if (seen.has(key)) return false;
							seen.add(key);
							return true;
						});
						this._group.clearLayers();
						opts.render(this._group, elements, zoom);
					});
				});
			},

			getAttribution() {
				return opts.attribution;
			},
		});

		return new Layer();
	}

	// -- QLD Globe -----------------------------------------------------------

	class QldGlobeLayerProvider extends LayerProvider {
		constructor(qldToken) {
			super();
			this._token = qldToken;
		}

		static tileUrl(token) {
			return CFG.QLD_TILE_TPL + (token ? "?token=" + token : "");
		}

		create() {
			const url = this._token.isValid()
				? QldGlobeLayerProvider.tileUrl(this._token.token)
				: BLANK_TILE;
			const layer = L.tileLayer(url, {
				maxNativeZoom: 21,
				maxZoom: 25,
				tileSize: 256,
				crossOrigin: true,
				attribution: "&copy; State of Queensland (Department of Resources)",
			});
			if (!this._token.isValid()) {
				this._token.get((err, token) => {
					if (!err) layer.setUrl(QldGlobeLayerProvider.tileUrl(token));
				});
			}
			return layer;
		}
	}

	// -- Google Hybrid --------------------------------------------------------

	class GoogleHybridLayerProvider extends LayerProvider {
		create() {
			return L.tileLayer(
				"https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}",
				{
					subdomains: ["0", "1", "2", "3"],
					maxNativeZoom: 21,
					maxZoom: 22,
					tileSize: 256,
					crossOrigin: true,
					attribution: "&copy; Google",
				},
			);
		}
	}

	// -- Apple Maps ----------------------------------------------------------

	class AppleMapsLayerProvider extends LayerProvider {
		constructor(appleToken) {
			super();
			this._token = appleToken;
		}

		static tileUrl(accessKey, version) {
			return (
				CFG.APPLE_TILE_BASE +
				"&v=" +
				encodeURIComponent(version || CFG.APPLE_DEFAULT_V) +
				(accessKey ? "&accessKey=" + encodeURIComponent(accessKey) : "")
			);
		}

		create() {
			const url = this._token.isValid()
				? AppleMapsLayerProvider.tileUrl(
						this._token.accessKey,
						this._token.version,
					)
				: BLANK_TILE;
			const layer = L.tileLayer(url, {
				maxNativeZoom: 19,
				maxZoom: 22,
				tileSize: 256,
				crossOrigin: true,
				attribution: "&copy; Apple",
			});
			if (!this._token.isValid()) {
				this._token.get((err, accessKey, version) => {
					if (!err)
						layer.setUrl(AppleMapsLayerProvider.tileUrl(accessKey, version));
				});
			}
			return layer;
		}
	}

	// -- Stamen Toner (via Stadia Maps, localhost-spoofed) -------------------

	class StamenTonerLayerProvider extends LayerProvider {
		create() {
			const TILE_PX = 256;
			const TILE_BASE = "https://tiles.stadiamaps.com/tiles/stamen_toner/";
			const spoofOrigin = CFG.STADIA_SPOOF_ORIGIN;

			const TonerGrid = L.GridLayer.extend({
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

			const layer = new TonerGrid({
				tileSize: TILE_PX,
				maxNativeZoom: 20,
				maxZoom: 22,
				attribution:
					'&copy; <a href="https://stadiamaps.com/" target="_blank" rel="noreferrer">Stadia Maps</a> ' +
					'&copy; <a href="https://stamen.com/" target="_blank" rel="noreferrer">Stamen Design</a> ' +
					'&copy; <a href="https://openmaptiles.org/" target="_blank" rel="noreferrer">OpenMapTiles</a> ' +
					'&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors',
			});
			wireTileAbort(layer);
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

	class QldLabelsLayerProvider extends LayerProvider {
		create() {
			return L.tileLayer(CFG.QLD_LABELS_TILE, {
				maxNativeZoom: 19,
				// 25 to match the deep-zoom map ceiling when QLD basemaps
				// are active; native zoom stays at 19 so Leaflet stretches
				// the z=19 tiles rather than 404ing at higher zooms.
				maxZoom: 25,
				tileSize: 256,
				crossOrigin: true,
				opacity: 1,
				pane: "dwLabelsPane",
				attribution: "&copy; State of Queensland (Department of Resources)",
			});
		}
	}

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

			return new QldRoadsGrid({
				tileSize: TILE_PX,
				maxNativeZoom: 19,
				maxZoom: 25,
				pane: "dwRoadsPane",
				attribution: "&copy; State of Queensland (Department of Resources)",
			});
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

	class StravaHeatmapLayerProvider extends LayerProvider {
		create() {
			return L.tileLayer(
				"https://content-a.strava.com/anon/globalheat/all/blue/{z}/{x}/{y}@2x.png?v=19",
				{
					tileSize: 256,
					maxNativeZoom: 10,
					maxZoom: 25,
					opacity: 0.8,
					attribution: "© Strava",
				},
			);
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
			return layer;
		}
	}

	// -- Unity Water Infrastructure ------------------------------------------

	/**
	 * Renders one or more Esri FeatureServer layers as a GeoJSON overlay.
	 * Queries the visible extent on each map move and re-renders features.
	 *
	 * @param {Array<{url:string, fields:string, style:object|function}>} configs
	 */
	class UnityWaterLayerProvider extends LayerProvider {
		constructor(configs) {
			super();
			this._configs = configs;
		}

		create() {
			const configs = this._configs;

			const UWLayer = L.Layer.extend({
				initialize(cfgs) {
					L.setOptions(this, {});
					this._cfgs = cfgs;
					this._group = null;
					this._timer = null;
					this._guards = [];
				},

				onAdd(map) {
					if (!map.getPane("dwUWPane")) {
						map.createPane("dwUWPane");
						map.getPane("dwUWPane").style.zIndex = "400";
						map.getPane("dwUWPane").style.pointerEvents = "none";
					}
					this._group = L.layerGroup().addTo(map);
					map.on("moveend", this._schedule, this);
					map.on("zoomend", this._schedule, this);
					this._fetch();
				},

				onRemove(map) {
					clearTimeout(this._timer);
					map.off("moveend", this._schedule, this);
					map.off("zoomend", this._schedule, this);
					this._guards.forEach((g) => {
						g.dead = true;
					});
					this._guards = [];
					if (this._group) {
						this._group.remove();
						this._group = null;
					}
				},

				_schedule() {
					clearTimeout(this._timer);
					this._timer = setTimeout(() => this._fetch(), 400);
				},

				_fetch() {
					const self = this;
					const map = this._map;
					if (!map || !this._group) return;
					if (map.getZoom() < 13) {
						this._group.clearLayers();
						return;
					}

					const b = map.getBounds();
					const geomParam = encodeURIComponent(
						JSON.stringify({
							xmin: b.getWest(),
							ymin: b.getSouth(),
							xmax: b.getEast(),
							ymax: b.getNorth(),
							spatialReference: { wkid: 4326 },
						}),
					);

					this._guards.forEach((g) => {
						g.dead = true;
					});
					const guards = this._cfgs.map(() => ({ dead: false }));
					this._guards = guards;

					const results = new Array(this._cfgs.length).fill(null);
					let remaining = this._cfgs.length;

					this._cfgs.forEach((cfg, i) => {
						const guard = guards[i];
						const url =
							cfg.url + "/query?geometry=" + geomParam +
							"&geometryType=esriGeometryEnvelope&inSR=4326&outSR=4326" +
							"&spatialRel=esriSpatialRelIntersects" +
							"&outFields=" +
							encodeURIComponent(cfg.fields || "ObjectId") +
							"&returnGeometry=true&f=geojson";

						gmJsonGet(url, (err, data) => {
							if (guard.dead) return;
							if (!err) results[i] = { cfg, data };
							if (--remaining === 0) self._render(results, guards);
						});
					});
				},

				_render(results, guards) {
					if (!this._group || guards.some((g) => g.dead)) return;
					this._group.clearLayers();
					for (const r of results) {
						if (!r || !r.data || r.data.error || !r.data.features) continue;
						const cfg = r.cfg;
						L.geoJSON(r.data, {
							pane: "dwUWPane",
							style:
								typeof cfg.style === "function" ? cfg.style : () => cfg.style,
							pointToLayer: (ft, ll) => {
								const s =
									typeof cfg.style === "function" ? cfg.style(ft) : cfg.style;
								return L.circleMarker(
									ll,
									Object.assign({ radius: 4, pane: "dwUWPane" }, s),
								);
							},
						}).addTo(this._group);
					}
				},

				getAttribution() {
					return "\u00a9 Unitywater";
				},
			});

			return new UWLayer(configs);
		}
	}

	/* -- Live Flights (OpenSky Network) ------------------------------------ */

	class FlightsLayerProvider extends LayerProvider {
		create() {
			const POLL_MS = 10000;
			const MIN_ZOOM = 1;
			const OPENSKY = "https://opensky-network.org/api/states/all";

			const FlightsLayer = L.Layer.extend({
				initialize() {
					this._group = null;
					this._timer = null;
					this._debounce = null;
				},

				onAdd(map) {
					if (!map.getPane("dwFlightsPane")) {
						map.createPane("dwFlightsPane");
						map.getPane("dwFlightsPane").style.zIndex = "450";
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
					this._fetch();
					this._timer = setInterval(() => this._fetch(), POLL_MS);
				},

				_onViewChange() {
					clearInterval(this._timer);
					clearTimeout(this._debounce);
					this._timer = null;
					this._debounce = setTimeout(() => this._startPoll(), 400);
				},

				_fetch() {
					const map = this._map;
					if (!map || !this._group) return;
					if (map.getZoom() < MIN_ZOOM) {
						this._group.clearLayers();
						return;
					}
					const b = map.getBounds();
					const url =
						OPENSKY +
						"?lamin=" +
						b.getSouth().toFixed(3) +
						"&lomin=" +
						b.getWest().toFixed(3) +
						"&lamax=" +
						b.getNorth().toFixed(3) +
						"&lomax=" +
						b.getEast().toFixed(3);
					gmJsonGet(url, (err, data) => {
						if (err || !this._group) return;
						this._render(data.states || []);
					});
				},

				_render(states) {
					if (!this._group) return;
					this._group.clearLayers();
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
							.addTo(this._group);
					}
				},

				getAttribution() {
					return 'Flights \u00a9 <a href="https://opensky-network.org" target="_blank" rel="noreferrer">OpenSky Network</a>';
				},
			});

			return new FlightsLayer();
		}
	}

	/* -- Marine Traffic ---------------------------------------------------- */

	class MarineTrafficLayerProvider extends LayerProvider {
		create() {
			const POLL_MS = 20000;
			const MIN_ZOOM = 1;
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
				// MarineTraffic internal single-digit codes
				if (t === 7) return "#5B9BD5"; // Cargo
				if (t === 8) return "#D9534F"; // Tanker
				if (t === 6) return "#9B59B6"; // Passenger
				if (t === 4) return "#F0A500"; // High speed craft
				if (t === 3) return "#2ECC71"; // Fishing / special
				if (t === 5) return "#2980B9"; // Sailing / pleasure
				// AIS standard codes (fallback)
				if (t >= 70 && t < 80) return "#5B9BD5"; // Cargo
				if (t >= 80 && t < 90) return "#D9534F"; // Tanker
				if (t >= 60 && t < 70) return "#9B59B6"; // Passenger
				if (t >= 40 && t < 50) return "#F0A500"; // High speed craft
				if (t === 30) return "#2ECC71"; // Fishing
				if (t >= 36 && t <= 37) return "#2980B9"; // Sailing / pleasure
				return "#90A4AE"; // Other / unknown
			}

			const MTLayer = L.Layer.extend({
				initialize() {
					this._group = null;
					this._timer = null;
					this._debounce = null;
				},

				onAdd(map) {
					if (!map.getPane("dwMarinePane")) {
						map.createPane("dwMarinePane");
						map.getPane("dwMarinePane").style.zIndex = "440";
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
					this._fetch();
					this._timer = setInterval(() => this._fetch(), POLL_MS);
				},

				_onViewChange() {
					clearInterval(this._timer);
					clearTimeout(this._debounce);
					this._timer = null;
					this._debounce = setTimeout(() => this._startPoll(), 400);
				},

				_fetch() {
					const map = this._map;
					if (!map || !this._group) return;
					if (map.getZoom() < MIN_ZOOM) {
						this._group.clearLayers();
						return;
					}
					// MT API z parameter is one more than the OSM tile zoom used for X/Y
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
					const referer =
						`https://www.marinetraffic.com/en/ais/home` +
						`/centerx:${center.lng.toFixed(1)}/centery:${center.lat.toFixed(1)}/zoom:${tileZ}`;
					const done = () => {
						if (--remaining === 0 && this._group)
							this._render([...vessels.values()]);
					};
					for (const { x, y } of tiles) {
						const url = `${MT_BASE}/z:${apiZ}/X:${x}/Y:${y}/station:0`;
						gmJsonGet(url, {
							headers: {
								"Accept":           "*/*",
								"X-Requested-With": "XMLHttpRequest",
								"Referer":          referer,
							},
						}, (err, parsed) => {
							if (err) { done(); return; }
							// Format: { type, data: { rows: [...], areaShips: N } }
							const raw =
								(parsed.data && parsed.data.rows) ||
								(Array.isArray(parsed.data) ? parsed.data : null) ||
								(Array.isArray(parsed) ? parsed : null);
							if (!Array.isArray(raw)) { done(); return; }
							let rows = raw;
							// Normalise array-of-arrays (first row = column headers)
							if (rows.length && Array.isArray(rows[0])) {
								const hdrs = rows[0];
								rows = rows.slice(1).map((row) => {
									const obj = {};
									hdrs.forEach((h, i) => { obj[h] = row[i]; });
									return obj;
								});
							}
							for (const v of rows) {
								const key =
									v.MMSI || v.mmsi ||
									String(v.LAT || v.lat) + "," + String(v.LON || v.lon);
								if (key && !vessels.has(key)) vessels.set(key, v);
							}
							done();
						});
					}
				},

				_render(rows) {
					if (!this._group) return;
					this._group.clearLayers();
					// MarineTraffic flips between UPPER/lower keys depending
					// on the endpoint variant — pick walks the candidates.
					const pick = (obj, ...keys) => {
						for (const k of keys) {
							const v = obj[k];
							if (v !== undefined && v !== null && v !== "") return v;
						}
						return "";
					};
					for (const v of rows) {
						const lat = parseFloat(pick(v, "LAT", "lat"));
						const lon = parseFloat(pick(v, "LON", "lon"));
						if (!isFinite(lat) || !isFinite(lon)) continue;
						const name = String(pick(v,
							"SHIPNAME", "shipname", "NAME", "name", "MMSI") || ""
						).trim() || "Unknown";
						const mmsi = pick(v, "MMSI", "mmsi") || "";
						const type = parseInt(pick(v,
							"SHIPTYPE", "shiptype", "TYPE", "type") || "0") || 0;
						const hdg  = parseFloat(pick(v,
							"HEADING", "heading", "COURSE", "course") || "0") || 0;
						const rawSpd = parseFloat(pick(v, "SPEED", "speed") || "0") || 0;
						// AIS speed is in 1/10 knots; guard against pre-divided values
						const spdKts =
							rawSpd > 102 ? (rawSpd / 10).toFixed(1) : rawSpd.toFixed(1);
						const fill = shipColor(type);
						const svg =
							`<svg viewBox="0 0 14 20" width="14" height="20" xmlns="http://www.w3.org/2000/svg">` +
							`<g transform="translate(7,10) rotate(${hdg})">` +
							`<polygon points="0,-9 4.5,8 0,5 -4.5,8" fill="${fill}" stroke="#333" stroke-width="0.7"/>` +
							`</g></svg>`;
						const icon = L.divIcon({
							className: "dw-marine-icon",
							html: svg,
							iconSize: [14, 20],
							iconAnchor: [7, 10],
						});
						L.marker([lat, lon], {
							icon,
							pane: "dwMarinePane",
							interactive: true,
						})
							.bindTooltip(
								`<b>${name}</b><br>MMSI: ${mmsi}<br>Speed: ${spdKts}\u202fkts\u2002Hdg: ${Math.round(hdg)}\u00b0`,
								{ className: "dw-marine-tip", sticky: true },
							)
							.addTo(this._group);
					}
				},

				getAttribution() {
					return 'Vessels \u00a9 <a href="https://www.marinetraffic.com" target="_blank" rel="noreferrer">MarineTraffic</a>';
				},
			});

			return new MTLayer();
		}
	}

	/* -- Mobile Coverage Layer --------------------------------------------- */

	// ACCC Mobile Sites and Coverages (national AU). Sublayer 2 = "All
	// Network Operators 4G Outdoor Mobile Coverage".
	class MobileCoverageLayerProvider extends LayerProvider {
		create() {
			return makeArcgisExportTileLayer({
				baseUrl:
					"https://spatial.infrastructure.gov.au/server/rest/services/" +
					"ACCC_Mobile_Sites_and_Coverages/MapServer",
				showLayers: "2",
				pane: "dwMobilePane",
				paneZIndex: 380,
				opacity: 0.5,
				minZoom: 5,
				// ACCC's coverage grid is intrinsically coarse (~100 m cells),
				// so cap the native query at z=18 and let Leaflet stretch the
				// z=18 tile beyond that — saves the export endpoint from
				// generating tinier bboxes that render the same blocky pixels.
				maxNativeZoom: 18,
				maxZoom: 25,
				attribution:
					'Mobile coverage \u00a9 <a href="https://data.gov.au" target="_blank" rel="noreferrer">ACCC / Dept. of Infrastructure</a>',
			});
		}
	}

	/* -- QLD Topo basemap ------------------------------------------------- */

	class QldTopoLayerProvider extends LayerProvider {
		create() {
			return L.tileLayer(CFG.QLD_TOPO_TILE, {
				maxNativeZoom: 16,
				// Topo is one of the deep-zoom-eligible bases (see
				// _syncZoomLevel), so it needs to cover the 25 ceiling.
				maxZoom: 25,
				tileSize: 256,
				crossOrigin: true,
				attribution: "&copy; State of Queensland (Department of Resources)",
			});
		}
	}

	/* -- QLD Relief overlay ----------------------------------------------- */

	// Hillshade layer served as a transparent overlay tile cache. Designed to
	// sit on top of any base layer at ~40% opacity to add terrain context.
	// Lives in its own pane (z=240) so it stacks above the basemap and roads
	// but stays underneath QLD Labels (dwLabelsPane z=250).
	class QldReliefLayerProvider extends LayerProvider {
		create() {
			const ReliefLayer = L.TileLayer.extend({
				onAdd(map) {
					if (!map.getPane("dwReliefPane")) {
						map.createPane("dwReliefPane");
						map.getPane("dwReliefPane").style.zIndex = "240";
						map.getPane("dwReliefPane").style.pointerEvents = "none";
					}
					L.TileLayer.prototype.onAdd.call(this, map);
				},
			});
			return new ReliefLayer(CFG.QLD_RELIEF_TILE, {
				maxNativeZoom: 14,
				maxZoom: 25,
				tileSize: 256,
				crossOrigin: true,
				opacity: 0.45,
				pane: "dwReliefPane",
				attribution: "&copy; State of Queensland (Department of Resources)",
			});
		}
	}

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

	/* -- QLD Cadastre (Digital Cadastral Database) ------------------------ */

	// Property/parcel boundaries from the QLD Planning Cadastre MapServer,
	// rendered via makeArcgisExportTileLayer plus a hover-identify hook.
	//
	// Hover behaviour: above CFG.QLD_CADASTRE_HOVER_MIN_ZOOM, mousemove
	// triggers a debounced /identify call against layer 8 (Base Parcels Only)
	// and shows a tooltip with Lot/Plan, tenure, area, locality. Stale
	// responses are dropped via a generation counter.
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

	class QldCadastreLayerProvider extends LayerProvider {
		create() {
			return makeArcgisExportTileLayer({
				baseUrl: CFG.QLD_CADASTRE_SERVICE,
				showLayers: String(CFG.QLD_CADASTRE_LAYER_ID),
				pane: "dwCadastrePane",
				paneZIndex: 385,
				opacity: 0.75,
				minZoom: 11,
				maxZoom: 25,
				attribution:
					'Cadastre &copy; <a href="https://www.qld.gov.au/dnrme" target="_blank" rel="noreferrer">State of Queensland (DCDB)</a>',
				onAdd: (layer, map) => installCadastreHover(layer, map),
				onRemove: (layer) => {
					if (layer._dwHoverOff) {
						layer._dwHoverOff();
						layer._dwHoverOff = null;
					}
				},
			});
		}
	}

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
	class QpwsLayerProvider extends LayerProvider {
		create() {
			return makeArcgisExportTileLayer({
				baseUrl:    CFG.QLD_QPWS_SERVICE,
				showLayers: CFG.QLD_QPWS_LAYER_IDS,
				pane:       "dwQpwsPane",
				paneZIndex: 396,
				opacity:    0.85,
				minZoom:    9,
				maxZoom:    25,
				attribution: 'QPWS &copy; <a href="https://parks.qld.gov.au/" target="_blank" rel="noreferrer">State of Queensland (DETSI)</a>',
				onAdd:    (layer, map) => installQpwsHover(layer, map),
				onRemove: (layer) => {
					if (layer._dwHoverOff) { layer._dwHoverOff(); layer._dwHoverOff = null; }
				},
			});
		}
	}

	/* -- OpenSeaMap -------------------------------------------------------- */

	// Public transparent overlay tiles — nautical seamarks (buoys, lights,
	// lanes, harbour features). No key required, polite to cache.
	class OpenSeaMapLayerProvider extends LayerProvider {
		create() {
			return L.tileLayer(
				"https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png",
				{
					tileSize: 256,
					maxNativeZoom: 18,
					maxZoom: 25,
					opacity: 1,
					attribution:
						'&copy; <a href="https://www.openseamap.org/" target="_blank" rel="noreferrer">OpenSeaMap</a> contributors',
				},
			);
		}
	}

	/* -- Power Infrastructure (OSM via Overpass) -------------------------- */

	// Mirrors what OpenInfraMap renders: transmission/distribution lines,
	// substations, power plants, wind generators. Queried per visible bbox
	// because the dataset is too sparse for a worldwide tile preload to be
	// worth the bandwidth.
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

			function pointIcon(glyph, fill, size) {
				size = size || 16;
				return L.divIcon({
					className: "dw-infra-icon",
					html: `<svg viewBox="0 0 16 16" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">` +
					      `<circle cx="8" cy="8" r="6.5" fill="${fill}" stroke="#222" stroke-width="1" opacity="0.92"/>` +
					      `<text x="8" y="11.5" text-anchor="middle" font-size="9" font-family="sans-serif" fill="#fff">${glyph}</text>` +
					      `</svg>`,
					iconSize:   [size, size],
					iconAnchor: [size / 2, size / 2],
				});
			}

			return makeOverpassLayer({
				label:        "PowerInfra",
				pane:         "dwInfraPane",
				paneZIndex:   410,
				minZoom:      9,   // show major transmission lines from z9
				padBounds:    0.15,
				clickThrough: false,
				attribution:  'Infrastructure © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors',

				// At low zooms only query major lines to keep payload small.
				buildQuery: (bbox, zoom) => {
					const full = zoom >= 12;
					return (
						`[out:json][timeout:30];(` +
						`way[power=line](${bbox});` +
						(full ? `way[power=minor_line](${bbox});` : "") +
						(full ? `way[power=cable](${bbox});` : "") +
						`way[power=substation](${bbox});` +
						`node[power=substation](${bbox});` +
						`way[power=plant](${bbox});` +
						`node[power=plant](${bbox});` +
						(full ? `node[power=transformer](${bbox});` : "") +
						`node[power=generator]["generator:source"=wind](${bbox});` +
						`way[power=generator]["generator:source"=solar](${bbox});` +
						`node[power=generator]["generator:source"=solar](${bbox});` +
						`);out geom tags;`
					);
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

	/* -- National Parks / Protected Areas (OSM via Overpass) -------------- */

	// Stitch a relation's member ways into closed rings. Overpass `out geom`
	// returns a boundary relation as many unordered segments in arbitrary
	// direction (Lamington NP alone is 78 outer ways) — handing those straight
	// to L.polygon draws 78 disjoint slivers, not one park. We walk segments
	// end-to-end, matching shared endpoints, until each ring closes.
	// `ways` is an array of geometry arrays ([{lat,lon},…]); returns an array
	// of rings ([[lat,lon],…], first point repeated at the end when closed).
	function assembleRings(ways) {
		const segs = ways
			.filter((w) => w && w.length >= 2)
			.map((w) => w.map((p) => [p.lat, p.lon]));
		const used = new Array(segs.length).fill(false);
		const key = (p) => p[0].toFixed(7) + "," + p[1].toFixed(7);
		const rings = [];
		for (let i = 0; i < segs.length; i++) {
			if (used[i]) continue;
			used[i] = true;
			let ring = segs[i].slice();
			let grew = true;
			while (grew && key(ring[0]) !== key(ring[ring.length - 1])) {
				grew = false;
				const tail = key(ring[ring.length - 1]);
				for (let j = 0; j < segs.length; j++) {
					if (used[j]) continue;
					const s = segs[j];
					if (key(s[0]) === tail) {
						ring = ring.concat(s.slice(1));
						used[j] = true; grew = true; break;
					}
					if (key(s[s.length - 1]) === tail) {
						ring = ring.concat(s.slice().reverse().slice(1));
						used[j] = true; grew = true; break;
					}
				}
			}
			rings.push(ring);
		}
		return rings;
	}

	// Ray-cast point-in-ring on [lat,lon] points — used to attach inner rings
	// (holes) to whichever outer ring contains them.
	function ringContains(ring, pt) {
		let inside = false;
		const x = pt[1], y = pt[0];
		for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
			const xi = ring[i][1], yi = ring[i][0];
			const xj = ring[j][1], yj = ring[j][0];
			if ((yi > y) !== (yj > y) &&
			    x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
		}
		return inside;
	}

	// Polygons for OSM-tagged national parks and protected areas. Bumped to
	// min zoom 9 so we don't pull continent-scale geometry on world view.
	class NationalParksLayerProvider extends LayerProvider {
		create() {
			return makeOverpassLayer({
				label: "National Parks",
				pane: "dwParksPane",
				paneZIndex: 395,
				minZoom: 9,
				debounceMs: 500,
				timeoutMs: 90000,
				attribution:
					'Parks © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors',
				// `boundary=national_park` is the strict tag; `protected_area`
				// with protect_class 1–4 covers most reserves people care
				// about (strict reserves, wilderness, national parks, habitat).
				buildQuery: (bbox) =>
					`[out:json][timeout:25];(` +
					`way[boundary=national_park](${bbox});` +
					`relation[boundary=national_park](${bbox});` +
					`way[boundary=protected_area]["protect_class"~"^[1-4]$"](${bbox});` +
					`relation[boundary=protected_area]["protect_class"~"^[1-4]$"](${bbox});` +
					// `out geom;` (NOT `out geom tags;`): the `tags` verbosity
					// prints only ids+tags and drops relation members, so every
					// park relation came back as a bare bbox with no polygon and
					// rendered nothing. Plain `out geom` keeps the tags AND emits
					// each member way's geometry.
					`);out geom;`,
				render: (group, elements) => {
					for (const el of elements) {
						const tags = el.tags || {};
						const name = tags.name || "Protected area";
						const isNP = tags.boundary === "national_park";
						const style = {
							pane: "dwParksPane",
							color: isNP ? "#1B5E20" : "#33691E",
							weight: 1.5,
							opacity: 0.85,
							fillColor: isNP ? "#43A047" : "#7CB342",
							fillOpacity: 0.18,
						};

						if (el.type === "way" && el.geometry) {
							const latlngs = el.geometry.map((g) => [g.lat, g.lon]);
							L.polygon(latlngs, style)
								.bindTooltip(name, { className: "dw-park-tip", sticky: true })
								.addTo(group);
						} else if (el.type === "relation" && el.members) {
							// Split members by role (empty role → outer, as OSM
							// boundary relations often leave it blank), stitch each
							// set into closed rings, then render every outer ring as
							// its own polygon with any contained inner rings as holes.
							const outerWays = [], innerWays = [];
							for (const m of el.members) {
								if (m.type !== "way" || !m.geometry) continue;
								(m.role === "inner" ? innerWays : outerWays).push(m.geometry);
							}
							const outers = assembleRings(outerWays)
								.filter((r) => r.length >= 4);
							const inners = assembleRings(innerWays)
								.filter((r) => r.length >= 4);
							if (!outers.length) continue;
							for (const outer of outers) {
								const holes = inners.filter((h) => ringContains(outer, h[0]));
								L.polygon(holes.length ? [outer, ...holes] : outer, style)
									.bindTooltip(name, { className: "dw-park-tip", sticky: true })
									.addTo(group);
							}
						}
					}
				},
			});
		}
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
							done(null, canvas); return;
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
						done(null, canvas);
					});

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

			return new IntvlGlobalGrid({
				tileSize: TILE_PX,
				minZoom: 4,
				maxNativeZoom: CFG.INTVL_TILES_MAX_NATIVE_Z,
				maxZoom: 25,
				opacity: 1,
				pane: "dwIntvlGlobalPane",
			});
		}
	}

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

			return new LightPolWmsLayer("", {
				tileSize: TILE_PX,
				minZoom: 0,
				maxNativeZoom: 12,
				maxZoom: 25,
				opacity: 0.65,
				attribution:
					'Light pollution © <a href="https://www.lightpollutionmap.info/" target="_blank" rel="noreferrer">lightpollutionmap.info</a>',
			});
		}
	}

	/* -- Layer Manager UI -------------------------------------------------- */

	class LayerManagerUI {
		constructor(ctrl) {
			this._ctrl = ctrl;
		}

		// Delegates to the top-level _escHtml helper — kept as a static so
		// existing `LayerManagerUI.escHtml(...)` call sites in this class
		// don't need to change.
		static escHtml(s) { return _escHtml(s); }

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
					`<input type="checkbox" id="${LayerManagerUI.escHtml(chkId)}"` +
					` data-name="${LayerManagerUI.escHtml(item.name)}"` +
					(checked ? " checked" : "") +
					(isActive
						? ' disabled title="Switch to another layer before archiving this one"'
						: "") +
					`><span class="dw-manager-name">${LayerManagerUI.escHtml(displayName || item.name)}</span>` +
					(isActive ? '<span class="dw-badge">active</span>' : "") +
					"</label>"
				);
			};
			const usedNames = new Set();
			let rows = "";
			for (const group of DW_LAYER_GROUPS) {
				const groupItems = items.filter((it) => group.names.includes(it.name));
				if (!groupItems.length) continue;
				rows += `<div class="dw-manager-group-hd">${LayerManagerUI.escHtml(group.header)}</div>`;
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
				if (apple)
					apple.setUrl(AppleMapsLayerProvider.tileUrl(accessKey, version));
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

			try {
				this.layers[CFG.LAYER_GOOGLE] =
					new GoogleHybridLayerProvider().create();
				this.layers[CFG.LAYER_APPLE] = new AppleMapsLayerProvider(
					this.appleToken,
				).create();
				this.layers[CFG.LAYER_STAMEN_TONER] =
					new StamenTonerLayerProvider().create();
				this.layers[CFG.LAYER_WAYBACK] = new WaybackLayerProvider().create();
				const wayLyr = this.layers[CFG.LAYER_WAYBACK];
				this.waybackHistControl = this._makeHistoryBar({
					layer: wayLyr,
					event: "histchange",
					getCount: () => wayLyr.getHistCount(),
					getIdx: () => wayLyr.getHistIdx(),
					setIdx: (i) => wayLyr.setHistIdx(i),
					getLabel: (i) => wayLyr.getHistLabel(i),
				});
				this.layers[CFG.LAYER_QLD] = new QldGlobeLayerProvider(
					this.qldToken,
				).create();
				this.layers[CFG.LAYER_HIST] = new QldHistoricalLayerProvider(
					this.qldPhotosToken,
				).create();
				const qldLyr = this.layers[CFG.LAYER_HIST];
				this.histCompass = this._makeHistoryBar({
					layer: qldLyr,
					event: "capturechange",
					getCount: () => qldLyr.getCaptureCount(),
					getIdx: () => qldLyr.getCaptureIdx(),
					setIdx: (i) => qldLyr.setCapture(i),
					getLabel: (i) => qldLyr.getCaptureDate(i),
				});

				ctrl.addBaseLayer(this.layers[CFG.LAYER_GOOGLE], CFG.LAYER_GOOGLE);
				ctrl.addBaseLayer(this.layers[CFG.LAYER_APPLE], CFG.LAYER_APPLE);
				ctrl.addBaseLayer(
					this.layers[CFG.LAYER_STAMEN_TONER],
					CFG.LAYER_STAMEN_TONER,
				);
				ctrl.addBaseLayer(this.layers[CFG.LAYER_WAYBACK], CFG.LAYER_WAYBACK);
				ctrl.addBaseLayer(this.layers[CFG.LAYER_QLD],  CFG.LAYER_QLD);
				ctrl.addBaseLayer(this.layers[CFG.LAYER_HIST], CFG.LAYER_HIST);
				this.layers[CFG.LAYER_TOPO] = new QldTopoLayerProvider().create();
				ctrl.addBaseLayer(this.layers[CFG.LAYER_TOPO], CFG.LAYER_TOPO);

				this._injectGroupHeaders(ctrl);

				this.layers[CFG.LAYER_STRAVA] =
					new StravaHeatmapLayerProvider().create();
				ctrl.addOverlay(this.layers[CFG.LAYER_STRAVA], CFG.LAYER_STRAVA);

				this.layers[CFG.LAYER_GARMIN] =
					new GarminHeatmapLayerProvider().create();
				ctrl.addOverlay(this.layers[CFG.LAYER_GARMIN], CFG.LAYER_GARMIN);

				this.layers[CFG.LAYER_UW] = new UnityWaterLayerProvider([
					{
						url:
							CFG.UW_FS_BASE +
							"/ArcGIS/rest/services/UWPublicAccessWaterInfrastructureLayers/FeatureServer/10",
						fields: "SubtypeCD",
						style: (f) => {
							const s = f.properties && f.properties.SubtypeCD;
							return s === 11101
								? { color: "#005ce6", weight: 3, opacity: 0.85 }
								: s === 11102
									? { color: "#00c5ff", weight: 2.5, opacity: 0.85 }
									: { color: "#73b2ff", weight: 1.5, opacity: 0.85 };
						},
					},
					{
						url:
							CFG.UW_FS_BASE +
							"/ArcGIS/rest/services/UWPublicAccessSewerInfrastructureLayers/FeatureServer/11",
						fields: "NominalDiameter",
						style: { color: "#734c00", weight: 1.5, opacity: 0.85 },
					},
					{
						url:
							CFG.UW_FS_BASE +
							"/ArcGIS/rest/services/UWPublicAccessSewerInfrastructureLayers/FeatureServer/12",
						fields: "NominalDiameter",
						style: { color: "#df3c00", weight: 2, opacity: 0.85 },
					},
				]).create();
				ctrl.addOverlay(this.layers[CFG.LAYER_UW], CFG.LAYER_UW);

				this.layers[CFG.LAYER_FLIGHTS] = new FlightsLayerProvider().create();
				ctrl.addOverlay(this.layers[CFG.LAYER_FLIGHTS], CFG.LAYER_FLIGHTS);

				this.layers[CFG.LAYER_MARINE] =
					new MarineTrafficLayerProvider().create();
				ctrl.addOverlay(this.layers[CFG.LAYER_MARINE], CFG.LAYER_MARINE);

				this.layers[CFG.LAYER_MOBILE] =
					new MobileCoverageLayerProvider().create();
				ctrl.addOverlay(this.layers[CFG.LAYER_MOBILE], CFG.LAYER_MOBILE);

				this.layers[CFG.LAYER_SEAMARKS] =
					new OpenSeaMapLayerProvider().create();
				ctrl.addOverlay(this.layers[CFG.LAYER_SEAMARKS], CFG.LAYER_SEAMARKS);

				this.layers[CFG.LAYER_INFRA] = new PowerInfraLayerProvider().create();
				ctrl.addOverlay(this.layers[CFG.LAYER_INFRA], CFG.LAYER_INFRA);

				this.layers[CFG.LAYER_PARKS] =
					new NationalParksLayerProvider().create();
				ctrl.addOverlay(this.layers[CFG.LAYER_PARKS], CFG.LAYER_PARKS);

				this.layers[CFG.LAYER_LIGHTPOL] =
					new LightPollutionLayerProvider().create();
				ctrl.addOverlay(this.layers[CFG.LAYER_LIGHTPOL], CFG.LAYER_LIGHTPOL);

				this.layers[CFG.LAYER_CADASTRE] =
					new QldCadastreLayerProvider().create();
				ctrl.addOverlay(this.layers[CFG.LAYER_CADASTRE], CFG.LAYER_CADASTRE);

				this.layers[CFG.LAYER_QPWS] = new QpwsLayerProvider().create();
				ctrl.addOverlay(this.layers[CFG.LAYER_QPWS], CFG.LAYER_QPWS);

				this.layers[CFG.LAYER_RELIEF] = new QldReliefLayerProvider().create();
				ctrl.addOverlay(this.layers[CFG.LAYER_RELIEF], CFG.LAYER_RELIEF);

				this.layers[CFG.LAYER_INTVL_GLOBAL] =
					new IntvlGlobalTilesLayerProvider().create();
				ctrl.addOverlay(
					this.layers[CFG.LAYER_INTVL_GLOBAL],
					CFG.LAYER_INTVL_GLOBAL,
				);

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
				".dw-flight-icon { background: none !important; border: none !important; }",
				".dw-flight-tip { font-size: 11px; line-height: 1.4; }",
				".dw-marine-icon { background: none !important; border: none !important; }",
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
