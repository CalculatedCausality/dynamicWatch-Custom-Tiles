// ==UserScript==
// @name         dynamicWatch – Queensland Globe, Google Hybrid & Layer Manager
// @namespace    https://dynamic.watch
// @version      7.2.0
// @description  Adds QLD Globe aerial imagery (auto-refreshed token), Google Hybrid, and QLD Historical tiles to the dynamicWatch planner.
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

		WAYBACK_CONFIG_URL: "https://s3-us-west-2.amazonaws.com/config.maptiles.arcgis.com/waybackconfig.json",

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

		LAYER_UW:       "Unity Water",
		LAYER_FLIGHTS:  "Live Flights",
		LAYER_MARINE:   "Marine Vessels",
		LAYER_MOBILE:   "Mobile Coverage",
		LAYER_SEAMARKS: "OpenSeaMap",
		LAYER_INFRA:    "Power Infrastructure",
		LAYER_PARKS:    "National Parks",
		LAYER_LIGHTPOL: "Light Pollution",
		LAYER_CADASTRE: "QLD Cadastre",
		LAYER_QPWS:     "QPWS Estate",
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
		LIGHTPOL_WMS_BASE: "https://www2.lightpollutionmap.info/geoserver/gwc/service/wms",
		LIGHTPOL_WMS_LAYER: "PostGIS:SB_2025",
		LIGHTPOL_WMS_STYLE: "WA",
	};

	const BLANK_TILE =
		"data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

	// Layer groups for the picker and Manage Layers panel.
	// shortLabels strip the state prefix so labels are concise inside their group.
	const DW_LAYER_GROUPS = [
		{ header: "Global",     names: [CFG.LAYER_GOOGLE, CFG.LAYER_APPLE, CFG.LAYER_STAMEN_TONER, CFG.LAYER_WAYBACK] },
		{ header: "Queensland", names: [CFG.LAYER_QLD, CFG.LAYER_HIST], shortLabels: { [CFG.LAYER_QLD]: "Current Imagery", [CFG.LAYER_HIST]: "Historical" } },
	];

	/* -- QLD Token Manager ------------------------------------------------- */

	class QldTokenManager {
		// opts: { serviceUrl, storageKey, label }
		// Each QLD ImageServer (LatestStateProgram, HistoricalAerialPhoto, …)
		// has its own access policy, so the token request must be scoped to
		// the right service URL and tokens must be cached independently.
		constructor(opts) {
			opts = opts || {};
			this._serviceUrl = opts.serviceUrl || CFG.QLD_SERVICE;
			this._storageKey = opts.storageKey || "qld_token";
			this._label = opts.label || "QLD";
			this.token = GM_getValue(this._storageKey, null);
			this.expires = GM_getValue(this._storageKey + "_expires", 0);
			this.fetching = false;
			this.pending = [];
			this.refreshScheduled = false;
			this.retryCount = 0;
			/** Set by CustomTilesApp; called with (token) after each successful refresh. */
			this.onRefresh = null;
		}

		isValid() {
			return !!(this.token && this.expires - Date.now() > CFG.REFRESH_MARGIN);
		}

		save(token, expiresMs) {
			this.token = token;
			this.expires = expiresMs;
			GM_setValue(this._storageKey, token);
			GM_setValue(this._storageKey + "_expires", expiresMs);
		}

		get(cb) {
			if (this.isValid()) {
				cb(null, this.token);
				return;
			}
			this.pending.push(cb);
			if (this.fetching) return;
			this.fetching = true;
			this._doFetch((err, token) => {
				this.fetching = false;
				const cbs = this.pending.splice(0);
				cbs.forEach((fn) => fn(err, token));
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

		_doFetch(done) {
			GM_xmlhttpRequest({
				method: "GET",
				url: CFG.QLD_ORIGIN + "/",
				headers: {
					"Accept": "text/html,*/*;q=0.8",
					"Accept-Language": "en-US,en;q=0.9",
					"Origin": CFG.QLD_ORIGIN,
					"Referer": CFG.QLD_ORIGIN + "/",
				},
				onload: (r) => {
					const csrf =
						QldTokenManager._xsrfFromSetCookie(r.responseHeaders) ||
						QldTokenManager._csrfFromHtml(r.responseText);
					if (!csrf) {
						done(
							new Error(`[${this._label}] CSRF token not found in Set-Cookie or HTML`),
							null,
						);
						return;
					}
					this._doPost(csrf, done);
				},
				onerror: () =>
					done(
						new Error(`[${this._label}] GET qldglobe.information.qld.gov.au failed`),
						null,
					),
			});
		}

		_doPost(csrf, done) {
			GM_xmlhttpRequest({
				method: "POST",
				url: CFG.QLD_TOKEN_EP,
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
				onload: (r) => {
					if (r.status < 200 || r.status >= 300) {
						done(
							new Error(
								`[${this._label}] Token endpoint HTTP ${r.status}: ${r.responseText.slice(0, 160)}`,
							),
							null,
						);
						return;
					}
					try {
						const data = JSON.parse(r.responseText);
						if (!data.token) throw new Error("No token field in response");
						const exp = data.expires
							? data.expires > 1e12
								? data.expires
								: data.expires * 1000
							: Date.now() + CFG.DEFAULT_TTL;
						this.save(data.token, exp);
						console.info(
							`[CustomTiles] ${this._label} token acquired, expires`,
							new Date(exp).toISOString(),
						);
						done(null, data.token);
					} catch (e) {
						done(new Error(`[${this._label}] Parse error: ${e.message}`), null);
					}
				},
				onerror: () => done(new Error(`[${this._label}] Token POST network error`), null),
			});
		}

		scheduleRefresh() {
			if (this.refreshScheduled) return;
			this.refreshScheduled = true;
			const wait = Math.max(
				30000,
				this.expires - Date.now() - CFG.REFRESH_MARGIN,
			);
			setTimeout(() => {
				this.refreshScheduled = false;
				this._doFetch((err, token) => {
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
					if (this.onRefresh) this.onRefresh(token);
					this.scheduleRefresh();
				});
			}, wait);
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
	class AppleTokenManager {
		constructor() {
			this.accessKey = GM_getValue("apple_accesskey", null);
			this.version = GM_getValue("apple_version", CFG.APPLE_DEFAULT_V);
			this.expires = GM_getValue("apple_accesskey_expires", 0);
			this.fetching = false;
			this.pending = [];
			this.refreshScheduled = false;
			this.retryCount = 0;
			/** Set by CustomTilesApp; called with (accessKey, version) on refresh. */
			this.onRefresh = null;
		}

		isValid() {
			return !!(this.accessKey && this.expires - Date.now() > CFG.REFRESH_MARGIN);
		}

		save(accessKey, version, expiresMs) {
			this.accessKey = accessKey;
			this.version = version || this.version;
			this.expires = expiresMs;
			GM_setValue("apple_accesskey", accessKey);
			GM_setValue("apple_version", this.version);
			GM_setValue("apple_accesskey_expires", expiresMs);
		}

		get(cb) {
			if (this.isValid()) { cb(null, this.accessKey, this.version); return; }
			this.pending.push(cb);
			if (this.fetching) return;
			this.fetching = true;
			this._doFetch((err, accessKey, version) => {
				this.fetching = false;
				const cbs = this.pending.splice(0);
				cbs.forEach((fn) => fn(err, accessKey, version));
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

		_doFetch(done) {
			GM_xmlhttpRequest({
				method: "GET",
				url: CFG.APPLE_DDG_TOKEN_URL,
				headers: {
					"Accept": "*/*",
					"Referer": CFG.APPLE_DDG_ORIGIN + "/",
				},
				onload: (r) => {
					if (r.status < 200 || r.status >= 300) {
						done(new Error("[Apple] DDG token HTTP " + r.status), null);
						return;
					}
					const jwt = (r.responseText || "").trim();
					if (!/^[\w-]+\.[\w-]+\.[\w-]+$/.test(jwt)) {
						done(new Error("[Apple] DDG returned invalid JWT"), null);
						return;
					}
					this._doBootstrap(jwt, done);
				},
				onerror: () => done(new Error("[Apple] DDG token network error"), null),
			});
		}

		_doBootstrap(jwt, done) {
			GM_xmlhttpRequest({
				method: "GET",
				url: CFG.APPLE_BOOTSTRAP_URL,
				headers: {
					"Accept": "*/*",
					"Authorization": "Bearer " + jwt,
					"Origin": CFG.APPLE_DDG_ORIGIN,
					"Referer": CFG.APPLE_DDG_ORIGIN + "/",
				},
				onload: (r) => {
					if (r.status < 200 || r.status >= 300) {
						done(
							new Error(
								`[Apple] Bootstrap HTTP ${r.status}: ${r.responseText.slice(0, 160)}`,
							),
							null,
						);
						return;
					}
					try {
						const data = JSON.parse(r.responseText);
						if (!data.accessKey) throw new Error("No accessKey in bootstrap response");
						// Pull the current `v` build number out of any tile-URL template
						// in the response (tileSources, tileURLTemplate, etc.) so we
						// don't drift onto a stale build.
						const vMatch = r.responseText.match(/[?&]v=(\d+)/);
						const version = vMatch ? vMatch[1] : this.version;
						const exp = Date.now() + CFG.APPLE_TOKEN_TTL;
						this.save(data.accessKey, version, exp);
						console.info(
							"[CustomTiles] Apple accessKey acquired, v=" + version + ", expires",
							new Date(exp).toISOString(),
						);
						done(null, data.accessKey, version);
					} catch (e) {
						done(new Error("[Apple] Bootstrap parse: " + e.message), null);
					}
				},
				onerror: () => done(new Error("[Apple] Bootstrap network error"), null),
			});
		}

		scheduleRefresh() {
			if (this.refreshScheduled) return;
			this.refreshScheduled = true;
			const wait = Math.max(
				30000,
				this.expires - Date.now() - CFG.REFRESH_MARGIN,
			);
			setTimeout(() => {
				this.refreshScheduled = false;
				this._doFetch((err, accessKey, version) => {
					if (err) {
						const delay = Math.min(
							CFG.RETRY_DELAY * Math.pow(2, this.retryCount),
							CFG.RETRY_MAX_DELAY,
						);
						this.retryCount++;
						console.warn(
							"[CustomTiles] Apple token refresh failed:",
							err.message,
							"– retry in",
							Math.round(delay / 60000),
							"min",
						);
						setTimeout(() => this.scheduleRefresh(), delay);
						return;
					}
					this.retryCount = 0;
					if (this.onRefresh) this.onRefresh(accessKey, version);
					this.scheduleRefresh();
				});
			}, wait);
		}
	}

	/* -- Layer Providers --------------------------------------------------- */

	class LayerProvider {
		/** @returns {L.Layer} */
		create() {
			throw new Error(`${this.constructor.name}.create() not implemented`);
		}
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
			return CFG.APPLE_TILE_BASE +
				"&v=" + encodeURIComponent(version || CFG.APPLE_DEFAULT_V) +
				(accessKey ? "&accessKey=" + encodeURIComponent(accessKey) : "");
		}

		create() {
			const url = this._token.isValid()
				? AppleMapsLayerProvider.tileUrl(this._token.accessKey, this._token.version)
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
					if (!err) layer.setUrl(AppleMapsLayerProvider.tileUrl(accessKey, version));
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
					GM_xmlhttpRequest({
						method: "GET",
						url: TILE_BASE + coords.z + "/" + coords.x + "/" + coords.y + ".png",
						responseType: "arraybuffer",
						headers: {
							"Origin": spoofOrigin,
							"Referer": spoofOrigin + "/",
							"Accept": "image/png,image/*,*/*;q=0.8",
						},
						onload: (r) => {
							if (r.status === 200) {
								const blob = new Blob([r.response], { type: "image/png" });
								const objUrl = URL.createObjectURL(blob);
								img.onload = () => { URL.revokeObjectURL(objUrl); done(null, img); };
								img.onerror = () => { URL.revokeObjectURL(objUrl); done(new Error("Stamen decode failed"), img); };
								img.src = objUrl;
							} else {
								done(new Error("Stamen HTTP " + r.status), img);
							}
						},
						onerror: () => done(new Error("Stamen network error"), img),
					});
					return img;
				},
			});

			return new TonerGrid({
				tileSize: TILE_PX,
				maxNativeZoom: 20,
				maxZoom: 22,
				attribution:
					'&copy; <a href="https://stadiamaps.com/" target="_blank" rel="noreferrer">Stadia Maps</a> ' +
					'&copy; <a href="https://stamen.com/" target="_blank" rel="noreferrer">Stamen Design</a> ' +
					'&copy; <a href="https://openmaptiles.org/" target="_blank" rel="noreferrer">OpenMapTiles</a> ' +
					'&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors',
			});
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
				releaseNum + "/{z}/{y}/{x}"
			);
		}

		_fetchCatalog() {
			if (this._fetching || this._releases) return;
			this._fetching = true;
			GM_xmlhttpRequest({
				method: "GET",
				url: CFG.WAYBACK_CONFIG_URL,
				onload: (r) => {
					this._fetching = false;
					try {
						if (r.status === 200) {
							const data = JSON.parse(r.responseText);
							const releases = Object.entries(data)
								.filter(([, item]) => item.itemTitle)
								.map(([key, item]) => {
									const releaseNum = parseInt(key, 10);
									const label = item.itemTitle.replace(/^World Imagery \(Wayback /, "").replace(/\)$/, "");
									return { label, releaseNum, url: this._tileUrl(releaseNum) };
								});
							releases.sort((a, b) => (a.label < b.label ? 1 : a.label > b.label ? -1 : 0));
							this._releases = releases;
							console.info("[CustomTiles] Wayback:", releases.length, "releases loaded");
						} else {
							console.warn("[CustomTiles] Wayback catalog HTTP", r.status);
						}
					} catch (e) {
						console.error("[CustomTiles] Wayback catalog parse:", e.message);
					}
					this._idx = 0;
					if (this._releases && this._layerRef) {
						this._layerRef.setUrl(this._releases[0].url);
						this._layerRef.fire("histchange");
					}
				},
				onerror: () => {
					this._fetching = false;
					console.error("[CustomTiles] Wayback catalog network error");
				},
			});
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

			layer.getHistCount = () => (provider._releases ? provider._releases.length : 0);
			layer.getHistIdx   = () => provider._idx;
			layer.getHistLabel = (i) => {
				if (!provider._releases) return null;
				return (provider._releases[i ?? provider._idx] || {}).label || null;
			};
			layer.setHistIdx = (i) => {
				if (!provider._releases) return;
				if (i < 0 || i >= provider._releases.length || i === provider._idx) return;
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
				maxZoom: 22,
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
			const MERC_ORIGIN = 20037508.3428;
			const MERC_FULL = 2 * MERC_ORIGIN;
			const TILE_PX = 256;
			const token = this._token;
			const DYN_LAYERS = encodeURIComponent(
				JSON.stringify([
					{ id: 21, source: { type: "mapLayer", mapLayerId: 21 }, drawingInfo: { showLabels: true } },
					{ id: 22, source: { type: "mapLayer", mapLayerId: 22 }, drawingInfo: { showLabels: true } },
					{ id: 23, source: { type: "mapLayer", mapLayerId: 23 }, drawingInfo: { showLabels: true } },
					{ id: 10, source: { type: "mapLayer", mapLayerId: 10 }, drawingInfo: { showLabels: true } },
				]),
			);

			const QldRoadsGrid = L.GridLayer.extend({
				createTile(coords, done) {
					const img = document.createElement("img");
					img.setAttribute("role", "presentation");
					const n = Math.pow(2, coords.z);
					const tw = MERC_FULL / n;
					const west = -MERC_ORIGIN + coords.x * tw;
					const east = west + tw;
					const north = MERC_ORIGIN - coords.y * tw;
					const south = north - tw;
					const bbox = encodeURIComponent(`${west},${south},${east},${north}`);
					const tok = token.token ? "&token=" + encodeURIComponent(token.token) : "";
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
				maxZoom: 22,
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
			if (this._currentOid !== null) { cb(this._currentOid); return; }
			this._fetchPending.push(cb);
			if (this._fetching) return;
			this._fetching = true;

			const c = map.getCenter();
			this._lastCenter = c;

			const geomParam =
				"?geometry=" + encodeURIComponent(JSON.stringify({ x: c.lng, y: c.lat, spatialReference: { wkid: 4326 } })) +
				"&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects" +
				"&outFields=objectid,name,year,title,capturestart" +
				"&returnGeometry=false&orderByFields=capturestart+DESC&f=json";

			const parseCaptures = (responseText, service, needsToken, mosaicWhere) => {
				try {
					const data = JSON.parse(responseText);
					return (data.features || [])
						.map((f) => ({
							objectid: f.attributes.objectid,
							title: f.attributes.title || f.attributes.name || String(f.attributes.year || ""),
							captureDate: f.attributes.capturestart
								? new Date(f.attributes.capturestart).toISOString().slice(0, 10)
								: (f.attributes.year ? String(f.attributes.year) : null),
							service,
							needsToken,
							mosaicWhere,
						}))
						.filter((f) => f.objectid);
				} catch (e) {
					return [];
				}
			};

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
					console.info("[CustomTiles] QLD Historical:", this._captures.length,
						"captures, latest:", this._captures[0].captureDate || this._captures[0].title);
				} else {
					console.warn("[CustomTiles] QLD Historical: no coverage at",
						c.lng.toFixed(4), c.lat.toFixed(4));
				}
				this._captureIdx = 0;
				this._currentOid = (this._captures[0] && this._captures[0].objectid) || null;
				this._fetchPending.splice(0).forEach((fn) => fn(this._currentOid));
				if (this._gridLayerRef) this._gridLayerRef.fire("capturechange");
			};

			const tryFinish = () => {
				if (orthoCaptures !== null && photosCaptures !== null) finish();
			};

			// Query 1: AerialOrtho (no token, public)
			GM_xmlhttpRequest({
				method: "GET",
				url: CFG.QLD_HIST_SERVICE + "/query" + geomParam + "&where=category%3D1",
				headers: { Origin: "https://qldglobe.information.qld.gov.au" },
				onload: (r) => {
					if (r.status === 200) {
						orthoCaptures = parseCaptures(r.responseText, CFG.QLD_HIST_SERVICE, false, "category=1");
					} else {
						console.error("[CustomTiles] QLD Historical ortho query HTTP", r.status);
						orthoCaptures = [];
					}
					tryFinish();
				},
				onerror: () => {
					console.error("[CustomTiles] QLD Historical ortho query network error");
					orthoCaptures = [];
					tryFinish();
				},
			});

			// Query 2: HistoricalAerialPhoto (requires token — holds the
			// 1930s–1990s scanned aerial photos). Silent empty result here is
			// why Brisbane appeared to start in 1994 (the AerialOrtho program's
			// earliest capture). Verbose logging makes auth/pagination issues
			// visible in the console so we can tell ortho-only fallback apart
			// from a real "no coverage" result.
			const doPhotosQuery = (tok) => {
				const tokenParam = tok ? "&token=" + encodeURIComponent(tok) : "";
				GM_xmlhttpRequest({
					method: "GET",
					url: CFG.QLD_HIST_PHOTOS_SERVICE + "/query" + geomParam + "&where=1%3D1" + tokenParam,
					headers: {
						Origin: "https://qldglobe.information.qld.gov.au",
						Referer: "https://qldglobe.information.qld.gov.au/",
					},
					onload: (r) => {
						if (r.status !== 200) {
							console.warn(
								"[CustomTiles] QLD Historical photos HTTP", r.status,
								tok ? "(token sent)" : "(no token)",
								r.responseText.slice(0, 200),
							);
							photosCaptures = [];
							tryFinish();
							return;
						}
						try {
							const data = JSON.parse(r.responseText);
							if (data.error) {
								console.warn(
									"[CustomTiles] QLD Historical photos service error:",
									data.error.code, data.error.message,
									tok ? "(token sent — may be expired or wrong scope)" : "(no token)",
								);
								photosCaptures = [];
							} else {
								photosCaptures = parseCaptures(r.responseText, CFG.QLD_HIST_PHOTOS_SERVICE, !!tok, null);
								const total = (data.features || []).length;
								const limited = !!data.exceededTransferLimit;
								console.info(
									"[CustomTiles] QLD Historical photos:", total, "features",
									limited ? "(LIMITED — older captures cut off, see maxRecordCount)" : "",
								);
							}
						} catch (e) {
							console.error("[CustomTiles] QLD Historical photos parse:", e.message);
							photosCaptures = [];
						}
						tryFinish();
					},
					onerror: () => {
						console.error("[CustomTiles] QLD Historical photos network error");
						photosCaptures = [];
						tryFinish();
					},
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
			const MERC_ORIGIN = 20037508.3428;
			const MERC_FULL = 2 * MERC_ORIGIN;
			const TILE_PX = 256;

			const QldHistGrid = L.GridLayer.extend({
				createTile(coords, done) {
					const img = document.createElement("img");
					img.setAttribute("role", "presentation");
					const map = this._map;
					const n = Math.pow(2, coords.z);
					const tw = MERC_FULL / n;
					const west = -MERC_ORIGIN + coords.x * tw;
					const east = west + tw;
					const north = MERC_ORIGIN - coords.y * tw;
					const south = north - tw;
					const bbox = encodeURIComponent(west + "," + south + "," + east + "," + north);

					const myGen = provider._captureGeneration;
					provider._queryCatalog(map, (oid) => {
						if (!oid || provider._captureGeneration !== myGen) { done(null, img); return; }
						const cap = provider._captures[provider._captureIdx];
						const svc = cap ? cap.service : CFG.QLD_HIST_SERVICE;
						const mosaicWhere = cap ? cap.mosaicWhere : "category=1";
						const needsToken = cap && cap.needsToken;
						const tokenStr = needsToken && provider._qldToken && provider._qldToken.token
							? "&token=" + encodeURIComponent(provider._qldToken.token)
							: "";
						const mosaicRuleObj = {
							mosaicMethod: "esriMosaicLockRaster",
							lockRasterIds: [oid],
							ascending: true,
						};
						if (mosaicWhere) mosaicRuleObj.where = mosaicWhere;
						const mosaicRule = encodeURIComponent(JSON.stringify(mosaicRuleObj));
						img.onload = () => done(null, img);
						img.onerror = () => done(new Error("QLD Hist tile failed"), img);
						img.src =
							svc +
							"/exportImage?bbox=" + bbox +
							"&bboxSR=102100&imageSR=102100" +
							"&size=" + TILE_PX + "%2C" + TILE_PX +
							"&format=jpg&mosaicRule=" + mosaicRule +
							"&f=image" + tokenStr;
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

			gridLayer.getCaptureCount = function () { return provider._captures.length; };
			gridLayer.getCaptureIdx = function () { return provider._captureIdx; };
			gridLayer.getCaptureDate = function (idx) {
				const c = provider._captures[idx !== undefined ? idx : provider._captureIdx];
				return c ? (c.captureDate || null) : null;
			};
			gridLayer.setCapture = function (idx) {
				if (idx < 0 || idx >= provider._captures.length || idx === provider._captureIdx) return;
				provider._captureIdx = idx;
				provider._currentOid = provider._captures[idx].objectid;
				provider._captureGeneration++;
				this.fire("capturechange");
				if (provider._redrawTimer) clearTimeout(provider._redrawTimer);
				const self = this;
				provider._redrawTimer = setTimeout(() => { provider._redrawTimer = null; self.redraw(); }, 300);
			};

			gridLayer.on("add", function () {
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
			const ACTIVITIES = ["RUNNING", "HIKING", "TRAIL_RUNNING", "ROAD_CYCLING", "MOUNTAIN_BIKING"];

			const GarminHeatGrid = L.GridLayer.extend({
				createTile(coords, done) {
					const canvas = document.createElement("canvas");
					canvas.width = 256;
					canvas.height = 256;
					const ctx = canvas.getContext("2d");

					let remaining = ACTIVITIES.length;
					let failed = 0;

					const finish = () => {
						remaining--;
						if (remaining === 0) {
							if (failed === ACTIVITIES.length) {
								done(new Error("All Garmin activity tiles failed"), canvas);
							} else {
								done(null, canvas);
							}
						}
					};

					for (const activity of ACTIVITIES) {
						const url =
							"https://connecttile.garmin.com/" +
							activity + "/" + coords.z + "/" + coords.x + "/" + coords.y + ".png";
						GM_xmlhttpRequest({
							method: "GET",
							url: url,
							responseType: "arraybuffer",
							onload: (r) => {
								if (r.status === 200) {
									try {
										const blob = new Blob([r.response], { type: "image/png" });
										const objUrl = URL.createObjectURL(blob);
										const img = new Image();
										img.onload = () => {
											ctx.globalCompositeOperation = "lighter";
											ctx.drawImage(img, 0, 0);
											URL.revokeObjectURL(objUrl);
											finish();
										};
										img.onerror = () => { URL.revokeObjectURL(objUrl); failed++; finish(); };
										img.src = objUrl;
									} catch (e) {
										failed++;
										finish();
									}
								} else {
									failed++;
									finish();
								}
							},
							onerror: () => { failed++; finish(); },
						});
					}

					return canvas;
				},
			});

			return new GarminHeatGrid({
				tileSize: 256,
				maxNativeZoom: 17,
				maxZoom: 25,
				opacity: 0.8,
				attribution: "© Garmin",
			});
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
					this._guards.forEach(g => { g.dead = true; });
					this._guards = [];
					if (this._group) { this._group.remove(); this._group = null; }
				},

				_schedule() {
					clearTimeout(this._timer);
					this._timer = setTimeout(() => this._fetch(), 400);
				},

				_fetch() {
					const self = this;
					const map = this._map;
					if (!map || !this._group) return;
					if (map.getZoom() < 13) { this._group.clearLayers(); return; }

					const b = map.getBounds();
					const geomParam = encodeURIComponent(JSON.stringify({
						xmin: b.getWest(), ymin: b.getSouth(),
						xmax: b.getEast(), ymax: b.getNorth(),
						spatialReference: { wkid: 4326 },
					}));

					this._guards.forEach(g => { g.dead = true; });
					const guards = this._cfgs.map(() => ({ dead: false }));
					this._guards = guards;

					const results = new Array(this._cfgs.length).fill(null);
					let remaining = this._cfgs.length;

					this._cfgs.forEach((cfg, i) => {
						const guard = guards[i];
						const url =
							cfg.url +
							"/query?geometry=" + geomParam +
							"&geometryType=esriGeometryEnvelope&inSR=4326&outSR=4326" +
							"&spatialRel=esriSpatialRelIntersects" +
							"&outFields=" + encodeURIComponent(cfg.fields || "ObjectId") +
							"&returnGeometry=true&f=geojson";

						GM_xmlhttpRequest({
							method: "GET",
							url: url,
							onload(resp) {
								if (guard.dead) return;
								try { results[i] = { cfg, data: JSON.parse(resp.responseText) }; } catch (_) {}
								if (--remaining === 0) self._render(results, guards);
							},
							onerror() {
								if (guard.dead) return;
								if (--remaining === 0) self._render(results, guards);
							},
						});
					});
				},

				_render(results, guards) {
					if (!this._group || guards.some(g => g.dead)) return;
					this._group.clearLayers();
					for (const r of results) {
						if (!r || !r.data || r.data.error || !r.data.features) continue;
						const cfg = r.cfg;
						L.geoJSON(r.data, {
							pane: "dwUWPane",
							style: typeof cfg.style === "function" ? cfg.style : () => cfg.style,
							pointToLayer: (ft, ll) => {
								const s = typeof cfg.style === "function" ? cfg.style(ft) : cfg.style;
								return L.circleMarker(ll, Object.assign({ radius: 4, pane: "dwUWPane" }, s));
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
			const POLL_MS  = 10000;
			const MIN_ZOOM = 1;
			const OPENSKY  = "https://opensky-network.org/api/states/all";

			const FlightsLayer = L.Layer.extend({
				initialize() {
					this._group    = null;
					this._timer    = null;
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
					if (this._group) { this._group.remove(); this._group = null; }
				},

				_startPoll() {
					clearInterval(this._timer);
					this._fetch();
					this._timer = setInterval(() => this._fetch(), POLL_MS);
				},

				_onViewChange() {
					clearInterval(this._timer);
					clearTimeout(this._debounce);
					this._timer = this._debounce = null;
					this._debounce = setTimeout(() => this._startPoll(), 400);
				},

				_fetch() {
					const map = this._map;
					if (!map || !this._group) return;
					if (map.getZoom() < MIN_ZOOM) { this._group.clearLayers(); return; }
					const b   = map.getBounds();
					const url = OPENSKY +
						"?lamin=" + b.getSouth().toFixed(3) +
						"&lomin=" + b.getWest().toFixed(3) +
						"&lamax=" + b.getNorth().toFixed(3) +
						"&lomax=" + b.getEast().toFixed(3);
					GM_xmlhttpRequest({
						method: "GET",
						url,
						onload: (r) => {
							if (r.status === 200 && this._group) {
								try { this._render(JSON.parse(r.responseText).states || []); }
								catch (_) {}
							}
						},
						onerror: () => {},
					});
				},

				_render(states) {
					if (!this._group) return;
					this._group.clearLayers();
					for (const s of states) {
						const lon = s[5], lat = s[6];
						if (lon == null || lat == null) continue;
						const callsign  = (s[1] || "").trim() || s[0];
						const track     = s[10] || 0;
						const onGround  = s[8];
						const altM      = s[7];
						const speedMs   = s[9];
						const country   = s[2] || "";
						const altStr    = altM    != null ? Math.round(altM)            + "\u202fm" : "\u2014";
						const spdStr    = speedMs != null ? Math.round(speedMs * 1.944) + "\u202fkts" : "\u2014";
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
							iconSize:   [20, 20],
							iconAnchor: [10, 10],
						});
						L.marker([lat, lon], { icon, pane: "dwFlightsPane", interactive: true })
							.bindTooltip(
								`<b>${callsign}</b><br>Alt: ${altStr}&nbsp; Speed: ${spdStr}<br>${country}`,
								{ className: "dw-flight-tip", sticky: true }
							)
							.addTo(this._group);
					}
				},

				getAttribution() {
					return "Flights \u00a9 <a href=\"https://opensky-network.org\" target=\"_blank\" rel=\"noreferrer\">OpenSky Network</a>";
				},
			});

			return new FlightsLayer();
		}
	}

	/* -- Marine Traffic ---------------------------------------------------- */

	class MarineTrafficLayerProvider extends LayerProvider {
		create() {
			const POLL_MS   = 20000;
			const MIN_ZOOM  = 1;
			const MAX_TILES = 25;
			const MT_BASE   = "https://www.marinetraffic.com/getData/get_data_json_4";

			function latLonToTile(lat, lon, z) {
				lat = Math.max(-85.0511, Math.min(85.0511, lat));
				const n   = Math.pow(2, z);
				const x   = Math.floor((lon + 180) / 360 * n);
				const rad = lat * Math.PI / 180;
				const y   = Math.floor((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * n);
				return { x: Math.max(0, Math.min(n - 1, x)), y: Math.max(0, Math.min(n - 1, y)) };
			}

			function shipColor(type) {
				const t = parseInt(type) || 0;
				// MarineTraffic internal single-digit codes
				if (t === 7) return "#5B9BD5";   // Cargo
				if (t === 8) return "#D9534F";   // Tanker
				if (t === 6) return "#9B59B6";   // Passenger
				if (t === 4) return "#F0A500";   // High speed craft
				if (t === 3) return "#2ECC71";   // Fishing / special
				if (t === 5) return "#2980B9";   // Sailing / pleasure
				// AIS standard codes (fallback)
				if (t >= 70 && t < 80) return "#5B9BD5";  // Cargo
				if (t >= 80 && t < 90) return "#D9534F";  // Tanker
				if (t >= 60 && t < 70) return "#9B59B6";  // Passenger
				if (t >= 40 && t < 50) return "#F0A500";  // High speed craft
				if (t === 30)          return "#2ECC71";  // Fishing
				if (t >= 36 && t <= 37) return "#2980B9"; // Sailing / pleasure
				return "#90A4AE";                          // Other / unknown
			}

			const MTLayer = L.Layer.extend({
				initialize() {
					this._group    = null;
					this._timer    = null;
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
					if (this._group) { this._group.remove(); this._group = null; }
				},

				_startPoll() {
					clearInterval(this._timer);
					this._fetch();
					this._timer = setInterval(() => this._fetch(), POLL_MS);
				},

				_onViewChange() {
					clearInterval(this._timer);
					clearTimeout(this._debounce);
					this._timer = this._debounce = null;
					this._debounce = setTimeout(() => this._startPoll(), 400);
				},

				_fetch() {
					const map = this._map;
					if (!map || !this._group) return;
					if (map.getZoom() < MIN_ZOOM) { this._group.clearLayers(); return; }
					// MT API z parameter is one more than the OSM tile zoom used for X/Y
					const tileZ  = Math.max(4, Math.min(map.getZoom(), 8));
					const apiZ   = tileZ + 1;
					const b      = map.getBounds();
					const center = map.getCenter();
					const nw     = latLonToTile(b.getNorth(), b.getWest(), tileZ);
					const se     = latLonToTile(b.getSouth(), b.getEast(), tileZ);
					const tiles  = [];
					for (let y = nw.y; y <= se.y && tiles.length < MAX_TILES; y++) {
						for (let x = nw.x; x <= se.x && tiles.length < MAX_TILES; x++) {
							tiles.push({ x, y });
						}
					}
					if (!tiles.length) return;
					const vessels   = new Map();
					let   remaining = tiles.length;
					const referer   =
						`https://www.marinetraffic.com/en/ais/home` +
						`/centerx:${center.lng.toFixed(1)}/centery:${center.lat.toFixed(1)}/zoom:${tileZ}`;
					const done = () => {
						if (--remaining === 0 && this._group) this._render([...vessels.values()]);
					};
					for (const { x, y } of tiles) {
						GM_xmlhttpRequest({
							method: "GET",
							url: `${MT_BASE}/z:${apiZ}/X:${x}/Y:${y}/station:0`,
							headers: {
								"Accept": "*/*",
								"X-Requested-With": "XMLHttpRequest",
								"Referer": referer,
							},
							onload: (r) => {
								if (r.status === 200) {
									try {
										const parsed = JSON.parse(r.responseText);
										// Format: { type, data: { rows: [...], areaShips: N } }
										const raw = (parsed.data && parsed.data.rows) ||
										            (Array.isArray(parsed.data) ? parsed.data : null) ||
										            (Array.isArray(parsed) ? parsed : null);
										if (!Array.isArray(raw)) return;
										let rows = raw;
										// Normalise array-of-arrays (first row = column headers)
										if (rows.length && Array.isArray(rows[0])) {
											const hdrs = rows[0];
											rows = rows.slice(1).map(row => {
												const obj = {};
												hdrs.forEach((h, i) => { obj[h] = row[i]; });
												return obj;
											});
										}
										for (const v of rows) {
											const key = v.MMSI || v.mmsi ||
												(String(v.LAT || v.lat) + "," + String(v.LON || v.lon));
											if (key && !vessels.has(key)) vessels.set(key, v);
										}
									} catch (e) {
										console.warn("[CustomTiles] MarineTraffic parse error", e);
									}
								}
								done();
							},
							onerror: done,
						});
					}
				},

				_render(rows) {
					if (!this._group) return;
					this._group.clearLayers();
					for (const v of rows) {
						const lat = parseFloat(v.LAT  || v.lat);
						const lon = parseFloat(v.LON  || v.lon);
						if (!isFinite(lat) || !isFinite(lon)) continue;
						const name   = (v.SHIPNAME || v.shipname || v.NAME || v.name || v.MMSI || "").trim() || "Unknown";
						const mmsi   = v.MMSI  || v.mmsi  || "";
						const type   = parseInt(v.SHIPTYPE || v.shiptype || v.TYPE || v.type || "0") || 0;
						const hdg    = parseFloat(v.HEADING || v.heading || v.COURSE || v.course || "0") || 0;
						const rawSpd = parseFloat(v.SPEED   || v.speed   || "0") || 0;
						// AIS speed is in 1/10 knots; guard against pre-divided values
						const spdKts = rawSpd > 102 ? (rawSpd / 10).toFixed(1) : rawSpd.toFixed(1);
						const fill   = shipColor(type);
						const svg =
							`<svg viewBox="0 0 14 20" width="14" height="20" xmlns="http://www.w3.org/2000/svg">` +
							`<g transform="translate(7,10) rotate(${hdg})">` +
							`<polygon points="0,-9 4.5,8 0,5 -4.5,8" fill="${fill}" stroke="#333" stroke-width="0.7"/>` +
							`</g></svg>`;
						const icon = L.divIcon({
							className: "dw-marine-icon",
							html: svg,
							iconSize:   [14, 20],
							iconAnchor: [7, 10],
						});
						L.marker([lat, lon], { icon, pane: "dwMarinePane", interactive: true })
							.bindTooltip(
								`<b>${name}</b><br>MMSI: ${mmsi}<br>Speed: ${spdKts}\u202fkts\u2002Hdg: ${Math.round(hdg)}\u00b0`,
								{ className: "dw-marine-tip", sticky: true }
							)
							.addTo(this._group);
					}
				},

				getAttribution() {
					return "Vessels \u00a9 <a href=\"https://www.marinetraffic.com\" target=\"_blank\" rel=\"noreferrer\">MarineTraffic</a>";
				},
			});

			return new MTLayer();
		}
	}

	/* -- Mobile Coverage Layer --------------------------------------------- */

	class MobileCoverageLayerProvider extends LayerProvider {
		create() {
			const L       = pageWin.L;
			// ACCC Mobile Sites and Coverages (national AU, 2024)
			// Layer 2 = All Network Operators 4G Outdoor Mobile Coverage ACCC 2024
			const BASE    =
				"https://spatial.infrastructure.gov.au/server/rest/services/" +
				"ACCC_Mobile_Sites_and_Coverages/MapServer";
			const LAYER_ID = 2;  // 4G All Operators

			// Convert Leaflet tile (z,x,y) to geographic bbox (EPSG:4326)
			function tileToBBox(z, x, y) {
				const n    = Math.pow(2, z);
				const lon1 = x / n * 360 - 180;
				const lon2 = (x + 1) / n * 360 - 180;
				const lat1 = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n)))       * 180 / Math.PI;
				const lat2 = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / n))) * 180 / Math.PI;
				return { minLon: lon1, minLat: lat2, maxLon: lon2, maxLat: lat1 };
			}

			const MobileTileLayer = L.TileLayer.extend({
				onAdd(map) {
					if (!map.getPane("dwMobilePane")) {
						map.createPane("dwMobilePane");
						map.getPane("dwMobilePane").style.zIndex = "380";
						map.getPane("dwMobilePane").style.pointerEvents = "none";
					}
					L.TileLayer.prototype.onAdd.call(this, map);
				},

				getTileUrl(coords) {
					const { z, x, y } = coords;
					const bb = tileToBBox(z, x, y);
					return (
						`${BASE}/export?` +
						`bbox=${bb.minLon},${bb.minLat},${bb.maxLon},${bb.maxLat}` +
						`&bboxSR=4326&imageSR=4326` +
						`&layers=show:${LAYER_ID}` +
						`&size=256,256` +
						`&format=png32` +
						`&transparent=true` +
						`&f=image`
					);
				},
			});

			return new MobileTileLayer("", {
				opacity:     0.5,
				attribution: "Mobile coverage \u00a9 <a href=\"https://data.gov.au\" target=\"_blank\" rel=\"noreferrer\">ACCC / Dept. of Infrastructure</a>",
				minZoom:     5,
				maxZoom:     18,
				tileSize:    256,
				pane:        "dwMobilePane",
			});
		}
	}

	/* -- QLD Cadastre (Digital Cadastral Database) ------------------------ */

	// Property/parcel boundaries from the QLD Planning Cadastre MapServer.
	// Same export-endpoint pattern as MobileCoverage — convert Leaflet
	// (z,x,y) → EPSG:4326 bbox, request a transparent 256×256 PNG.
	//
	// Hover behaviour: above HOVER_MIN_ZOOM, mousemove triggers a debounced
	// /identify call against layer 8 (Base Parcels Only) and shows a tooltip
	// with Lot/Plan, tenure, area, locality. Stale responses are dropped via
	// a generation counter so fast cursor movement doesn't flicker.
	class QldCadastreLayerProvider extends LayerProvider {
		create() {
			const L = pageWin.L;
			const BASE = CFG.QLD_CADASTRE_SERVICE;
			const LAYER_ID = CFG.QLD_CADASTRE_LAYER_ID;
			const IDENTIFY_LAYER = CFG.QLD_CADASTRE_IDENTIFY_LAYER;
			const HOVER_MIN_ZOOM = CFG.QLD_CADASTRE_HOVER_MIN_ZOOM;

			function tileToBBox(z, x, y) {
				const n    = Math.pow(2, z);
				const lon1 = x / n * 360 - 180;
				const lon2 = (x + 1) / n * 360 - 180;
				const lat1 = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n)))       * 180 / Math.PI;
				const lat2 = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / n))) * 180 / Math.PI;
				return { minLon: lon1, minLat: lat2, maxLon: lon2, maxLat: lat1 };
			}

			function formatTooltip(attrs) {
				const lotPlan = attrs["Lot/plan"] || (attrs.Lot && attrs.Plan ? attrs.Lot + attrs.Plan : "");
				const lines = [];
				if (lotPlan && lotPlan !== "Null") lines.push(`<b>${lotPlan}</b>`);
				const bits = [];
				if (attrs.Tenure && attrs.Tenure !== "Null") bits.push(attrs.Tenure);
				const area = parseFloat(attrs["Lot area (m²)"]);
				if (isFinite(area) && area > 0) {
					bits.push(area >= 10000 ? (area / 10000).toFixed(2) + " ha" : Math.round(area) + " m²");
				}
				if (bits.length) lines.push(bits.join(" · "));
				if (attrs.Locality && attrs.Locality !== "Null") lines.push(attrs.Locality);
				if (attrs["Local authority"] && attrs["Local authority"] !== "Null") {
					lines.push(`<span class="dw-cad-sub">${attrs["Local authority"]}</span>`);
				}
				return lines.join("<br>") || "Parcel";
			}

			const CadastreTileLayer = L.TileLayer.extend({
				onAdd(map) {
					if (!map.getPane("dwCadastrePane")) {
						map.createPane("dwCadastrePane");
						map.getPane("dwCadastrePane").style.zIndex = "385";
						map.getPane("dwCadastrePane").style.pointerEvents = "none";
					}
					L.TileLayer.prototype.onAdd.call(this, map);

					this._tooltip = L.tooltip({ sticky: true, opacity: 0.95, className: "dw-cad-tip", direction: "right", offset: [12, 0] });
					this._lastOid  = null;
					this._debounce = null;
					this._gen      = 0;
					this._onMove   = this._onMove.bind(this);
					this._onLeave  = this._onLeave.bind(this);
					map.on("mousemove", this._onMove);
					map.on("mouseout",  this._onLeave);
				},

				onRemove(map) {
					clearTimeout(this._debounce);
					this._debounce = null;
					this._gen++;
					map.off("mousemove", this._onMove);
					map.off("mouseout",  this._onLeave);
					if (this._tooltip && this._tooltip._map) this._tooltip.remove();
					this._tooltip = null;
					L.TileLayer.prototype.onRemove.call(this, map);
				},

				_onLeave() {
					clearTimeout(this._debounce);
					this._gen++;
					if (this._tooltip && this._tooltip._map) this._tooltip.remove();
					this._lastOid = null;
				},

				_onMove(e) {
					const map = this._map;
					if (!map || map.getZoom() < HOVER_MIN_ZOOM) {
						if (this._tooltip && this._tooltip._map) this._tooltip.remove();
						this._lastOid = null;
						return;
					}
					clearTimeout(this._debounce);
					const latlng = e.latlng;
					this._debounce = setTimeout(() => this._identify(latlng), 180);
				},

				_identify(latlng) {
					const map = this._map;
					if (!map) return;
					const size = map.getSize();
					const b = map.getBounds();
					const mapExtent = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].join(",");
					const imageDisplay = `${size.x},${size.y},96`;
					const geometry = encodeURIComponent(JSON.stringify({
						x: latlng.lng, y: latlng.lat,
						spatialReference: { wkid: 4326 },
					}));
					const myGen = ++this._gen;
					const url =
						`${BASE}/identify` +
						`?geometry=${geometry}` +
						`&geometryType=esriGeometryPoint&sr=4326` +
						`&layers=all%3A${IDENTIFY_LAYER}` +
						`&tolerance=3` +
						`&mapExtent=${mapExtent}` +
						`&imageDisplay=${imageDisplay}` +
						`&returnGeometry=false` +
						`&f=json`;
					GM_xmlhttpRequest({
						method: "GET",
						url,
						onload: (r) => {
							if (myGen !== this._gen || !this._map) return;
							if (r.status !== 200) return;
							try {
								const data = JSON.parse(r.responseText);
								const feat = (data.results || [])[0];
								this._show(latlng, feat || null);
							} catch (_) {}
						},
						onerror: () => {},
					});
				},

				_show(latlng, feat) {
					if (!this._map || !this._tooltip) return;
					if (!feat) {
						if (this._tooltip._map) this._tooltip.remove();
						this._lastOid = null;
						return;
					}
					const attrs = feat.attributes || {};
					const oid = attrs["Object ID"] || attrs.OBJECTID || JSON.stringify(attrs);
					if (oid === this._lastOid && this._tooltip._map) {
						this._tooltip.setLatLng(latlng);
						return;
					}
					this._lastOid = oid;
					this._tooltip
						.setLatLng(latlng)
						.setContent(formatTooltip(attrs));
					if (!this._tooltip._map) this._tooltip.addTo(this._map);
				},
			});

			return new CadastreTileLayer("", {
				opacity:     0.75,
				attribution:
					"Cadastre &copy; <a href=\"https://www.qld.gov.au/dnrme\" target=\"_blank\" rel=\"noreferrer\">State of Queensland (DCDB)</a>",
				minZoom:     11,
				maxZoom:     22,
				tileSize:    256,
				pane:        "dwCadastrePane",
			});
		}
	}

	/* -- QPWS Estate (QLD Parks & Wildlife) ------------------------------- */

	// Server-rendered tile overlay covering protected areas, walking tracks,
	// great walks, horse/MTB/trail-bike trails. Same ArcGIS export pattern as
	// Cadastre/MobileCoverage. Suppressed below zoom 9 — the polygons
	// dominate the view at small scales and the trails aren't visible
	// anyway.
	class QpwsLayerProvider extends LayerProvider {
		create() {
			const L = pageWin.L;
			const BASE = CFG.QLD_QPWS_SERVICE;
			const LAYERS = CFG.QLD_QPWS_LAYER_IDS;

			function tileToBBox(z, x, y) {
				const n    = Math.pow(2, z);
				const lon1 = x / n * 360 - 180;
				const lon2 = (x + 1) / n * 360 - 180;
				const lat1 = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n)))       * 180 / Math.PI;
				const lat2 = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / n))) * 180 / Math.PI;
				return { minLon: lon1, minLat: lat2, maxLon: lon2, maxLat: lat1 };
			}

			const QpwsTileLayer = L.TileLayer.extend({
				onAdd(map) {
					if (!map.getPane("dwQpwsPane")) {
						map.createPane("dwQpwsPane");
						map.getPane("dwQpwsPane").style.zIndex = "396";
						map.getPane("dwQpwsPane").style.pointerEvents = "none";
					}
					L.TileLayer.prototype.onAdd.call(this, map);
				},

				getTileUrl(coords) {
					const { z, x, y } = coords;
					const bb = tileToBBox(z, x, y);
					return (
						`${BASE}/export?` +
						`bbox=${bb.minLon},${bb.minLat},${bb.maxLon},${bb.maxLat}` +
						`&bboxSR=4326&imageSR=4326` +
						`&layers=show:${LAYERS}` +
						`&size=256,256` +
						`&format=png32` +
						`&transparent=true` +
						`&f=image`
					);
				},
			});

			return new QpwsTileLayer("", {
				opacity:     0.85,
				attribution:
					"QPWS &copy; <a href=\"https://parks.qld.gov.au/\" target=\"_blank\" rel=\"noreferrer\">State of Queensland (DETSI)</a>",
				minZoom:     9,
				maxZoom:     22,
				tileSize:    256,
				pane:        "dwQpwsPane",
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
					maxZoom: 22,
					opacity: 1,
					attribution:
						"&copy; <a href=\"https://www.openseamap.org/\" target=\"_blank\" rel=\"noreferrer\">OpenSeaMap</a> contributors",
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
			const L        = pageWin.L;
			const OVERPASS = "https://overpass.kumi.systems/api/interpreter";
			const MIN_ZOOM = 11;

			function lineColor(voltageStr) {
				const v = parseInt(voltageStr, 10) || 0;
				if (v >= 300000) return "#D9534F";   // ≥300 kV: transmission
				if (v >= 100000) return "#F0A500";   // 100–299 kV: sub-transmission
				if (v >=  33000) return "#FFD93D";   // 33–99 kV: HV distribution
				if (v >    0)    return "#9CCC65";   // <33 kV: LV distribution
				return "#888";                       // unknown
			}

			const InfraLayer = L.Layer.extend({
				initialize() {
					this._group    = null;
					this._debounce = null;
					this._lastBbox = null;
				},

				onAdd(map) {
					if (!map.getPane("dwInfraPane")) {
						map.createPane("dwInfraPane");
						map.getPane("dwInfraPane").style.zIndex = "410";
					}
					this._group = L.layerGroup().addTo(map);
					this._fetch();
					map.on("moveend zoomend", this._onViewChange, this);
				},

				onRemove(map) {
					clearTimeout(this._debounce);
					this._debounce = null;
					map.off("moveend zoomend", this._onViewChange, this);
					if (this._group) { this._group.remove(); this._group = null; }
				},

				_onViewChange() {
					clearTimeout(this._debounce);
					this._debounce = setTimeout(() => this._fetch(), 400);
				},

				_fetch() {
					const map = this._map;
					if (!map || !this._group) return;
					if (map.getZoom() < MIN_ZOOM) { this._group.clearLayers(); return; }

					const b    = map.getBounds().pad(0.1);
					const bbox = `${b.getSouth().toFixed(4)},${b.getWest().toFixed(4)},${b.getNorth().toFixed(4)},${b.getEast().toFixed(4)}`;
					if (bbox === this._lastBbox) return;
					this._lastBbox = bbox;

					const q =
						`[out:json][timeout:25];(` +
						`way[power=line](${bbox});` +
						`way[power=minor_line](${bbox});` +
						`way[power=substation](${bbox});` +
						`node[power=substation](${bbox});` +
						`way[power=plant](${bbox});` +
						`node[power=plant](${bbox});` +
						`node[power=generator][\"generator:source\"=wind](${bbox});` +
						`);out geom tags;`;

					GM_xmlhttpRequest({
						method:  "POST",
						url:     OVERPASS,
						headers: { "Content-Type": "application/x-www-form-urlencoded" },
						data:    "data=" + encodeURIComponent(q),
						timeout: 60000,
						onload:  (r) => {
							if (r.status !== 200) return;
							try {
								const json = JSON.parse(r.responseText);
								if (this._group) this._render(json.elements || []);
							} catch (e) {
								console.warn("[CustomTiles] OpenInfra parse error", e);
							}
						},
						onerror: (e) => console.warn("[CustomTiles] OpenInfra request error", e),
					});
				},

				_render(elements) {
					if (!this._group) return;
					this._group.clearLayers();
					for (const el of elements) {
						const tags = el.tags || {};
						const power = tags.power;
						if (!power) continue;

						if (el.type === "way" && el.geometry && (power === "line" || power === "minor_line")) {
							const latlngs = el.geometry.map(g => [g.lat, g.lon]);
							const color = lineColor(tags.voltage);
							L.polyline(latlngs, {
								pane: "dwInfraPane",
								color,
								weight: power === "line" ? 2.2 : 1.4,
								opacity: 0.85,
							}).bindTooltip(
								`<b>${tags.voltage ? tags.voltage + " V" : "Power " + power}</b>` +
								(tags.operator ? `<br>${tags.operator}` : "") +
								(tags.ref ? `<br>Ref: ${tags.ref}` : ""),
								{ className: "dw-infra-tip", sticky: true },
							).addTo(this._group);
							continue;
						}

						let lat, lon;
						if (el.type === "node") { lat = el.lat; lon = el.lon; }
						else if (el.geometry && el.geometry.length) {
							let sLat = 0, sLon = 0;
							for (const g of el.geometry) { sLat += g.lat; sLon += g.lon; }
							lat = sLat / el.geometry.length;
							lon = sLon / el.geometry.length;
						} else { continue; }
						if (!isFinite(lat) || !isFinite(lon)) continue;

						let glyph = "⚡", fill = "#F0A500";   // ⚡ substation
						if (power === "plant")     { glyph = "■"; fill = "#9B59B6"; }   // ■ plant
						else if (power === "generator") { glyph = "❁"; fill = "#5B9BD5"; }   // ❁ wind turbine

						const svg =
							`<svg viewBox="0 0 16 16" width="16" height="16" xmlns="http://www.w3.org/2000/svg">` +
							`<circle cx="8" cy="8" r="6.5" fill="${fill}" stroke="#333" stroke-width="1" opacity="0.9"/>` +
							`<text x="8" y="11.5" text-anchor="middle" font-size="9.5" font-family="sans-serif" fill="#fff">${glyph}</text>` +
							`</svg>`;

						const icon = L.divIcon({
							className: "dw-infra-icon",
							html: svg,
							iconSize:   [16, 16],
							iconAnchor: [8, 8],
						});

						let tip = `<b>${tags.name || ("Power " + power)}</b>`;
						if (tags.voltage)  tip += `<br>Voltage: ${tags.voltage} V`;
						if (tags.operator) tip += `<br>Operator: ${tags.operator}`;

						L.marker([lat, lon], { icon, pane: "dwInfraPane", interactive: true })
							.bindTooltip(tip, { className: "dw-infra-tip", sticky: true })
							.addTo(this._group);
					}
				},

				getAttribution() {
					return "Infrastructure © <a href=\"https://www.openstreetmap.org/copyright\" target=\"_blank\" rel=\"noreferrer\">OpenStreetMap</a> contributors";
				},
			});

			return new InfraLayer();
		}
	}

	/* -- National Parks / Protected Areas (OSM via Overpass) -------------- */

	// Polygons for OSM-tagged national parks and protected areas. Bumped to
	// min zoom 9 so we don't pull continent-scale geometry on world view.
	class NationalParksLayerProvider extends LayerProvider {
		create() {
			const L        = pageWin.L;
			const OVERPASS = "https://overpass.kumi.systems/api/interpreter";
			const MIN_ZOOM = 9;

			const ParksLayer = L.Layer.extend({
				initialize() {
					this._group    = null;
					this._debounce = null;
					this._lastBbox = null;
				},

				onAdd(map) {
					if (!map.getPane("dwParksPane")) {
						map.createPane("dwParksPane");
						map.getPane("dwParksPane").style.zIndex = "395";
						map.getPane("dwParksPane").style.pointerEvents = "none";
					}
					this._group = L.layerGroup().addTo(map);
					this._fetch();
					map.on("moveend zoomend", this._onViewChange, this);
				},

				onRemove(map) {
					clearTimeout(this._debounce);
					this._debounce = null;
					map.off("moveend zoomend", this._onViewChange, this);
					if (this._group) { this._group.remove(); this._group = null; }
				},

				_onViewChange() {
					clearTimeout(this._debounce);
					this._debounce = setTimeout(() => this._fetch(), 500);
				},

				_fetch() {
					const map = this._map;
					if (!map || !this._group) return;
					if (map.getZoom() < MIN_ZOOM) { this._group.clearLayers(); return; }

					const b    = map.getBounds();
					const bbox = `${b.getSouth().toFixed(4)},${b.getWest().toFixed(4)},${b.getNorth().toFixed(4)},${b.getEast().toFixed(4)}`;
					if (bbox === this._lastBbox) return;
					this._lastBbox = bbox;

					// `boundary=national_park` is the strict tag; `protected_area`
					// with protect_class 1–4 covers most reserves people care about
					// (strict reserves, wilderness, national parks, habitat areas).
					const q =
						`[out:json][timeout:25];(` +
						`way[boundary=national_park](${bbox});` +
						`relation[boundary=national_park](${bbox});` +
						`way[boundary=protected_area][\"protect_class\"~\"^[1-4]$\"](${bbox});` +
						`relation[boundary=protected_area][\"protect_class\"~\"^[1-4]$\"](${bbox});` +
						`);out geom tags;`;

					GM_xmlhttpRequest({
						method:  "POST",
						url:     OVERPASS,
						headers: { "Content-Type": "application/x-www-form-urlencoded" },
						data:    "data=" + encodeURIComponent(q),
						timeout: 90000,
						onload:  (r) => {
							if (r.status !== 200) return;
							try {
								const json = JSON.parse(r.responseText);
								if (this._group) this._render(json.elements || []);
							} catch (e) {
								console.warn("[CustomTiles] National Parks parse error", e);
							}
						},
						onerror: (e) => console.warn("[CustomTiles] National Parks request error", e),
					});
				},

				_render(elements) {
					if (!this._group) return;
					this._group.clearLayers();
					for (const el of elements) {
						const tags = el.tags || {};
						const name = tags.name || "Protected area";
						const isNP = tags.boundary === "national_park";
						const style = {
							pane: "dwParksPane",
							color:       isNP ? "#1B5E20" : "#33691E",
							weight:      1.5,
							opacity:     0.85,
							fillColor:   isNP ? "#43A047" : "#7CB342",
							fillOpacity: 0.18,
						};

						if (el.type === "way" && el.geometry) {
							const latlngs = el.geometry.map(g => [g.lat, g.lon]);
							L.polygon(latlngs, style)
								.bindTooltip(name, { className: "dw-park-tip", sticky: true })
								.addTo(this._group);
						} else if (el.type === "relation" && el.members) {
							const rings = [];
							for (const m of el.members) {
								if (m.type !== "way" || !m.geometry) continue;
								if (m.role && m.role !== "outer" && m.role !== "inner") continue;
								rings.push(m.geometry.map(g => [g.lat, g.lon]));
							}
							if (!rings.length) continue;
							L.polygon(rings, style)
								.bindTooltip(name, { className: "dw-park-tip", sticky: true })
								.addTo(this._group);
						}
					}
				},

				getAttribution() {
					return "Parks © <a href=\"https://www.openstreetmap.org/copyright\" target=\"_blank\" rel=\"noreferrer\">OpenStreetMap</a> contributors";
				},
			});

			return new ParksLayer();
		}
	}

	/* -- Light Pollution (lightpollutionmap.info WMS) --------------------- */

	// WMS GetMap served via GeoServer's GWC tile cache. We compute the
	// EPSG:3857 bbox per Leaflet tile (z/x/y) and slot it into the WMS
	// request — the cache hits for tile-aligned bboxes, so this is fast.
	class LightPollutionLayerProvider extends LayerProvider {
		create() {
			const MERC_ORIGIN = 20037508.3428;
			const MERC_FULL = 2 * MERC_ORIGIN;
			const TILE_PX = 256;
			const wmsParams =
				"?REQUEST=GetMap&SERVICE=WMS&VERSION=1.3.0&FORMAT=image%2Fpng" +
				"&STYLES=" + encodeURIComponent(CFG.LIGHTPOL_WMS_STYLE) +
				"&TRANSPARENT=TRUE" +
				"&LAYERS=" + encodeURIComponent(CFG.LIGHTPOL_WMS_LAYER) +
				"&TILED=true&SRS=EPSG%3A3857&CRS=EPSG%3A3857" +
				"&WIDTH=" + TILE_PX + "&HEIGHT=" + TILE_PX;

			const LightPolWmsLayer = L.TileLayer.extend({
				getTileUrl(coords) {
					const n = Math.pow(2, coords.z);
					const tw = MERC_FULL / n;
					const west = -MERC_ORIGIN + coords.x * tw;
					const east = west + tw;
					const north = MERC_ORIGIN - coords.y * tw;
					const south = north - tw;
					return CFG.LIGHTPOL_WMS_BASE + wmsParams +
						"&BBOX=" + west + "," + south + "," + east + "," + north;
				},
			});

			return new LightPolWmsLayer("", {
				tileSize:    TILE_PX,
				minZoom:     0,
				maxNativeZoom: 12,
				maxZoom:     22,
				opacity:     0.65,
				attribution:
					"Light pollution © <a href=\"https://www.lightpollutionmap.info/\" target=\"_blank\" rel=\"noreferrer\">lightpollutionmap.info</a>",
			});
		}
	}

	/* -- Layer Manager UI -------------------------------------------------- */

	class LayerManagerUI {
		constructor(ctrl) {
			this._ctrl = ctrl;
		}

		static escHtml(s) {
			return String(s)
				.replace(/&/g, "&amp;")
				.replace(/</g, "&lt;")
				.replace(/>/g, "&gt;")
				.replace(/"/g, "&quot;");
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
					(isActive ? ' disabled title="Switch to another layer before archiving this one"' : "") +
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
				if (qld) qld.setUrl(CFG.QLD_TILE_TPL + (token ? "?token=" + token : ""));
				if (roads) roads.redraw();
			};
			this.appleToken.onRefresh = (accessKey, version) => {
				const apple = this.layers[CFG.LAYER_APPLE];
				if (apple) apple.setUrl(AppleMapsLayerProvider.tileUrl(accessKey, version));
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
						console.warn("[CustomTiles] Initial Apple token fetch:", err.message);
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
				this.layers[CFG.LAYER_GOOGLE] = new GoogleHybridLayerProvider().create();
				this.layers[CFG.LAYER_APPLE] = new AppleMapsLayerProvider(this.appleToken).create();
				this.layers[CFG.LAYER_STAMEN_TONER] = new StamenTonerLayerProvider().create();
				this.layers[CFG.LAYER_WAYBACK] = new WaybackLayerProvider().create();
				const wayLyr = this.layers[CFG.LAYER_WAYBACK];
				this.waybackHistControl = this._makeHistoryBar({
					layer: wayLyr,
					event: "histchange",
					getCount: () => wayLyr.getHistCount(),
					getIdx:   () => wayLyr.getHistIdx(),
					setIdx:   (i) => wayLyr.setHistIdx(i),
					getLabel: (i) => wayLyr.getHistLabel(i),
				});
				this.layers[CFG.LAYER_QLD] = new QldGlobeLayerProvider(this.qldToken).create();
				this.layers[CFG.LAYER_HIST] = new QldHistoricalLayerProvider(this.qldPhotosToken).create();
				const qldLyr = this.layers[CFG.LAYER_HIST];
				this.histCompass = this._makeHistoryBar({
					layer: qldLyr,
					event: "capturechange",
					getCount: () => qldLyr.getCaptureCount(),
					getIdx:   () => qldLyr.getCaptureIdx(),
					setIdx:   (i) => qldLyr.setCapture(i),
					getLabel: (i) => qldLyr.getCaptureDate(i),
				});

				ctrl.addBaseLayer(this.layers[CFG.LAYER_GOOGLE], CFG.LAYER_GOOGLE);
				ctrl.addBaseLayer(this.layers[CFG.LAYER_APPLE], CFG.LAYER_APPLE);
				ctrl.addBaseLayer(this.layers[CFG.LAYER_STAMEN_TONER], CFG.LAYER_STAMEN_TONER);
				ctrl.addBaseLayer(this.layers[CFG.LAYER_WAYBACK], CFG.LAYER_WAYBACK);
				ctrl.addBaseLayer(this.layers[CFG.LAYER_QLD], CFG.LAYER_QLD);
				ctrl.addBaseLayer(this.layers[CFG.LAYER_HIST], CFG.LAYER_HIST);

				this._injectGroupHeaders(ctrl);

				this.layers[CFG.LAYER_STRAVA] = new StravaHeatmapLayerProvider().create();
				ctrl.addOverlay(this.layers[CFG.LAYER_STRAVA], CFG.LAYER_STRAVA);

				this.layers[CFG.LAYER_GARMIN] = new GarminHeatmapLayerProvider().create();
				ctrl.addOverlay(this.layers[CFG.LAYER_GARMIN], CFG.LAYER_GARMIN);

				this.layers[CFG.LAYER_UW] = new UnityWaterLayerProvider([
					{
						url: CFG.UW_FS_BASE + "/ArcGIS/rest/services/UWPublicAccessWaterInfrastructureLayers/FeatureServer/10",
						fields: "SubtypeCD",
						style: (f) => {
							const s = f.properties && f.properties.SubtypeCD;
							return s === 11101 ? { color: "#005ce6", weight: 3,   opacity: 0.85 }
							     : s === 11102 ? { color: "#00c5ff", weight: 2.5, opacity: 0.85 }
							     :               { color: "#73b2ff", weight: 1.5, opacity: 0.85 };
						},
					},
					{
						url: CFG.UW_FS_BASE + "/ArcGIS/rest/services/UWPublicAccessSewerInfrastructureLayers/FeatureServer/11",
						fields: "NominalDiameter",
						style: { color: "#734c00", weight: 1.5, opacity: 0.85 },
					},
					{
						url: CFG.UW_FS_BASE + "/ArcGIS/rest/services/UWPublicAccessSewerInfrastructureLayers/FeatureServer/12",
						fields: "NominalDiameter",
						style: { color: "#df3c00", weight: 2, opacity: 0.85 },
					},
				]).create();
				ctrl.addOverlay(this.layers[CFG.LAYER_UW], CFG.LAYER_UW);

				this.layers[CFG.LAYER_FLIGHTS] = new FlightsLayerProvider().create();
				ctrl.addOverlay(this.layers[CFG.LAYER_FLIGHTS], CFG.LAYER_FLIGHTS);

				this.layers[CFG.LAYER_MARINE] = new MarineTrafficLayerProvider().create();
				ctrl.addOverlay(this.layers[CFG.LAYER_MARINE], CFG.LAYER_MARINE);

				this.layers[CFG.LAYER_MOBILE] = new MobileCoverageLayerProvider().create();
				ctrl.addOverlay(this.layers[CFG.LAYER_MOBILE], CFG.LAYER_MOBILE);

				this.layers[CFG.LAYER_SEAMARKS] = new OpenSeaMapLayerProvider().create();
				ctrl.addOverlay(this.layers[CFG.LAYER_SEAMARKS], CFG.LAYER_SEAMARKS);

				this.layers[CFG.LAYER_INFRA] = new PowerInfraLayerProvider().create();
				ctrl.addOverlay(this.layers[CFG.LAYER_INFRA], CFG.LAYER_INFRA);

				this.layers[CFG.LAYER_PARKS] = new NationalParksLayerProvider().create();
				ctrl.addOverlay(this.layers[CFG.LAYER_PARKS], CFG.LAYER_PARKS);

				this.layers[CFG.LAYER_LIGHTPOL] = new LightPollutionLayerProvider().create();
				ctrl.addOverlay(this.layers[CFG.LAYER_LIGHTPOL], CFG.LAYER_LIGHTPOL);

				this.layers[CFG.LAYER_CADASTRE] = new QldCadastreLayerProvider().create();
				ctrl.addOverlay(this.layers[CFG.LAYER_CADASTRE], CFG.LAYER_CADASTRE);

				this.layers[CFG.LAYER_QPWS] = new QpwsLayerProvider().create();
				ctrl.addOverlay(this.layers[CFG.LAYER_QPWS], CFG.LAYER_QPWS);

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

				this.layers[CFG.LAYER_ROADS] = new QldRoadsLayerProvider(this.qldToken).create();
				this.layers[CFG.LAYER_LABELS] = new QldLabelsLayerProvider().create();

				map.on("baselayerchange", () => {
					this._syncLabelsLayer(map);
					this._syncHistCompass(map);
					this._syncWaybackHistControl(map);
					this._syncZoomLevel(map);
				});
				map.on("layeradd", (e) => {
					if (
						e.layer === this.layers[CFG.LAYER_QLD] ||
						e.layer === this.layers[CFG.LAYER_GOOGLE] ||
						e.layer === this.layers[CFG.LAYER_HIST] ||
						e.layer === this.layers[CFG.LAYER_WAYBACK]
					) {
						this._syncLabelsLayer(map);
						this._syncHistCompass(map);
						this._syncWaybackHistControl(map);
						this._syncZoomLevel(map);
					}
				});

				this._restoreLayer(map);
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
			for (const lyr of [this.layers[CFG.LAYER_ROADS], this.layers[CFG.LAYER_LABELS]]) {
				if (!lyr) continue;
				if (isQld) { if (!map.hasLayer(lyr)) map.addLayer(lyr); }
				else { if (map.hasLayer(lyr)) map.removeLayer(lyr); }
			}
		}

		_syncHistCompass(map) {
			const hist = this.histCompass;
			if (!hist) return;
			const isHist = !!(
				this.layers[CFG.LAYER_HIST] &&
				map.hasLayer(this.layers[CFG.LAYER_HIST])
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
				map.hasLayer(this.layers[CFG.LAYER_QLD]) ||
				map.hasLayer(this.layers[CFG.LAYER_HIST]) ||
				map.hasLayer(this.layers[CFG.LAYER_WAYBACK]);
			const newMax = isDeep ? 25 : 22;
			map.setMaxZoom(newMax);
			if (map.getZoom() > newMax) map.setZoom(newMax);
		}

		// -- Layer restore ------------------------------------------------

		_restoreLayer(map) {
			const saved = this._readPageCookie(CFG.MAPTYPE_COOKIE);
			const target = saved ? this.layers[saved] : null;
			if (!target) return;

			let attempts = 0;
			const trySwap = () => {
				if (!map._loaded) {
					if (++attempts < 50) setTimeout(trySwap, 150);
					return;
				}
				const toRemove = [];
				map.eachLayer((l) => {
					if (l instanceof L.TileLayer && l !== target) toRemove.push(l);
				});
				toRemove.forEach((l) => map.removeLayer(l));
				if (!map.hasLayer(target)) map.addLayer(target);
				console.info("[CustomTiles] Restored layer:", saved);
			};
			trySwap();
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

				// Give the coordinate title a class we can style
				titleEl.classList.add("dw-popup-coords");

				// Collect native buttons and wrap them all in a flex row
				const nativeBtns = [...pod.querySelectorAll("button")];
				const btnRow = document.createElement("div");
				btnRow.className = "dw-popup-btn-row";
				if (nativeBtns.length) {
					pod.insertBefore(btnRow, nativeBtns[0]);
					nativeBtns.forEach((b) => btnRow.appendChild(b));
				} else {
					pod.appendChild(btnRow);
				}

				// Street View button — subtle blue to signal external link
				const btn = document.createElement("button");
				btn.className = "dw-sv-btn";
				btn.innerHTML =
					'<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
					'<circle cx="12" cy="5" r="3.5"/>' +
					'<path d="M12 10c-3 0-5 1.8-5 4v1h10v-1c0-2.2-2-4-5-4z"/>' +
					'<path d="M9 19l1-5h4l1 5H9z"/>' +
					'</svg>' +
					'Street View';
				btn.addEventListener("click", () => {
					const svUrl =
						"https://www.google.com/maps/@" +
						lat.toFixed(6) + "," + lng.toFixed(6) +
						",3a,75y,90t/data=!3m7!1e1";
					window.open(svUrl, "_blank", "noopener,noreferrer");
				});
				btnRow.appendChild(btn);
			});
		}

		_injectGroupHeaders(ctrl) {
			const collapsedGroups = new Set(
				JSON.parse(GM_getValue("dw_collapsed_groups", "[]"))
			);
			const doInject = () => {
				const container = ctrl.getContainer();
				if (!container) return;
				const base = container.querySelector(".leaflet-control-layers-base");
				if (!base) return;
				const labelMap = new Map();
				for (const lbl of base.querySelectorAll(":scope > label")) {
					const span = lbl.querySelector("span");
					if (span) {
						const name = span.textContent.trim();
						lbl.dataset.dwName = name;
						labelMap.set(name, lbl);
					}
				}
				for (const group of DW_LAYER_GROUPS) {
					const labels = group.names.map((n) => labelMap.get(n)).filter(Boolean);
					if (!labels.length) continue;
					const grpDiv = document.createElement("div");
					grpDiv.className = "dw-layer-group";
					if (collapsedGroups.has(group.header)) grpDiv.classList.add("dw-layer-group--closed");
					const hdr = document.createElement("div");
					hdr.className = "dw-layer-group-header";
					hdr.textContent = group.header;
					hdr.addEventListener("click", () => {
						const nowClosed = grpDiv.classList.toggle("dw-layer-group--closed");
						if (nowClosed) collapsedGroups.add(group.header);
						else collapsedGroups.delete(group.header);
						GM_setValue("dw_collapsed_groups", JSON.stringify([...collapsedGroups]));
					});
					grpDiv.appendChild(hdr);
					const content = document.createElement("div");
					content.className = "dw-layer-group-content";
					grpDiv.appendChild(content);
					base.insertBefore(grpDiv, labels[0]);
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
			const origUpdate = ctrl._update.bind(ctrl);
			ctrl._update = function () { origUpdate(); doInject(); };
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
				if (debounce) { clearTimeout(debounce); debounce = null; }
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
				label.textContent = formatLabel(adapter.getLabel(newIdx), newIdx, count);
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
				get _map() { return attachedMap; },
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
				".dw-opacity-wrap { padding: 2px 6px 4px; }",
				".dw-opacity-slider { display: block; width: 100%; margin: 2px 0 0; cursor: pointer; accent-color: #4a8; }",
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
				".dw-popup-coords { font-family: ui-monospace, Menlo, monospace; font-size: 11.5px; color: #6b7280; margin: 0 0 10px; letter-spacing: 0.04em; }",
				".dw-popup-btn-row { display: flex; flex-wrap: wrap; gap: 6px; }",
				".dw-popup-btn-row button { display: inline-flex; align-items: center; gap: 5px; padding: 5px 12px; font-size: 12.5px; font-family: inherit; background: #f9f9f9; color: #374151; border: 1px solid #d1d5db; border-radius: 5px; cursor: pointer; white-space: nowrap; }",
				".dw-popup-btn-row button:hover { background: #f0f0f0; border-color: #9ca3af; }",
				".dw-sv-btn { background: #eff6ff !important; color: #1d4ed8 !important; border-color: #bfdbfe !important; }",
				".dw-sv-btn:hover { background: #dbeafe !important; border-color: #93c5fd !important; }",
				".dw-flight-icon { background: none !important; border: none !important; }",
				".dw-flight-tip { font-size: 11px; line-height: 1.4; }",
				".dw-marine-icon { background: none !important; border: none !important; }",
				".dw-marine-tip { font-size: 11px; line-height: 1.4; }",
				".dw-cad-tip { font-size: 11px; line-height: 1.35; padding: 4px 7px; background: rgba(255,255,255,0.97); border-color: #888; }",
				".dw-cad-tip b { font-weight: 700; }",
				".dw-cad-tip .dw-cad-sub { color: #6b7280; }",
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

