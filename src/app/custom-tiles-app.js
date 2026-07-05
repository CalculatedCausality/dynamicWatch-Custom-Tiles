import { CFG, DW_LAYER_GROUPS, DW_OVERLAY_GROUPS } from "../config.js";
import { arcgisIdentify, makeHoverIdentify } from "../layers/hover-identify.js";
import { Mode3DButton, Mode3DController } from "../runtime/mode-3d.js";
import { LayerManagerUI } from "../ui/layer-manager-ui.js";
import {
	AppleMapsLayerProvider,
	GoogleHybridLayerProvider,
	MobileCoverageLayerProvider,
	OpenSeaMapLayerProvider,
	QldGlobeLayerProvider,
	QldLabelsLayerProvider,
	QldReliefLayerProvider,
	QldTopoLayerProvider,
	buildAppleTileUrl,
} from "../providers/raster-providers.js";
import { StamenTerrainLayerProvider } from "../providers/stamen-terrain.js";
import { WaybackLayerProvider } from "../providers/wayback.js";
import {
	QldHistoricalLayerProvider,
	QldRoadsLayerProvider,
} from "../providers/qld-imagery.js";
import {
	FlightsLayerProvider,
	MarineTrafficLayerProvider,
	WazeLayerProvider,
} from "../providers/live-data.js";
import {
	GarminHeatmapLayerProvider,
	StravaHeatmapLayerProvider,
} from "../providers/heatmaps.js";
import { LightPollutionLayerProvider } from "../providers/light-pollution.js";
import {
	QldCadastreLayerProvider,
	_cadVal,
	_ensureSalesHook,
	_formatCadastreTooltip,
	_renderSalesContent,
	fetchCadastreAddress,
	fetchOthSales,
} from "../providers/qld-cadastre.js";
import { IntvlGlobalTilesLayerProvider } from "../providers/intvl-global.js";
import {
	SccApplicationsLayerProvider,
	_renderSccPropertyHistory,
	fetchSccPropertyHistory,
} from "../providers/scc-applications.js";
import { GeocachingLayerProvider } from "../providers/geocaching.js";
import {
	PowerInfraLayerProvider,
	TelecomsLayerProvider,
	WaterLayerProvider,
} from "../providers/openinframap.js";
import { createQldEnvironmentProviders } from "../providers/qld-environment.js";
import { AppleTokenManager, QldTokenManager } from "../tokens.js";
import { gmJsonGet } from "../utils/http.js";
import { _escHtml } from "../utils/html.js";

const pageWin = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;

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
const { QpwsLayerProvider, NationalParksLayerProvider } =
	createQldEnvironmentProviders({ makeHoverIdentify, gmJsonGet });

/* -- Application ------------------------------------------------------- */

export class CustomTilesApp {
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
			addOverlay(CFG.LAYER_WAZE,       new WazeLayerProvider());
			addOverlay(CFG.LAYER_GEOCACHING, new GeocachingLayerProvider());
			addOverlay(CFG.LAYER_MOBILE,     new MobileCoverageLayerProvider());
			addOverlay(CFG.LAYER_SEAMARKS,   new OpenSeaMapLayerProvider());
			addOverlay(CFG.LAYER_INFRA,      new PowerInfraLayerProvider());
			addOverlay(CFG.LAYER_TELECOM,    new TelecomsLayerProvider());
			addOverlay(CFG.LAYER_LIGHTPOL,   new LightPollutionLayerProvider());
			addOverlay(CFG.LAYER_CADASTRE,   new QldCadastreLayerProvider());
			addOverlay(CFG.LAYER_SCC_APPS,   new SccApplicationsLayerProvider());
			addOverlay(CFG.LAYER_QPWS,       new QpwsLayerProvider());
			addOverlay(CFG.LAYER_RELIEF,     new QldReliefLayerProvider());
			addOverlay(CFG.LAYER_NATIONAL_PARKS,
				new NationalParksLayerProvider());
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
			this._normalizeBaseZoom(map);
			// Re-normalise when the base SET changes (rare) — catches the
			// site's own bases and any added after init. On zoomend (frequent)
			// we skip the O(bases) lift pass (idempotent once lifted) and only
			// re-clear the zoom-disable, which Leaflet re-applies via its own
			// captured _checkDisabledLayers reference on every zoomend.
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
		// Every one of OUR bases now overzooms (stretches its deepest
		// tile) to z25, so allow the deep range whenever any is active
		// — not just the original four. This is what lets the user
		// keep zooming in (and keeps every base in-range/selectable);
		// the layers stretch rather than blank. Only when the site's
		// OWN default base is active (none of ours) do we leave the
		// conservative 22 cap, since we don't control its tile depth.
		const ours = [
			CFG.LAYER_QLD, CFG.LAYER_HIST, CFG.LAYER_TOPO, CFG.LAYER_WAYBACK,
			CFG.LAYER_GOOGLE, CFG.LAYER_APPLE, CFG.LAYER_STAMEN_TERRAIN,
		];
		const isDeep = ours.some(
			(name) => this.layers[name] && map.hasLayer(this.layers[name]));
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
					try { lyr.redraw(); } catch (_) {}
				}
			}
		}
		// Override the control's zoom-disable check once: every base
		// overzooms now, so none should ever be disabled by zoom.
		if (!ctrl._dwSelectablePatched &&
			typeof ctrl._checkDisabledLayers === "function") {
			ctrl._dwSelectablePatched = true;
			ctrl._checkDisabledLayers = function () {
				for (const inp of (this._layerControlInputs || [])) {
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
			try { ctrl._checkDisabledLayers(); } catch (_) {}
		}
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
		const baseLayers = new Set(
			((this._ctrl && this._ctrl._layers) || [])
				.filter((entry) => !entry.overlay)
				.map((entry) => entry.layer),
		);

		// map.whenReady fires immediately if the map already loaded,
		// or once on the next `load` event otherwise — exact and
		// event-driven, vs. the prior 7.5-second poll budget that
		// silently gave up.
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
			if (!pod) return;

			const titleEl = pod.querySelector("#waypoint-popup-title");
			if (!titleEl) return;
			// Parse "lat, lng" robustly. A naive split(",") corrupts
			// silently under decimal-comma locales: "-27,47, 153,03"
			// splits into 4 parts and yields lat=-27, lng=47 — WRONG
			// coordinates, not a caught NaN. Require EXACTLY two
			// dot-decimal numbers and sane lat/lng ranges; bail
			// otherwise (the site renders dot-decimals, so a 4-part
			// split means we misread and must not act on it).
			const txt = (titleEl.textContent || "").trim();
			const cm = txt.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
			if (!cm) return;
			const lat = parseFloat(cm[1]);
			const lng = parseFloat(cm[2]);
			if (isNaN(lat) || isNaN(lng) ||
				lat < -90 || lat > 90 || lng < -180 || lng > 180) return;

			const popupGen = String((Number(pod.dataset.dwPopupGen) || 0) + 1);
			pod.dataset.dwPopupGen = popupGen;
			pod.dataset.dwLat = lat.toFixed(6);
			pod.dataset.dwLng = lng.toFixed(6);

			// Layer-identify enrichment runs on EVERY open (the popup
			// container can be reused with new coordinates, so stale
			// sections are dropped first). Button/copy handlers are
			// once-per-element and read the latest coordinates from dataset.
			pod.querySelectorAll(".dw-popup-ident").forEach((n) => n.remove());
			this._injectIdentifyIntoPopup(map, lat, lng, pod, popupGen);

			// Give the coordinate title a class we can style, and make it
			// click-to-copy so "lat,lng" lands on the clipboard instantly.
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
					}).catch(() => {});
				});
			}

			if (pod.querySelector(".dw-sv-btn")) return;

			// "Google Maps" button — opens a dropped pin at the
			// coordinates. (Was a direct Street View panorama deep-link
			// `@lat,lng,3a,…!1e1`, but that load is glitchy/unreliable;
			// landing on the Maps pin is solid and Street View is one
			// click away from there via the pegman.) Pin marker icon.
			const btn = document.createElement("button");
			btn.className = "dw-sv-btn";
			btn.type = "button";
			btn.setAttribute("aria-label", "Open current coordinates in Google Maps");
			btn.innerHTML =
				'<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
				'<path d="M12 2C8.1 2 5 5.1 5 9c0 5.2 7 13 7 13s7-7.8 7-13c0-3.9-3.1-7-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/>' +
				"</svg>" +
				"<span>Google Maps</span>";
			btn.addEventListener("click", () => {
				const curLat = Number(pod.dataset.dwLat);
				const curLng = Number(pod.dataset.dwLng);
				if (!isFinite(curLat) || !isFinite(curLng)) return;
				const url = "https://www.google.com/maps?q=" +
					curLat.toFixed(6) + "," + curLng.toFixed(6);
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
		const noHover = L.Browser.mobile ||
			(window.matchMedia && window.matchMedia("(hover: none)").matches);
		const isCurrent = () =>
			pod.isConnected && pod.dataset.dwPopupGen === String(popupGen);
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

		// CADASTRE — always (desktop + touch). The hover tooltip is
		// disabled, so this popup is the sole surface; sales auto-load
		// + embed inline (no separate "Sales ↗" click).
		const cad = this.layers[CFG.LAYER_CADASTRE];
		if (cad && map.hasLayer(cad) &&
			map.getZoom() >= CFG.QLD_CADASTRE_HOVER_MIN_ZOOM) {
			_ensureSalesHook(map);
			arcgisIdentify(map, latlng, {
				baseUrl: CFG.QLD_CADASTRE_SERVICE,
				layers:  "all:" + CFG.QLD_CADASTRE_IDENTIFY_LAYER,
				tolerance: 3,
			}, (err, feat) => {
				if (!isCurrent()) return;
				if (err || !feat) return;
				const attrs = feat.attributes || {};
				const lotplan = _cadVal(attrs["Lot/plan"]);
				// omitSalesLink=true — we embed sales below instead.
				const cadSec = section("dw-popup-ident-cad",
					_formatCadastreTooltip(attrs, null, true));
				if (!lotplan) return;
				fetchCadastreAddress(lotplan, (info) => {
					if (!isCurrent()) return;
					setSection(cadSec, _formatCadastreTooltip(attrs, info, true));
					// Auto-load sales once we have a numbered street
					// address (OTH needs street number + name).
					if (info && isFinite(info.lat) && isFinite(info.lon) &&
						info.streetName && info.streetNumber) {
						const salesSec = section("dw-popup-ident-sales",
							`<div class="dw-sales-pop"><div class="dw-sales-loading">Loading sales…</div></div>`);
						fetchOthSales(info, (result) => {
							if (!isCurrent()) return;
							setSection(salesSec, _renderSalesContent(result));
						});
					}
				});
			});
		}

		// SCC APPLICATIONS — property history for ANY parcel (with or
		// without visible markers) whenever the overlay is on. LatLng →
		// Development.i property lookup → every application ever lodged
		// on that land number, each deep-linking into Development.i.
		const scc = this.layers[CFG.LAYER_SCC_APPS];
		if (scc && map.hasLayer(scc) && map.getZoom() >= 12) {
			fetchSccPropertyHistory(lat, lng, (res) => {
				if (!isCurrent() || !res) return;
				const html = _renderSccPropertyHistory(res);
				if (html) section("dw-popup-ident-scc", html);
			});
		}

		// QPWS — touch only; on desktop QPWS keeps its hover tooltip.
		const qpws = this.layers[CFG.LAYER_QPWS];
		if (noHover && qpws && map.hasLayer(qpws) &&
			map.getZoom() >= CFG.QLD_QPWS_HOVER_MIN_ZOOM) {
			arcgisIdentify(map, latlng, {
				baseUrl: CFG.QLD_QPWS_SERVICE,
				layers:  "all:10",
				tolerance: 5,
			}, (err, feat) => {
				if (!isCurrent()) return;
				if (err || !feat) return;
				const a = feat.attributes || {};
				const name = a.NAME || a.name || a.PARK_NAME || a.park_name || "";
				const type = a.FEAT_TYPE || a.feat_type || a.MANAGE_TYPE || a.manage_type || "";
				if (!name && !type) return;
				section("dw-popup-ident-qpws",
					(name ? `<b>${_escHtml(name)}</b>` : "") +
					(name && type ? "<br>" : "") +
					(type ? _escHtml(type) : ""));
			});
		}
	}

	_injectGroupHeaders(ctrl) {
		// Guard the parse: a corrupt dw_collapsed_groups value would
		// otherwise throw here and abort the whole layer-panel
		// injection (custom groups + archive UI), leaving the user
		// with the bare Leaflet control.
		let savedGroups = [];
		try { savedGroups = JSON.parse(GM_getValue("dw_collapsed_groups", "[]")) || []; }
		catch (_) { savedGroups = []; }
		const collapsedGroups = new Set(
			Array.isArray(savedGroups) ? savedGroups : [],
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
				// a11y: it's a div used as a toggle button — make it
				// keyboard-focusable + operable and announce its state.
				hdr.setAttribute("role", "button");
				hdr.setAttribute("tabindex", "0");
				hdr.setAttribute("aria-expanded",
					String(!collapsedGroups.has(group.header)));
				const toggleGroup = () => {
					const nowClosed = grpDiv.classList.toggle("dw-layer-group--closed");
					hdr.setAttribute("aria-expanded", String(!nowClosed));
					if (nowClosed) collapsedGroups.add(group.header);
					else collapsedGroups.delete(group.header);
					// Guard the persist: GM_setValue can throw on quota.
					try {
						GM_setValue("dw_collapsed_groups",
							JSON.stringify([...collapsedGroups]));
					} catch (_) {}
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
			".dw-scc-notif-badge { color: #dc2626; font-weight: 600; }",
			".dw-scc-hint { color: #999; font-size: 10px; margin-top: 3px; }",
			// Deep-detail section inside the application popup (assessment
			// stages + associated parcels, auto-loaded from Development.i).
			".dw-scc-detail { border-top: 1px solid #e5e7eb; margin-top: 6px; padding-top: 6px; }",
			".dw-scc-det-sec { margin-bottom: 5px; }",
			".dw-scc-det-sec b { font-weight: 700; font-size: 11px; }",
			".dw-scc-stages { max-height: 150px; overflow-y: auto; margin-top: 3px; }",
			".dw-scc-stage { display: flex; justify-content: space-between; gap: 10px; font-size: 11px; line-height: 1.45; padding: 1px 0; border-bottom: 1px dotted #eee; }",
			".dw-scc-stage-desc { color: #374151; }",
			".dw-scc-stage-val { color: #6b7280; text-align: right; flex-shrink: 0; }",
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
