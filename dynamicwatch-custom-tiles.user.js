// ==UserScript==
// @name         dynamicWatch – Queensland Globe, Google Hybrid & Layer Manager
// @namespace    https://dynamic.watch
// @version      7.1.0
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
// @run-at       document-start
// ==/UserScript==

(function () {
	"use strict";

	const pageWin = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;

	/* -- Configuration ----------------------------------------------------- */

	const CFG = {
		LAYER_QLD: "QLD Globe",
		LAYER_GOOGLE: "Google Hybrid",
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
	};

	const BLANK_TILE =
		"data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

	/* -- QLD Token Manager ------------------------------------------------- */

	class QldTokenManager {
		constructor() {
			this.token = GM_getValue("qld_token", null);
			this.expires = GM_getValue("qld_token_expires", 0);
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
			GM_setValue("qld_token", token);
			GM_setValue("qld_token_expires", expiresMs);
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
							new Error("[QLD] CSRF token not found in Set-Cookie or HTML"),
							null,
						);
						return;
					}
					this._doPost(csrf, done);
				},
				onerror: () =>
					done(
						new Error("[QLD] GET qldglobe.information.qld.gov.au failed"),
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
					url: CFG.QLD_SERVICE,
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
								`[QLD] Token endpoint HTTP ${r.status}: ${r.responseText.slice(0, 160)}`,
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
							"[CustomTiles] QLD token acquired, expires",
							new Date(exp).toISOString(),
						);
						done(null, data.token);
					} catch (e) {
						done(new Error(`[QLD] Parse error: ${e.message}`), null);
					}
				},
				onerror: () => done(new Error("[QLD] Token POST network error"), null),
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
							"[CustomTiles] Token refresh failed:",
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
		constructor() {
			super();
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
			GM_xmlhttpRequest({
				method: "GET",
				url:
					CFG.QLD_HIST_SERVICE + "/query" +
					"?geometry=" + encodeURIComponent(JSON.stringify({ x: c.lng, y: c.lat, spatialReference: { wkid: 4326 } })) +
					"&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects" +
					"&outFields=objectid,name,year,title,capturestart" +
					"&returnGeometry=false&where=category%3D1&orderByFields=capturestart+DESC" +
					"&f=json",
				headers: { Origin: "https://qldglobe.information.qld.gov.au" },
				onload: (r) => {
					this._fetching = false;
					try {
						if (r.status === 200) {
							const data = JSON.parse(r.responseText);
							this._captures = (data.features || [])
								.map((f) => ({
									objectid: f.attributes.objectid,
									title: f.attributes.title || f.attributes.name || String(f.attributes.year || ""),
									captureDate: f.attributes.capturestart
										? new Date(f.attributes.capturestart).toISOString().slice(0, 10)
										: (f.attributes.year ? String(f.attributes.year) : null),
								}))
								.filter((f) => f.objectid);
							if (this._captures.length) {
								console.info("[CustomTiles] QLD Historical:", this._captures.length,
									"captures, latest:", this._captures[0].captureDate || this._captures[0].title);
							} else {
								console.warn("[CustomTiles] QLD Historical: no coverage at",
									c.lng.toFixed(4), c.lat.toFixed(4));
							}
						} else {
							console.error("[CustomTiles] QLD Historical query HTTP", r.status);
							this._captures = [];
						}
					} catch (e) {
						console.error("[CustomTiles] QLD Historical parse error:", e.message);
						this._captures = [];
					}
					this._captureIdx = 0;
					this._currentOid = (this._captures[0] && this._captures[0].objectid) || null;
					this._fetchPending.splice(0).forEach((fn) => fn(this._currentOid));
					if (this._gridLayerRef) this._gridLayerRef.fire("capturechange");
				},
				onerror: () => {
					this._fetching = false;
					console.error("[CustomTiles] QLD Historical query network error");
					this._currentOid = null;
					this._fetchPending.splice(0).forEach((fn) => fn(null));
				},
			});
		}

		create() {
			const provider = this;
			const MERC_ORIGIN = 20037508.3428;
			const MERC_FULL = 2 * MERC_ORIGIN;
			const TILE_PX = 256;
			const SERVICE = CFG.QLD_HIST_SERVICE;

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
						const mosaicRule = encodeURIComponent(
							JSON.stringify({
								mosaicMethod: "esriMosaicLockRaster",
								lockRasterIds: [oid],
								ascending: true,
								where: "category=1",
							}),
						);
						img.onload = () => done(null, img);
						img.onerror = () => done(new Error("QLD Hist tile failed"), img);
						img.src =
							SERVICE +
							"/exportImage?bbox=" + bbox +
							"&bboxSR=102100&imageSR=102100" +
							"&size=" + TILE_PX + "%2C" + TILE_PX +
							"&format=jpg&mosaicRule=" + mosaicRule +
							"&f=image";
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

			let rows = "";
			for (const item of items) {
				const isActive = item.name === activeName;
				const checked = !archived.has(item.name);
				const chkId = "dw-chk-" + item.name.replace(/[^a-z0-9]/gi, "_");
				rows +=
					`<label class="dw-manager-row${isActive ? " dw-manager-row--active" : ""}">` +
					`<input type="checkbox" id="${LayerManagerUI.escHtml(chkId)}"` +
					` data-name="${LayerManagerUI.escHtml(item.name)}"` +
					(checked ? " checked" : "") +
					(isActive
						? ' disabled title="Switch to another layer before archiving this one"'
						: "") +
					`><span class="dw-manager-name">${LayerManagerUI.escHtml(item.name)}</span>` +
					(isActive ? '<span class="dw-badge">active</span>' : "") +
					"</label>";
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
			this.qldToken = new QldTokenManager();
			this.layers = {};
			this.injected = false;
			this.histCompass = null;

			// Wire token refresh callbacks so the managers don't need layer references.
			this.qldToken.onRefresh = (token) => {
				const qld = this.layers[CFG.LAYER_QLD];
				const roads = this.layers[CFG.LAYER_ROADS];
				if (qld) qld.setUrl(CFG.QLD_TILE_TPL + (token ? "?token=" + token : ""));
				if (roads) roads.redraw();
			};
		}

		boot() {
			this._injectStyles();

			if (this.qldToken.isValid()) {
				this.qldToken.scheduleRefresh();
			} else {
				this.qldToken.get((err) => {
					if (err)
						console.warn("[CustomTiles] Initial token fetch:", err.message);
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
				this.layers[CFG.LAYER_QLD] = new QldGlobeLayerProvider(this.qldToken).create();
				this.layers[CFG.LAYER_GOOGLE] = new GoogleHybridLayerProvider().create();
				this.layers[CFG.LAYER_HIST] = new QldHistoricalLayerProvider().create();
				this.histCompass = this._makeHistoryControl(
					this.layers[CFG.LAYER_HIST],
				);

				ctrl.addBaseLayer(this.layers[CFG.LAYER_QLD], CFG.LAYER_QLD);
				ctrl.addBaseLayer(this.layers[CFG.LAYER_GOOGLE], CFG.LAYER_GOOGLE);
				ctrl.addBaseLayer(this.layers[CFG.LAYER_HIST], CFG.LAYER_HIST);

				this.layers[CFG.LAYER_STRAVA] = new StravaHeatmapLayerProvider().create();
				ctrl.addOverlay(this.layers[CFG.LAYER_STRAVA], CFG.LAYER_STRAVA);

				this.layers[CFG.LAYER_GARMIN] = new GarminHeatmapLayerProvider().create();
				ctrl.addOverlay(this.layers[CFG.LAYER_GARMIN], CFG.LAYER_GARMIN);

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
					this._syncZoomLevel(map);
				});
				map.on("layeradd", (e) => {
					if (
						e.layer === this.layers[CFG.LAYER_QLD] ||
						e.layer === this.layers[CFG.LAYER_GOOGLE] ||
						e.layer === this.layers[CFG.LAYER_HIST]
					) {
						this._syncLabelsLayer(map);
						this._syncHistCompass(map);
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
				this.layers[CFG.LAYER_HIST] &&
				map.hasLayer(this.layers[CFG.LAYER_HIST])
			);
			if (isHist && !hist._map) hist.addTo(map);
			else if (!isHist && hist._map) map.removeControl(hist);
		}

		_syncZoomLevel(map) {
			const isDeep =
				map.hasLayer(this.layers[CFG.LAYER_QLD]) ||
				map.hasLayer(this.layers[CFG.LAYER_HIST]);
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

		_makeHistoryControl(layer) {
			const CaptureHistory = L.Control.extend({
				options: { position: "topright" },

				onAdd() {
					const c = L.DomUtil.create("div", "dw-capture-history");
					L.DomEvent.disableClickPropagation(c);

					this._prev = L.DomUtil.create("a", "dw-vxh-btn", c);
					this._prev.href = "#";
					this._prev.title = "Older capture";
					this._prev.innerHTML = "&#9664;";

					this._label = L.DomUtil.create("span", "dw-vxh-label", c);

					this._next = L.DomUtil.create("a", "dw-vxh-btn", c);
					this._next.href = "#";
					this._next.title = "Newer capture";
					this._next.innerHTML = "&#9654;";

					L.DomEvent.on(this._prev, "click", (e) => {
						L.DomEvent.preventDefault(e);
						layer.setCapture(layer.getCaptureIdx() + 1);
					});
					L.DomEvent.on(this._next, "click", (e) => {
						L.DomEvent.preventDefault(e);
						layer.setCapture(layer.getCaptureIdx() - 1);
					});

					this._onCapture = () => this._update();
					layer.on("capturechange", this._onCapture);
					this._update();
					return c;
				},

				onRemove() {
					layer.off("capturechange", this._onCapture);
				},

				_update() {
					const count = layer.getCaptureCount();
					const idx = layer.getCaptureIdx();
					const date = layer.getCaptureDate();
					if (!count) {
						this._label.textContent = "Loading\u2026";
					} else {
						const d = date ? date.slice(0, 10) : "Unknown date";
						this._label.textContent = count > 1 ? `${d}  ${idx + 1}/${count}` : d;
					}
					const canPrev = idx < count - 1;
					const canNext = idx > 0;
					this._prev.classList.toggle("dw-vxh-disabled", !canPrev);
					this._next.classList.toggle("dw-vxh-disabled", !canNext);
				},
			});

			return new CaptureHistory();
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
				".dw-capture-history { display: flex; align-items: center; gap: 3px; padding: 3px 5px; background: rgba(255,255,255,0.92); border-radius: 5px; box-shadow: 0 1px 5px rgba(0,0,0,0.4); font-size: 11px; font-family: sans-serif; white-space: nowrap; }",
				".dw-vxh-btn { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; background: #fff; border: 1px solid #bbb; border-radius: 3px; font-size: 10px; color: #444; text-decoration: none; cursor: pointer; }",
				".dw-vxh-btn:hover:not(.dw-vxh-disabled) { background: #e8f0fb; color: #000; border-color: #888; }",
				".dw-vxh-disabled { opacity: 0.3; cursor: default; pointer-events: none; }",
				".dw-vxh-label { min-width: 85px; text-align: center; color: #333; }",
				".dw-popup-coords { font-family: ui-monospace, Menlo, monospace; font-size: 11.5px; color: #6b7280; margin: 0 0 10px; letter-spacing: 0.04em; }",
				".dw-popup-btn-row { display: flex; flex-wrap: wrap; gap: 6px; }",
				".dw-popup-btn-row button { display: inline-flex; align-items: center; gap: 5px; padding: 5px 12px; font-size: 12.5px; font-family: inherit; background: #f9f9f9; color: #374151; border: 1px solid #d1d5db; border-radius: 5px; cursor: pointer; white-space: nowrap; }",
				".dw-popup-btn-row button:hover { background: #f0f0f0; border-color: #9ca3af; }",
				".dw-sv-btn { background: #eff6ff !important; color: #1d4ed8 !important; border-color: #bfdbfe !important; }",
				".dw-sv-btn:hover { background: #dbeafe !important; border-color: #93c5fd !important; }",
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

