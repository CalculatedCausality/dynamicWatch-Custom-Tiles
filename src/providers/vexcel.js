import { dwMbGmFetchAB, dwRegisterMbLayer } from "../bridge/mapbox-tile-bridge.js";
import { BLANK_TILE, CFG } from "../config.js";
import { LayerProvider } from "../layers/provider-factories.js";
import { gmCancel, gmGet, gmJsonGet, wireTileAbort } from "../utils/http.js";
import {
	_clearSession,
	_ensureAuthedToken,
	_ensureQueryAuth,
	_ensureSession,
	_getStoredSession,
	_getStoredToken,
	_hasCreds,
	_storeToken,
	_vexcelOriginHeaders,
	_vexcelTokenValid,
} from "./vexcel-auth.js";
import {
	_vexcelFootprint,
	createVexcelObliqueLayer,
} from "./vexcel-oblique-layer.js";

// Preserve the provider module's existing exports while app code can import
// auth helpers from their owning module directly.
export {
	_vexcelIsCredString,
	_vexcelLogin,
	_vexcelParseToken,
	_vexcelTokenExp,
	_vexcelTokenValid,
	vexcelHasToken,
} from "./vexcel-auth.js";
export {
	_vexcelBilinear,
	_vexcelClipPathToRect,
	_vexcelClipPathToQuad,
	_vexcelFootprint,
	_vexcelInvBilinear,
	_vexcelMaxDownsample,
} from "./vexcel-oblique-layer.js";

/* -- Vexcel imagery integration -----------------------------------------
 * This module owns Vexcel imagery models and URLs, metadata requests, the
 * docked oblique control, and the Leaflet/Mapbox tile layer. Credential,
 * token, and viewer-session lifecycle is isolated in vexcel-auth.js.
 */

export function _vexcelTileTpl(token, session) {
	const base =
		CFG.VEXCEL_WMTS_BASE +
		"?service=wmts&request=getTile&layer=urban&Style=RGB" +
		"&TileMatrixSet=urban&TileMatrix={z}&TileRow={y}&TileCol={x}" +
		"&format=image/jpeg";
	// The imagery service needs BOTH the session (from configuration/init)
	// AND the JWT — verified: session-only → 403 Forbidden, token-only → 403
	// "Unauthorized by Service", session+token (with the viewer Origin) →
	// 200. The tiles also require an Origin header, so these URLs are fetched
	// via GM_xmlhttpRequest (blob-bridged), never as plain <img> src.
	return session
		? base + "&session=" + encodeURIComponent(session) +
			"&token=" + encodeURIComponent(token)
		: base + "&token=" + encodeURIComponent(token);
}

/* -- Oblique / directional views ---------------------------------------
 * The ortho WMTS is locked to the current-best mosaic on this account
 * (collection/date params ignored; layer=<collection> → 403). But the
 * OBLIQUE photography is per-capture and reachable token-only:
 *   POST /v2/oriented/query → every (direction × capture) at a point
 *   GET  /v2/oriented/tile?downsample=&tile-x=&tile-y=&image-name=…
 *        → 256px JPEG tiles (CORS *), so the oblique loads progressively
 *        in chunks and pans/zooms as a Leaflet image pyramid.
 * So directional N/E/S/W views AND date selection live here, mirroring
 * the Vexcel viewer's oblique panel.
 */

// product-type → compass label. Vexcel names an oblique by the side it
// looks toward; the viewer surfaces these as N/E/S/W.
export const VEXCEL_DIRECTIONS = [
	{ key: "oblique-north", label: "N" },
	{ key: "oblique-east",  label: "E" },
	{ key: "oblique-south", label: "S" },
	{ key: "oblique-west",  label: "W" },
	{ key: "nadir",         label: "Top" },
];

// collection id → capture year for the date picker (au-qld-...-2019 →
// "2019", au-qld-...r2-2021 → "2021"). Falls back to the raw id.
export function _vexcelCollectionYear(collection) {
	const m = String(collection || "").match(/(\d{4})(?!.*\d{4})/);
	return m ? m[1] : String(collection || "");
}

// Band of an image from its name suffix — Vexcel serves each frame as
// `..._rgb` (true colour) and sometimes `..._irg` (near-infrared, false-
// colour: vegetation reads bright red). Only nadir has IR on SCC.
export function _vexcelBand(name) {
	return /_irg$/i.test(String(name || "")) ? "irg" : "rgb";
}

// oriented/query FeatureCollection → { directions, captures, images }.
// images is keyed "<product-type>@<collection>" → { rgb?, irg? }, each
// { name, layer, w, h, corners } for the first (best) photo in that
// cell+band; captures is the distinct collection list newest-first.
export function _vexcelParseObliques(data) {
	const images = {};
	const captureMeta = new Map(); // collection → { year, date }
	const dirSet = new Set();
	for (const f of (data && Array.isArray(data.features) ? data.features : [])) {
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
				corners: _vexcelFootprint(f.geometry),
			};
		}
		if (!captureMeta.has(coll)) {
			// capture-date like "2019-11-29T04:23:00" → "2019-11-29".
			const date = String(p["capture-date"] || "").slice(0, 10) ||
				_vexcelCollectionYear(coll);
			captureMeta.set(coll, { year: _vexcelCollectionYear(coll), date });
		}
		dirSet.add(dir);
	}
	const captures = [...captureMeta.entries()]
		.map(([collection, meta]) => ({ collection, year: meta.year, date: meta.date }))
		.sort((a, b) => b.date.localeCompare(a.date));
	const directions = VEXCEL_DIRECTIONS.filter((d) => dirSet.has(d.key));
	return { images, captures, directions };
}

export function _vexcelObliqueExtractUrl(imageName, layer, lat, lng, token) {
	if (!imageName || !_vexcelTokenValid(token)) return "";
	const wkt = `POINT(${Number(lng)} ${Number(lat)})`;
	return (
		CFG.VEXCEL_API_BASE + "/v2/oriented/extract?" +
		"wkt=" + encodeURIComponent(wkt) +
		"&srid=4326&layer=" + encodeURIComponent(layer || "urban") +
		"&image-name=" + encodeURIComponent(imageName) +
		"&token=" + encodeURIComponent(token)
	);
}

// Tile-pyramid base for an oblique — /v2/oriented/tile serves 256px JPEG
// tiles, so the oblique loads progressively in chunks (pan/zoom) instead of
// one giant image. Needs session+token (and, on the wire, the viewer Origin
// header — added by the GM fetch), so tiles are GM-fetched + blob-bridged.
// downsample/tile-x/tile-y are appended per tile.
export function _vexcelObliqueTileBase(imageName, layer, token, session) {
	if (!imageName || !_vexcelTokenValid(token)) return "";
	return (
		CFG.VEXCEL_API_BASE + "/v2/oriented/tile?layer=" +
		encodeURIComponent(layer || "urban") +
		"&image-name=" + encodeURIComponent(imageName) +
		(session ? "&session=" + encodeURIComponent(session) : "") +
		"&token=" + encodeURIComponent(token)
	);
}

// Fetch every oblique/nadir capture available at a point (token-only,
// not rate-limited — this is the metadata query, not the image pull).
// Queries both programs (wide-area + urban) so rural/edge points that
// only have wide-area coverage still resolve.
export function fetchVexcelObliques(lat, lng, cb) {
	_ensureQueryAuth((token, session) => {
		if (!token) { cb(null); return; }
		_fetchVexcelObliques(lat, lng, token, session, cb);
	});
}
function _fetchVexcelObliques(lat, lng, token, session, cb) {
	if (!_vexcelTokenValid(token)) { cb(null); return; }
	gmJsonGet(
		CFG.VEXCEL_API_BASE + "/v2/oriented/query?session=" +
			encodeURIComponent(session) + "&token=" + encodeURIComponent(token),
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
				include: "collection,capture-date,product-type,image-name," +
					"source-layer,raster-size-width,raster-size-height,geometry",
			}),
			headers: _vexcelOriginHeaders({ "Content-Type": "application/json" }),
		},
		(err, data, raw) => {
			// 401/403 = token rejected server-side despite a valid expiry
			// (quota/revoked). Do NOT clear the token here — `_ensureTokenSilent`
			// already refreshed an EXPIRED one, so a 403 means quota-capped,
			// and clearing would just make the basemap re-mint in a loop.
			// Report "auth" so the caller can show a message; the basemap's
			// give-up logic owns stopping the retries.
			if (raw && (raw.status === 401 || raw.status === 403)) {
				cb(null, "auth"); return;
			}
			if (err || !data) { cb(null); return; }
			const parsed = _vexcelParseObliques(data);
			cb(parsed.directions.length ? parsed : null);
		},
	);
}

function _dirLabel(key) {
	const d = VEXCEL_DIRECTIONS.find((x) => x.key === key);
	return d ? d.label : key;
}

// Fetch the single best-centred frame for a direction+collection at a
// ground point — used while panning to pull the ADJACENT frame as the
// view crosses the current frame's edge.
export function fetchVexcelFrame(lng, lat, collection, dir, band, cb) {
	_ensureQueryAuth((token, session) => {
		if (!token) { cb(null); return; }
		_fetchVexcelFrame(lng, lat, collection, dir, band, token, session, cb);
	});
}
function _fetchVexcelFrame(lng, lat, collection, dir, band, token, session, cb) {
	if (!_vexcelTokenValid(token)) { cb(null); return; }
	gmJsonGet(
		CFG.VEXCEL_API_BASE + "/v2/oriented/query?session=" +
			encodeURIComponent(session) + "&token=" + encodeURIComponent(token),
		{
			method: "POST",
			data: JSON.stringify({
				wkt: `POINT(${Number(lng)} ${Number(lat)})`,
				srid: "4326", layer: "wide-area,urban",
				collection, "product-type": dir, bands: band || "rgb",
				"order-by": "image-center-distance-asc", "total-records": 1,
				include: "image-name,source-layer,raster-size-width," +
					"raster-size-height,geometry",
			}),
			headers: _vexcelOriginHeaders({ "Content-Type": "application/json" }),
		},
		(err, data) => {
			const f = !err && data && Array.isArray(data.features) && data.features[0];
			if (!f) { cb(null); return; }
			const p = f.properties || {};
			cb({
				name: p["image-name"], layer: p["source-layer"] || "urban",
				w: Number(p["raster-size-width"]) || 0,
				h: Number(p["raster-size-height"]) || 0,
				corners: _vexcelFootprint(f.geometry),
			});
		},
	);
}

// Transform points through Vexcel's camera model. `pixel-2-world` accepts
// image pixels and returns [lng,lat]; `world-2-pixel` does the reverse so the
// route can be drawn in the untouched perspective photograph.
export function fetchVexcelPixelPoints(frame, points, operation, cb) {
	if (typeof operation === "function") { cb = operation; operation = "pixel-2-world"; }
	operation = operation === "world-2-pixel" ? operation : "pixel-2-world";
	cb = cb || function () {};
	if (!frame || !frame.name || !Array.isArray(points) || !points.length) {
		cb(null); return;
	}
	const request = {
		aborted: false,
		completed: false,
		handles: [],
		abort() {
			this.aborted = true;
			for (const handle of this.handles) gmCancel(handle);
			this.handles = [];
		},
	};
	_ensureQueryAuth((token) => {
		if (request.aborted) return;
		if (!token) { request.completed = true; cb(null); return; }
		const chunks = [];
		for (let i = 0; i < points.length; i += 100) {
			chunks.push({ start: i, points: points.slice(i, i + 100) });
		}
		const result = new Array(points.length);
		let remaining = chunks.length;
		for (const chunk of chunks) {
			const coords = chunk.points.map((p) => `${Number(p[0])} ${Number(p[1])}`);
			const wkt = coords.length === 1
				? `POINT(${coords[0]})`
				: `LINESTRING(${coords.join(",")})`;
			const handle = gmJsonGet(
				CFG.VEXCEL_API_BASE + "/v2/oriented/transform-points?token=" +
					encodeURIComponent(token),
				{
					method: "POST",
					data: JSON.stringify({
						operation,
						"image-name": frame.name,
						wkt,
						srid: 4326,
						"metadata-format": "json",
					}),
					headers: _vexcelOriginHeaders({ "Content-Type": "application/json" }),
				},
				(err, data) => {
					if (request.aborted) return;
					const transformed = !err && data && Array.isArray(data.points)
						? data.points : null;
					if (transformed && transformed.length === chunk.points.length) {
						for (let i = 0; i < transformed.length; i++) {
							const p = transformed[i] || {};
							const validCoord = (value) => (typeof value === "number" ||
								(typeof value === "string" && value.trim() !== "")) &&
								Number.isFinite(Number(value));
							const directValid = validCoord(p.x) && validCoord(p.y);
							const directUsable = directValid && (operation === "world-2-pixel" ||
								(Math.abs(Number(p.x)) <= 180 && Math.abs(Number(p.y)) <= 90));
							const value = directUsable ? p : (p.location || {});
							const x = Number(value.x), y = Number(value.y);
							const inRange = operation === "world-2-pixel" ||
								(Math.abs(x) <= 180 && Math.abs(y) <= 90);
							if (validCoord(value.x) && validCoord(value.y) && inRange) {
								result[chunk.start + i] = [x, y];
							}
						}
					}
					if (--remaining === 0) {
						request.completed = true;
						cb(result);
					}
				},
			);
			request.handles.push(handle);
		}
	});
	return request;
}

/* -- Vexcel imagery compass (docked, layer-attached) ------------------
 * Selecting a direction displays the untouched perspective photograph on the
 * primary Leaflet map and projects the route into that image's pixel plane.
 * Map panning, zooming, route edits, dates, and directions remain synchronized.
 */
let _vexCtl = null;
let _vexLayer = null; // the base tile layer, so the control can drive date/band

// Flat-ortho capture dates at a point, newest-first — drives the date slider.
// Uses /v2/ortho/collections (final-ortho product), which lists every
// collection covering the point; the year is derived from the collection id.
export function fetchVexcelOrthoDates(lat, lng, cb) {
	_ensureQueryAuth((token, session) => {
		if (!token) { cb(null); return; }
		gmJsonGet(
			CFG.VEXCEL_API_BASE + "/v2/ortho/collections?wkt=" +
				encodeURIComponent(`POINT(${Number(lng)} ${Number(lat)})`) +
				"&srid=4326&layer=urban,wide-area&session=" +
				encodeURIComponent(session) + "&token=" + encodeURIComponent(token),
			{ headers: _vexcelOriginHeaders() },
			(err, data, raw) => {
				if (raw && (raw.status === 401 || raw.status === 403)) { cb(null, "auth"); return; }
				if (err || !data || !Array.isArray(data.features)) { cb(null); return; }
				const seen = new Set(), caps = [];
				for (const f of data.features) {
					const c = f.properties && f.properties.collection;
					if (!c || seen.has(c)) continue;
					seen.add(c);
					caps.push({ collection: c, year: _vexcelCollectionYear(c) });
				}
				// Newest first (year desc); the slider's index 0 = current-best.
				caps.sort((a, b) => String(b.year).localeCompare(String(a.year)));
				cb(caps.length ? caps : null);
			},
		);
	});
}

// Dynamic.watch owns the editable route as Leaflet polylines and markers.
// Keep the Leaflet objects with their coordinates so the projected route can
// forward insert/drag interactions back to the planner.
export function _dwGetRouteModel() {
	try {
		const pageWin = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
		const plan = pageWin.leafletPlan;
		if (!plan || !Array.isArray(plan.lines)) return { paths: [], markers: [] };
		const paths = [], markers = [], seenMarkers = new Set();
		const addMarker = (marker, type) => {
			if (!marker || seenMarkers.has(marker) || typeof marker.getLatLng !== "function") return;
			const point = marker.getLatLng();
			if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return;
			seenMarkers.add(marker);
			markers.push({ marker, type, point: [point.lng, point.lat] });
		};
		for (const line of plan.lines) {
			if (!Array.isArray(line)) continue;
			for (let segmentIdx = 0; segmentIdx < line.length; segmentIdx++) {
				const segment = line[segmentIdx];
				addMarker(segment && segment.marker_end,
					segmentIdx === 0 ? "start" : segmentIdx === line.length - 1 ? "end" : "via");
				const polyline = segment && segment.polyline;
				if (!polyline || typeof polyline.getLatLngs !== "function") continue;
				try {
					const visit = (part) => {
						if (!Array.isArray(part) || !part.length) return;
						if (!part.some(Array.isArray)) {
							const points = part
								.filter((point) => point && Number.isFinite(point.lat) && Number.isFinite(point.lng))
								.map((point) => [point.lng, point.lat]);
							if (points.length > 1) paths.push({ points, polyline });
							return;
						}
						for (const child of part) visit(child);
					};
					visit(polyline.getLatLngs());
				} catch (_) {}
			}
		}
		for (const waypoint of Array.isArray(plan.waypoints) ? plan.waypoints : []) {
			addMarker(waypoint && waypoint.marker, "waypoint");
		}
		return { paths, markers };
	} catch (_) { return { paths: [], markers: [] }; }
}

export function _dwGetRoutePaths() {
	return _dwGetRouteModel().paths.map((entry) => entry.points);
}

export function createVexcelControl() {
	if (_vexCtl) return _vexCtl;
	const el = document.createElement("div");
	el.className = "dw-vex-ctl";
	el.innerHTML =
		'<div class="dw-vex-rose">' +
		'<button type="button" class="dw-vex-dir dw-vex-n" data-dir="oblique-north" title="Look from the north">N</button>' +
		'<button type="button" class="dw-vex-dir dw-vex-w" data-dir="oblique-west" title="Look from the west">W</button>' +
		'<button type="button" class="dw-vex-dir dw-vex-flat dw-vex-c" title="Return to the vertical aerial map">2D</button>' +
		'<button type="button" class="dw-vex-dir dw-vex-e" data-dir="oblique-east" title="Look from the east">E</button>' +
		'<button type="button" class="dw-vex-dir dw-vex-s" data-dir="oblique-south" title="Look from the south">S</button>' +
		"</div>" +
		'<button type="button" class="dw-vex-ir" title="Toggle near-infrared imagery (vegetation shows red)">IR</button>' +
		'<div class="dw-vex-basemsg" style="display:none"></div>';
	L.DomEvent.disableClickPropagation(el);
	L.DomEvent.disableScrollPropagation(el);

	const listeners = {};
	const ctl = {
		el, _map: null,
		lat: 0, lng: 0, atKey: "",
		captures: [],
		capIdx: 0,
		band: "rgb",
		frameBand: "rgb",
		obModel: null,
		obAtKey: "",
		obRequestKey: "",
		capturePendingKey: "",
		pendingOblique: false,
		dir: "oblique-north",
		queried: false,
		obliqueActive: false,
		in3d: false,
		captureGen: 0,
		viewGen: 0,
		frameGen: 0,
		_warpLayer: null,
		_frame: null,
		on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); return ctl; },
		off(ev, fn) { listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn); return ctl; },
		_fire(ev) { for (const f of listeners[ev] || []) { try { f(); } catch (_) {} } },
		setBaseMsg(text) {
			const n = el.querySelector(".dw-vex-basemsg");
			if (!n) return;
			n.textContent = text || "";
			n.style.display = text ? "block" : "none";
		},
	};
	const dirBtns = [...el.querySelectorAll(".dw-vex-dir[data-dir]")];
	const irBtn   = el.querySelector(".dw-vex-ir");
	const flatBtn = el.querySelector(".dw-vex-flat");

	const curCollection = () => {
		const cap = ctl.captures[ctl.capIdx];
		return cap ? cap.collection : "";
	};
	const obliqueCollection = () => {
		if (!ctl.obModel) return curCollection();
		const cap = ctl.captures[ctl.capIdx];
		const exact = ctl.obModel.captures.find((c) => c.collection === curCollection());
		if (exact) return exact.collection;
		const sameYear = cap && ctl.obModel.captures.find((c) => c.year === cap.year);
		if (sameYear) return sameYear.collection;
		return ctl.capIdx === 0 && ctl.obModel.captures[0]
			? ctl.obModel.captures[0].collection : curCollection();
	};
	const cellFor = (dir) => {
		if (!ctl.obModel) return null;
		return ctl.obModel.images[dir + "@" + obliqueCollection()] || null;
	};

	const setMsg = (text) => ctl.setBaseMsg(text);
	ctl.isObliqueActive = () => ctl.obliqueActive;
	ctl.isOverlayOpen = ctl.isObliqueActive;

	const updateIrBtn = () => {
		if (!irBtn) return;
		const available = !ctl.obliqueActive || ctl.frameBand === "irg" ||
			!!(ctl.obModel && cellFor(ctl.dir) && cellFor(ctl.dir).irg);
		irBtn.disabled = !available;
		irBtn.classList.toggle("dw-vex-ir--on", ctl.band === "irg");
	};
	const ensureWarpLayer = () => {
		if (ctl._warpLayer) return ctl._warpLayer;
		ctl._warpLayer = createVexcelObliqueLayer({
			headers: _vexcelOriginHeaders({ Accept: "image/jpeg,image/*,*/*;q=0.8" }),
			tileBase(frame) {
				return _vexcelObliqueTileBase(
					frame.name, frame.layer, _getStoredToken(), _getStoredSession());
			},
			transformPoints: fetchVexcelPixelPoints,
			getRouteModel: _dwGetRouteModel,
			onStatus(status) {
				if (!ctl.obliqueActive || !status.frame || !ctl._frame ||
					status.frame.name !== ctl._frame.name) return;
				if (status.loaded > 0 && status.routeExact) setMsg("");
				else if (status.loaded > 0 && status.routeError) {
					setMsg("The oblique is loaded, but route projection is approximate.");
				} else if (status.loaded > 0) {
					setMsg("Projecting the route onto the oblique…");
				}
				else if (status.error && status.pending === 0) {
					setMsg("Vexcel could not load this oblique frame.");
				}
			},
		});
		return ctl._warpLayer;
	};

	const hideOblique = (message) => {
		ctl.viewGen++;
		ctl.frameGen++;
		ctl.pendingOblique = false;
		ctl.obRequestKey = "";
		ctl.obliqueActive = false;
		ctl.frameBand = "rgb";
		ctl._frame = null;
		el.classList.remove("dw-vex-ctl--active");
		if (ctl._warpLayer) {
			ctl._warpLayer.clearFrame();
			if (ctl._map && ctl._map.hasLayer(ctl._warpLayer)) ctl._map.removeLayer(ctl._warpLayer);
		}
		setMsg(message || "");
		markActiveDir();
		ctl._fire("overlaytoggle");
	};

	const loadFrame = (frame, preserveScale) => {
		const base = _vexcelObliqueTileBase(
			frame.name, frame.layer, _getStoredToken(), _getStoredSession());
		if (!base) {
			hideOblique("Vexcel session expired — reselect the base to refresh it.");
			return;
		}
		if (!frame.corners) {
			hideOblique("Vexcel did not provide ground geometry for this frame.");
			return;
		}
		const next = Object.assign({}, frame, { tileBase: base, preserveScale: !!preserveScale });
		if (ctl.obliqueActive && ctl._frame && ctl._frame.name === next.name &&
			ctl._frame.tileBase === next.tileBase) {
			markActiveDir(); return;
		}
		ctl._frame = next;
		ctl.obliqueActive = true;
		el.classList.add("dw-vex-ctl--active");
		setMsg("Loading " + _dirLabel(ctl.dir) + " oblique…");
		const warp = ensureWarpLayer();
		warp.setFrame(next);
		if (ctl._map && !ctl._map.hasLayer(warp)) warp.addTo(ctl._map);
		markActiveDir();
		ctl._fire("overlaytoggle");
	};

	const load = () => {
		if (!ctl.obModel) {
			hideOblique("No Vexcel oblique here — recentre over a flown area."); return;
		}
		if (!cellFor(ctl.dir)) {
			const fallback = dirBtns.find((button) => cellFor(button.dataset.dir));
			if (fallback) ctl.dir = fallback.dataset.dir;
		}
		const cell = cellFor(ctl.dir);
		if (cell && ctl.band === "irg" && !cell.irg) {
			ctl.band = "rgb";
			if (_vexLayer && _vexLayer._dwSetBand) _vexLayer._dwSetBand("rgb");
			updateIrBtn();
		}
		const img = cell ? (cell[ctl.band] || cell.rgb || cell.irg) : null;
		if (!img) {
			hideOblique("No " + _dirLabel(ctl.dir) + " photo for " +
				(curCollection() || "this date") + " here."); return;
		}
		ctl.frameBand = cell[ctl.band] ? ctl.band : (cell.rgb ? "rgb" : "irg");
		loadFrame(Object.assign({ collection: obliqueCollection() }, img));
	};

	const dirHasPhoto = (dir) => { const c = cellFor(dir); return !!(c && (c.rgb || c.irg)); };
	function markActiveDir() {
		dirBtns.forEach((b) => {
			const has = !ctl.obModel || dirHasPhoto(b.dataset.dir);
			b.classList.toggle("dw-vex-dir--on", ctl.obliqueActive && b.dataset.dir === ctl.dir && has);
			b.classList.toggle("dw-vex-dir--off", ctl.in3d || (!!ctl.obModel && !has));
			b.disabled = ctl.in3d || (!!ctl.obModel && !has);
		});
		if (flatBtn) {
			flatBtn.classList.toggle("dw-vex-dir--on", !ctl.obliqueActive);
			flatBtn.classList.toggle("dw-vex-dir--off", ctl.in3d);
			flatBtn.disabled = ctl.in3d;
		}
		updateIrBtn();
	}

	const ensureObModel = (cb) => {
		if (!ctl._map) return;
		const center = ctl._map.getCenter();
		ctl.lat = center.lat; ctl.lng = center.lng;
		const key = center.lat.toFixed(5) + "," + center.lng.toFixed(5);
		if (ctl.obModel && ctl.obAtKey === key) { cb(); return; }
		setMsg("Loading oblique imagery…");
		const generation = ++ctl.viewGen;
		ctl.obRequestKey = key;
		fetchVexcelObliques(center.lat, center.lng, (model) => {
			const current = ctl._map && ctl._map.getCenter();
			const currentKey = current && current.lat.toFixed(5) + "," + current.lng.toFixed(5);
			if (!ctl._map || generation !== ctl.viewGen || currentKey !== key) return;
			ctl.obRequestKey = "";
			ctl.obModel = model || null;
			ctl.obAtKey = key;
			markActiveDir();
			cb();
		});
	};

	dirBtns.forEach((b) => b.addEventListener("click", () => {
		if (b.disabled) return;
		if (!_vexcelTokenValid(_getStoredToken()) && !_hasCreds()) {
			setMsg("Sign in to Vexcel (reselect the base) to load imagery."); return;
		}
		if (ctl.obliqueActive && ctl.dir === b.dataset.dir) return;
		ctl.dir = b.dataset.dir;
		ctl.frameGen++;
		ctl.pendingOblique = true;
		setMsg("Loading oblique imagery…");
		ensureObModel(() => { ctl.pendingOblique = false; markActiveDir(); load(); });
	}));
	if (flatBtn) flatBtn.addEventListener("click", () => {
		if (ctl.obliqueActive) hideOblique();
	});

	if (irBtn) irBtn.addEventListener("click", () => {
		const toggle = () => {
			ctl.frameGen++;
			ctl.band = ctl.band === "irg" ? "rgb" : "irg";
			if (_vexLayer && _vexLayer._dwSetBand) _vexLayer._dwSetBand(ctl.band);
			updateIrBtn();
			if (ctl.obliqueActive) load();
		};
		if (ctl.obliqueActive && !ctl.obModel) ensureObModel(toggle);
		else toggle();
	});

	ctl.getCaptureCount = () => ctl.captures.length;
	ctl.getCaptureIdx   = () => ctl.capIdx;
	ctl.getCaptureState = () => !ctl.queried ? "loading" : (ctl.captures.length ? "ready" : "empty");
	ctl.getCaptureDate  = (i) => (ctl.captures[i] ? ctl.captures[i].year : "");
	const applyCaptureSelection = (reloadOblique) => {
		const cap = ctl.captures[ctl.capIdx];
		if (_vexLayer && _vexLayer._dwSetCollection) {
			_vexLayer._dwSetCollection(ctl.capIdx === 0 ? "" : (cap ? cap.collection : ""));
		}
		ctl._fire("capturechange");
		markActiveDir();
		if (reloadOblique && ctl.obliqueActive) {
			ctl.frameGen++;
			if (ctl.obModel) { markActiveDir(); load(); }
			else ensureObModel(() => { markActiveDir(); load(); });
		}
	};
	ctl.setCapture = (i) => {
		ctl.frameGen++;
		ctl.capIdx = Math.max(0, Math.min(Number(i) || 0, Math.max(0, ctl.captures.length - 1)));
		applyCaptureSelection(true);
	};

	let refreshTimer = null, frameTimer = null, modelTimer = null;
	const refreshCaptures = () => {
		if (!ctl._map) return;
		const c = ctl._map.getCenter();
		const key = c.lat.toFixed(4) + "," + c.lng.toFixed(4);
		if (ctl.atKey === key) {
			if (!ctl.queried) { ctl.queried = true; ctl._fire("capturechange"); }
			return;
		}
		if (ctl.capturePendingKey === key) return;
		ctl.lat = c.lat; ctl.lng = c.lng;
		ctl.obModel = null; ctl.obAtKey = "";
		markActiveDir();
		if (!_vexcelTokenValid(_getStoredToken()) && !_hasCreds()) {
			ctl.atKey = key;
			ctl.captures = []; ctl.queried = true; ctl._fire("capturechange"); return;
		}
		ctl.queried = false; ctl._fire("capturechange");
		const previous = curCollection();
		const generation = ++ctl.captureGen;
		ctl.capturePendingKey = key;
		fetchVexcelOrthoDates(ctl.lat, ctl.lng, (caps) => {
			const current = ctl._map && ctl._map.getCenter();
			const currentKey = current && current.lat.toFixed(4) + "," + current.lng.toFixed(4);
			if (!ctl._map || generation !== ctl.captureGen || currentKey !== key) {
				if (ctl.capturePendingKey === key) ctl.capturePendingKey = "";
				return;
			}
			ctl.capturePendingKey = "";
			ctl.atKey = key;
			ctl.captures = caps || [];
			ctl.queried = true;
			const previousIdx = ctl.captures.findIndex((cap) => cap.collection === previous);
			if (previousIdx >= 0) ctl.capIdx = previousIdx;
			else if (ctl.capIdx >= ctl.captures.length) ctl.capIdx = 0;
			const changed = curCollection() !== previous;
			applyCaptureSelection(changed);
			if (ctl.obliqueActive && !changed && !ctl.obModel) {
				ensureObModel(() => markActiveDir());
			}
		});
	};
	const refreshFrame = () => {
		if (!ctl._map || !ctl.obliqueActive || !ctl._frame) return;
		const center = ctl._map.getCenter();
		const collection = ctl._frame.collection || obliqueCollection();
		const direction = ctl.dir, band = ctl.frameBand;
		const centerKey = center.lat.toFixed(5) + "," + center.lng.toFixed(5);
		const generation = ++ctl.frameGen;
		fetchVexcelFrame(center.lng, center.lat, collection, direction, band, (frame) => {
			const current = ctl._map && ctl._map.getCenter();
			const currentKey = current && current.lat.toFixed(5) + "," + current.lng.toFixed(5);
			if (!ctl._map || !ctl.obliqueActive || generation !== ctl.frameGen ||
				direction !== ctl.dir || band !== ctl.frameBand || currentKey !== centerKey ||
				!frame || !frame.name) return;
			if (ctl._frame && frame.name === ctl._frame.name) return;
			loadFrame(Object.assign({ collection }, frame), true);
		});
	};
	const scheduleRefresh = () => {
		if (!ctl._map) return;
		const center = ctl._map.getCenter();
		const key5 = center.lat.toFixed(5) + "," + center.lng.toFixed(5);
		const key4 = center.lat.toFixed(4) + "," + center.lng.toFixed(4);
		const modelMoved = (ctl.obRequestKey && ctl.obRequestKey !== key5) ||
			(ctl.obAtKey && ctl.obAtKey !== key5);
		if (modelMoved) {
			ctl.viewGen++;
			ctl.obRequestKey = "";
			ctl.obModel = null;
			ctl.obAtKey = "";
			markActiveDir();
		}
		if (ctl.capturePendingKey && ctl.capturePendingKey !== key4) {
			ctl.captureGen++;
			ctl.capturePendingKey = "";
		}
		ctl.frameGen++;
		clearTimeout(refreshTimer);
		clearTimeout(frameTimer);
		clearTimeout(modelTimer);
		refreshTimer = setTimeout(refreshCaptures, 500);
		if (ctl.obliqueActive) frameTimer = setTimeout(refreshFrame, 350);
		const needsModel = ctl.pendingOblique || (ctl.obliqueActive && !ctl.obModel);
		if (needsModel && ctl.obRequestKey !== key5) {
			modelTimer = setTimeout(() => {
				ensureObModel(() => {
					if (ctl.pendingOblique) { ctl.pendingOblique = false; markActiveDir(); load(); }
					else markActiveDir();
				});
			}, 350);
		}
	};
	const sync3d = () => {
		if (!ctl._map) return;
		const active = ctl._map.getContainer().classList.contains("dw-3d-active");
		ctl.in3d = active;
		if (active && ctl.obliqueActive) hideOblique();
		markActiveDir();
	};

	ctl.addTo = (m) => {
		if (ctl._map) return ctl;
		ctl._map = m;
		m.getContainer().appendChild(el);
		m.on("moveend", scheduleRefresh);
		ctl._modeObserver = new MutationObserver(sync3d);
		ctl._modeObserver.observe(m.getContainer(), { attributes: true, attributeFilter: ["class"] });
		sync3d();
		updateIrBtn();
		markActiveDir();
		refreshCaptures();
		return ctl;
	};
	ctl.remove = () => {
		if (!ctl._map) return ctl;
		ctl._map.off("moveend", scheduleRefresh);
		if (ctl._modeObserver) { ctl._modeObserver.disconnect(); ctl._modeObserver = null; }
		clearTimeout(refreshTimer);
		clearTimeout(frameTimer);
		clearTimeout(modelTimer);
		ctl.captureGen++;
		hideOblique();
		if (el.parentNode) el.parentNode.removeChild(el);
		ctl._map = null;
		ctl.atKey = "";
		ctl.obModel = null;
		ctl.obAtKey = "";
		ctl.obRequestKey = "";
		ctl.capturePendingKey = "";
		return ctl;
	};
	_vexCtl = ctl;
	return ctl;
}

export class VexcelLayerProvider extends LayerProvider {
	create() {
		const spoofOrigin = CFG.VEXCEL_SPOOF_ORIGIN;
		// The imagery service requires the ANZ-viewer Origin header AND both
		// the session + JWT on the query string. An <img> tile can send
		// neither a spoofed Origin nor be gated behind an async session, so
		// tiles are GM-fetched (which CAN set Origin) and blob-bridged, the
		// same pattern Stamen/QLD-Historical use.
		const tileHeaders = {
			Origin: spoofOrigin,
			Referer: spoofOrigin + "/",
			Accept: "image/jpeg,image/*,*/*;q=0.8",
		};
		// Concrete per-tile URL on the viewer's world-layer /ortho/tile
		// endpoint (256px, same tiles as wmts but — unlike wmts — it honours
		// date + band params). "" until a session exists (then the layer
		// redraws), so we never fire a doomed token-only request.
		//   layer._dwVexColl : ""=newest, else order-by that collection (date)
		//   layer._dwVexBand : "rgb" | "irg" (near-infrared, &bands=irg)
		const tileUrl = (z, x, y) => {
			const tok = _getStoredToken(), sess = _getStoredSession();
			if (!_vexcelTokenValid(tok) || !sess) return "";
			let u = CFG.VEXCEL_API_BASE + "/v2/ortho/tile?zoom=" + z +
				"&tile-x=" + x + "&tile-y=" + y +
				"&interpolation=true&layer=urban,wide-area" +
				"&session=" + encodeURIComponent(sess) +
				"&token=" + encodeURIComponent(tok);
			if (layer._dwVexColl) {
				u += "&order-by=" + encodeURIComponent(layer._dwVexColl) +
					",collection-last-capture-date-desc";
			}
			if (layer._dwVexBand === "irg") u += "&bands=irg";
			return u;
		};

		const VexGrid = L.GridLayer.extend({
			createTile(coords, done) {
				const img = document.createElement("img");
				img.setAttribute("role", "presentation");
				const url = tileUrl(coords.z, coords.x, coords.y);
				// Given up, or creds not minted yet → blank (a redraw after
				// auth repaints). data: src so it "loads" without erroring.
				if (this._dwAuthGaveUp || !url) {
					img.src = BLANK_TILE;
					setTimeout(() => done(null, img), 0);
					return img;
				}
				img._dwHandle = gmGet(url, {
					responseType: "arraybuffer", headers: tileHeaders,
				}, (err, r) => {
					img._dwHandle = null;
					if (err) { done(new Error("Vexcel " + err.message), img); return; }
					// 404 = outside flown coverage → blank, NOT an error (so a
					// pan over a gap doesn't look like an auth failure). Only
					// 401/403 (session/token refused) trips the burst.
					if (r.status === 404) { img.src = BLANK_TILE; done(null, img); return; }
					if (r.status !== 200) { done(new Error("Vexcel HTTP " + r.status), img); return; }
					const blob = new Blob([r.response], { type: "image/jpeg" });
					const objUrl = URL.createObjectURL(blob);
					img.onload = () => { URL.revokeObjectURL(objUrl); done(null, img); };
					img.onerror = () => {
						URL.revokeObjectURL(objUrl);
						done(new Error("Vexcel decode failed"), img);
					};
					img.src = objUrl;
				});
				return img;
			},
		});

		const layer = new VexGrid({
			tileSize: 256,
			maxNativeZoom: 21,
			maxZoom: 25,
			attribution:
				'&copy; <a href="https://www.vexcelgroup.com/" target="_blank"' +
				' rel="noreferrer">Vexcel Imaging</a>',
		});
		wireTileAbort(layer);
		const refreshAuthenticatedLayers = () => {
			layer.redraw();
			if (_vexCtl && _vexCtl.obliqueActive && _vexCtl._warpLayer) {
				_vexCtl._warpLayer.refresh();
			}
		};
		// Date (collection) + band state, driven by the docked control. ""
		// collection = current-best (newest); a set collection scrubs to that
		// capture date. Setters redraw only on a real change.
		layer._dwVexColl = "";
		layer._dwVexBand = "rgb";
		layer._dwSetCollection = (c) => {
			if ((c || "") === layer._dwVexColl) return;
			layer._dwVexColl = c || "";
			layer.redraw();
		};
		layer._dwSetBand = (b) => {
			if (b !== layer._dwVexBand) { layer._dwVexBand = b; layer.redraw(); }
		};
		_vexLayer = layer; // so the control can drive date/band

		// Auth happens when the base is SELECTED, not at boot — a page-load
		// prompt would be obnoxious and the token may have rotated. Mint the
		// session (once per token, via configuration/init with the Origin
		// header) then redraw so tiles carry session+token.
		layer.on("add", (e) => {
			layer._dwAuthTries = 0; // fresh activation → allow re-auth
			layer._dwAuthGaveUp = false;
			const ready = (tok) => {
				if (!_vexcelTokenValid(tok)) return;
				_ensureSession(tok, refreshAuthenticatedLayers);
			};
			const cur = _getStoredToken();
			if (_vexcelTokenValid(cur)) ready(cur);
			else _ensureAuthedToken(undefined, ready); // silent auto-login / prompt
			// Show the docked IR toggle (dates ride the shared history bar).
			const map = e && e.target && e.target._map;
			if (map) createVexcelControl().addTo(map);
		});
		layer.on("remove", () => {
			if (_vexCtl) _vexCtl.remove();
		});
		// A real (blob:) tile painted ⇒ session+token+account are all fine →
		// re-arm re-auth and clear any notice. Ignore data: blanks (coverage
		// gaps / not-yet-authed), else the give-up counter would reset on
		// every blank and the storm would never converge.
		layer.on("tileload", (e) => {
			const src = (e && e.tile && e.tile.src) || "";
			if (src.slice(0, 5) === "data:") return; // blank fallback, not a real paint
			layer._dwAuthTries = 0;
			layer._dwAuthGaveUp = false;
			if (_vexCtl && _vexCtl.setBaseMsg && !_vexCtl.obliqueActive) {
				_vexCtl.setBaseMsg("");
			}
		});
		// A BURST of tile errors = the session/token was refused (out-of-
		// coverage 404s blank instead of erroring, so they don't count).
		// Escalate cheaply: (0) the session may have expired while the JWT is
		// still valid → re-mint it via init; (1) the JWT itself is bad →
		// re-auth from creds/prompt + re-mint; (2) give up (account refused /
		// no coverage) — blank and stop, re-armed only by a real paint or a
		// base re-toggle. This bounds logins (≤1 extra) so we never storm.
		let errBurst = 0, errTimer = null;
		layer.on("tileerror", () => {
			if (!layer._map || layer._dwReprompt || layer._dwAuthGaveUp) return;
			errBurst++;
			clearTimeout(errTimer);
			errTimer = setTimeout(() => { errBurst = 0; }, 3000);
			if (errBurst < 6) return;
			errBurst = 0;
			layer._dwReprompt = true;
			const tok = _getStoredToken();
			if (layer._dwAuthTries === 0 && _vexcelTokenValid(tok)) {
				layer._dwAuthTries = 1;
				_clearSession(); // force a fresh session for the same JWT
				_ensureSession(tok, () => {
					layer._dwReprompt = false;
					refreshAuthenticatedLayers();
				});
				return;
			}
			if (layer._dwAuthTries === 1) {
				layer._dwAuthTries = 2;
				_storeToken(""); _clearSession(); // drop both, re-auth from scratch
				_ensureAuthedToken(
					"Vexcel refused the current session (expired or usage limit).",
					(t) => {
						layer._dwReprompt = false;
						if (_vexcelTokenValid(t)) {
							_ensureSession(t, refreshAuthenticatedLayers);
							if (_vexCtl) { _vexCtl.atKey = ""; } // force a re-query
						} else {
							layer._dwAuthGaveUp = true; layer.redraw();
						}
					},
				);
				return;
			}
			// Re-minted the session AND re-authed and STILL refused → the
			// account/session is refused here or there's no coverage. Stop.
			layer._dwReprompt = false;
			layer._dwAuthGaveUp = true;
			layer.redraw();
			if (_vexCtl && _vexCtl.setBaseMsg) {
				_vexCtl.setBaseMsg(
					"No Vexcel imagery loaded here — either this area isn't " +
					"covered, or the account/session was refused. Try another " +
					"area, or reselect the base.");
			}
			console.warn("[CustomTiles] Vexcel: session+token still refused after " +
				"re-auth — no coverage or account refused; stopping retries.");
		});
		// 3D: the Mapbox raster source can't send a spoofed Origin either, so
		// register the same GM-fetch bridge (dw:// / transformRequest) 2D
		// uses. NO _dwMb3DGetUrl — that path would emit a plain raster URL
		// with no Origin header and 401.
		dwRegisterMbLayer(layer, (z, x, y) => new Promise((resolve, reject) => {
			// Self-heal: mint the session here too (cached), so 3D works even
			// if it activates before the 2D `add` minted it.
			const tok = _getStoredToken();
			if (!_vexcelTokenValid(tok)) { reject(new Error("Vexcel: no token")); return; }
			_ensureSession(tok, () => {
				const url = tileUrl(z, x, y);
				if (!url) { reject(new Error("Vexcel: no session")); return; }
				dwMbGmFetchAB(url, { headers: tileHeaders }).then(resolve, reject);
			});
		}));
		return layer;
	}
}
