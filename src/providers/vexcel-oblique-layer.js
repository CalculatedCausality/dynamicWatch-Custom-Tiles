import { gmCancel, gmGet } from "../utils/http.js";

const TILE_SIZE = 256;
const WARP_PANE = "dwVexcelObliquePane";

export function _vexcelMaxDownsample(w, h) {
	const px = Math.max(Number(w) || TILE_SIZE, Number(h) || TILE_SIZE);
	return Math.max(0, Math.ceil(Math.log2(px / TILE_SIZE)));
}

export function _vexcelFootprint(geometry) {
	const ring = geometry && geometry.coordinates && geometry.coordinates[0];
	if (!Array.isArray(ring) || ring.length < 4) return null;
	const corners = ring.slice(0, 4).map((p) => [Number(p[0]), Number(p[1])]);
	return corners.every((p) => isFinite(p[0]) && isFinite(p[1])) ? corners : null;
}

export function _vexcelBilinear(corners, u, v) {
	const a = (1 - u) * (1 - v);
	const b = u * (1 - v);
	const d = u * v;
	const e = (1 - u) * v;
	return [
		a * corners[0][0] + b * corners[1][0] + d * corners[2][0] + e * corners[3][0],
		a * corners[0][1] + b * corners[1][1] + d * corners[2][1] + e * corners[3][1],
	];
}

export function _vexcelInvBilinear(corners, lng, lat) {
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

function _pointInQuad(corners, lng, lat) {
	for (let i = 0; i < corners.length; i++) {
		const a = corners[i], b = corners[(i + 1) % corners.length];
		const dx = b[0] - a[0], dy = b[1] - a[1];
		const cross = (lng - a[0]) * dy - (lat - a[1]) * dx;
		const tolerance = 1e-10 * Math.max(1, Math.abs(dx), Math.abs(dy));
		if (Math.abs(cross) <= tolerance &&
			lng >= Math.min(a[0], b[0]) - tolerance && lng <= Math.max(a[0], b[0]) + tolerance &&
			lat >= Math.min(a[1], b[1]) - tolerance && lat <= Math.max(a[1], b[1]) + tolerance) {
			return true;
		}
	}
	let inside = false;
	for (let i = 0, j = corners.length - 1; i < corners.length; j = i++) {
		const a = corners[i], b = corners[j];
		if (((a[1] > lat) !== (b[1] > lat)) &&
			lng < (b[0] - a[0]) * (lat - a[1]) / (b[1] - a[1]) + a[0]) {
			inside = !inside;
		}
	}
	return inside;
}

export function _vexcelClipPathToQuad(path, corners) {
	const segments = [];
	let current = [];
	const same = (a, b) => a && b && Math.abs(a[0] - b[0]) < 1e-10 &&
		Math.abs(a[1] - b[1]) < 1e-10;
	const flush = () => {
		if (current.length > 1) segments.push(current);
		current = [];
	};
	for (let i = 1; i < path.length; i++) {
		const a = path[i - 1], b = path[i];
		const rx = b[0] - a[0], ry = b[1] - a[1];
		const ts = [0, 1];
		for (let edge = 0; edge < corners.length; edge++) {
			const c = corners[edge], d = corners[(edge + 1) % corners.length];
			const sx = d[0] - c[0], sy = d[1] - c[1];
			const den = rx * sy - ry * sx;
			if (Math.abs(den) < 1e-14) continue;
			const qx = c[0] - a[0], qy = c[1] - a[1];
			const t = (qx * sy - qy * sx) / den;
			const u = (qx * ry - qy * rx) / den;
			if (t > 0 && t < 1 && u >= 0 && u <= 1) ts.push(t);
		}
		ts.sort((x, y) => x - y);
		for (let j = 1; j < ts.length; j++) {
			const t0 = ts[j - 1], t1 = ts[j];
			const mid = (t0 + t1) / 2;
			if (!_pointInQuad(corners, a[0] + rx * mid, a[1] + ry * mid)) {
				flush(); continue;
			}
			const p0 = [a[0] + rx * t0, a[1] + ry * t0];
			const p1 = [a[0] + rx * t1, a[1] + ry * t1];
			if (!same(current[current.length - 1], p0)) { flush(); current.push(p0); }
			current.push(p1);
		}
	}
	flush();
	return segments;
}

export function _vexcelClipPathToRect(path, width, height) {
	const segments = [];
	let current = [];
	const same = (a, b) => a && b && Math.abs(a[0] - b[0]) < 1e-7 &&
		Math.abs(a[1] - b[1]) < 1e-7;
	const flush = () => {
		if (current.length > 1) segments.push(current);
		current = [];
	};
	for (let i = 1; i < path.length; i++) {
		const a = path[i - 1], b = path[i];
		if (!a || !b || !Number.isFinite(a[0]) || !Number.isFinite(a[1]) ||
			!Number.isFinite(b[0]) || !Number.isFinite(b[1])) {
			flush(); continue;
		}
		const dx = b[0] - a[0], dy = b[1] - a[1];
		let t0 = 0, t1 = 1, visible = true;
		for (const [p, q] of [[-dx, a[0]], [dx, width - a[0]],
			[-dy, a[1]], [dy, height - a[1]]]) {
			if (Math.abs(p) < 1e-12) {
				if (q < 0) { visible = false; break; }
				continue;
			}
			const r = q / p;
			if (p < 0) t0 = Math.max(t0, r);
			else t1 = Math.min(t1, r);
			if (t0 > t1) { visible = false; break; }
		}
		if (!visible) { flush(); continue; }
		const p0 = [a[0] + dx * t0, a[1] + dy * t0];
		const p1 = [a[0] + dx * t1, a[1] + dy * t1];
		if (!same(current[current.length - 1], p0)) { flush(); current.push(p0); }
		current.push(p1);
	}
	flush();
	return segments;
}

function _vexcelPathLengthMeters(path) {
	let total = 0;
	for (let i = 1; i < path.length; i++) {
		const a = path[i - 1], b = path[i];
		const meanLat = (a[1] + b[1]) * Math.PI / 360;
		const dx = (b[0] - a[0]) * 111320 * Math.cos(meanLat);
		const dy = (b[1] - a[1]) * 110540;
		total += Math.hypot(dx, dy);
	}
	return total;
}

export function _vexcelDensifyPath(path, maxSegmentMeters) {
	if (!Array.isArray(path) || path.length < 2) return Array.isArray(path) ? path.slice() : [];
	const spacing = Math.max(1, Number(maxSegmentMeters) || 5);
	const result = [path[0].slice()];
	for (let i = 1; i < path.length; i++) {
		const a = path[i - 1], b = path[i];
		const meanLat = (a[1] + b[1]) * Math.PI / 360;
		const dx = (b[0] - a[0]) * 111320 * Math.cos(meanLat);
		const dy = (b[1] - a[1]) * 110540;
		const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / spacing));
		for (let step = 1; step <= steps; step++) {
			const t = step / steps;
			result.push([
				a[0] + (b[0] - a[0]) * t,
				a[1] + (b[1] - a[1]) * t,
			]);
		}
	}
	return result;
}

export function createVexcelObliqueLayer(options) {
	options = options || {};
	const PerspectiveLayer = L.Layer.extend({
		initialize() {
			this._frame = null;
			this._tiles = new Map();
			this._queue = [];
			this._inflight = 0;
			this._generation = 0;
			this._nativeScale = 0;
			this._baseZoom = 0;
			this._centerPixel = null;
			this._centerPixelKey = "";
			this._centerRequestKey = "";
			this._centerHandle = null;
			this._routeHandle = null;
			this._routeGeneration = 0;
			this._routeTimer = null;
			this._routeExact = false;
			this._routeError = false;
			this._routeSources = [];
			this._routeMarkers = [];
			this._interactionQueue = [];
			this._interactionHandle = null;
			this._drag = null;
		},

		onAdd(map) {
			if (!map.getPane(WARP_PANE)) {
				const pane = map.createPane(WARP_PANE);
				pane.style.zIndex = "220";
				pane.style.pointerEvents = "none";
			}
			if (!map.getPane("dwVexcelRoutePane")) {
				const pane = map.createPane("dwVexcelRoutePane");
				pane.style.zIndex = "420";
				pane.style.pointerEvents = "none";
			}
			this._container = L.DomUtil.create(
				"div", "leaflet-layer leaflet-zoom-hide dw-vex-warp",
				map.getPane(WARP_PANE));
			this._container.style.cssText =
				"position:absolute;left:0;top:0;transform-origin:0 0;pointer-events:none";
			this._routeSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
			this._routeSvg.classList.add("dw-vex-route", "leaflet-zoom-hide");
			this._routeSvg.style.cssText =
				"position:absolute;left:0;top:0;overflow:visible;transform-origin:0 0;pointer-events:none";
			map.getPane("dwVexcelRoutePane").appendChild(this._routeSvg);
			this._onRouteSvgPointerDown = (event) => this._routePointerDown(event);
			this._onRouteSvgPointerMove = (event) => this._routePointerMove(event);
			this._onRouteSvgPointerUp = (event) => this._routePointerUp(event);
			this._onRouteSvgPointerCancel = (event) => this._routePointerCancel(event);
			this._onRouteSvgClick = (event) => this._routeClick(event);
			this._onRouteSvgDblClick = (event) => this._routeMarkerEvent(event, "dblclick");
			this._onRouteSvgContextMenu = (event) => this._routeMarkerEvent(event, "contextmenu");
			this._routeSvg.addEventListener("pointerdown", this._onRouteSvgPointerDown);
			this._routeSvg.addEventListener("pointermove", this._onRouteSvgPointerMove);
			this._routeSvg.addEventListener("pointerup", this._onRouteSvgPointerUp);
			this._routeSvg.addEventListener("pointercancel", this._onRouteSvgPointerCancel);
			this._routeSvg.addEventListener("click", this._onRouteSvgClick);
			this._routeSvg.addEventListener("dblclick", this._onRouteSvgDblClick);
			this._routeSvg.addEventListener("contextmenu", this._onRouteSvgContextMenu);
			this._onMapClickCapture = (event) => this._projectMapEvent(event, "click");
			this._onMapContextCapture = (event) => this._projectMapEvent(event, "contextmenu");
			map.getContainer().addEventListener("click", this._onMapClickCapture, true);
			map.getContainer().addEventListener("contextmenu", this._onMapContextCapture, true);
			map.getContainer().classList.add("dw-vex-perspective-active");
			this._hiddenReferencePanes = [];
			for (const name of ["dwRoadsPane", "dwLabelsPane"]) {
				const pane = map.getPane(name);
				if (!pane) continue;
				this._hiddenReferencePanes.push([pane, pane.style.opacity]);
				pane.style.opacity = "0";
			}
			const overlayPane = map.getPane("overlayPane");
			if (overlayPane && (options.getRouteModel || options.getRoutePaths)) {
				this._routeObserver = new MutationObserver((records) => {
					if (records.some((record) => this._isRouteMutation(record))) this._scheduleRoute();
				});
				this._routeObserver.observe(overlayPane, {
					subtree: true, childList: true, attributes: true,
					attributeFilter: ["d"],
				});
			}
			this._onPlannerLayerChange = (event) => {
				if (this._isPlannerLayer(event && event.layer)) this._scheduleRoute();
			};
			map.on("layeradd layerremove", this._onPlannerLayerChange);
			this._update();
			this._requestRoute();
		},

		onRemove() {
			this._generation++;
			this._cancelInteractionRequests();
			this._cancelProjectionRequests();
			this._clearTiles();
			if (this._routeSvg) this._routeSvg.replaceChildren();
			clearTimeout(this._routeTimer);
			if (this._routeObserver) { this._routeObserver.disconnect(); this._routeObserver = null; }
			if (this._map && this._onPlannerLayerChange) {
				this._map.off("layeradd layerremove", this._onPlannerLayerChange);
			}
			if (this._map && this._onMapClickCapture) {
				this._map.getContainer().removeEventListener("click", this._onMapClickCapture, true);
				this._map.getContainer().removeEventListener("contextmenu", this._onMapContextCapture, true);
			}
			if (this._routeSvg) {
				this._routeSvg.removeEventListener("pointerdown", this._onRouteSvgPointerDown);
				this._routeSvg.removeEventListener("pointermove", this._onRouteSvgPointerMove);
				this._routeSvg.removeEventListener("pointerup", this._onRouteSvgPointerUp);
				this._routeSvg.removeEventListener("pointercancel", this._onRouteSvgPointerCancel);
				this._routeSvg.removeEventListener("click", this._onRouteSvgClick);
				this._routeSvg.removeEventListener("dblclick", this._onRouteSvgDblClick);
				this._routeSvg.removeEventListener("contextmenu", this._onRouteSvgContextMenu);
			}
			if (this._container && this._container.parentNode) {
				this._container.parentNode.removeChild(this._container);
			}
			if (this._routeSvg && this._routeSvg.parentNode) {
				this._routeSvg.parentNode.removeChild(this._routeSvg);
			}
			if (this._map) this._map.getContainer().classList.remove("dw-vex-perspective-active");
			for (const [pane, opacity] of this._hiddenReferencePanes || []) pane.style.opacity = opacity;
			this._hiddenReferencePanes = [];
			this._container = null;
			this._routeSvg = null;
			this._drag = null;
		},

		getEvents() {
			return {
				moveend: this._update,
				zoomend: this._update,
				viewreset: this._update,
				resize: this._update,
			};
		},

		_isPlannerLayer(layer) {
			if (!layer) return false;
			if (typeof layer.getLatLngs === "function") {
				const className = String(layer.options && layer.options.className || "");
				return /(?:^|\s)route-polyline(?:\s|$)/.test(className);
			}
			if (typeof layer.getLatLng === "function") {
				const className = String(layer.options && layer.options.icon &&
					layer.options.icon.options && layer.options.icon.options.className || "");
				return /(?:^|\s)circle(?:\s|$)/.test(className);
			}
			return false;
		},

		_isRouteMutation(record) {
			const hasRoute = (node) => !!(node && node.nodeType === 1 &&
				(node.matches && node.matches(".route-polyline") ||
					node.querySelector && node.querySelector(".route-polyline")));
			if (record.type === "attributes") return hasRoute(record.target);
			return [...record.addedNodes, ...record.removedNodes].some(hasRoute);
		},

		_scheduleRoute() {
			if (!this._map || !this._frame) return;
			this._routeGeneration++;
			if (this._routeHandle && typeof this._routeHandle.abort === "function") {
				this._routeHandle.abort();
			}
			this._routeHandle = null;
			this._pendingRouteDraw = null;
			this._routeExact = false;
			this._routeError = false;
			for (const hit of this._routeSvg.querySelectorAll(".dw-vex-route-hit")) {
				hit.classList.remove("dw-vex-route-hit");
			}
			for (const handle of this._routeSvg.querySelectorAll(".dw-vex-route-handle")) {
				handle.classList.add("dw-vex-route-handle--stale");
			}
			this._notify();
			clearTimeout(this._routeTimer);
			this._routeTimer = setTimeout(() => this._requestRoute(), 100);
		},

		setFrame(frame) {
			if (!frame || !frame.name || !frame.tileBase || !frame.corners ||
				frame.corners.length !== 4) return false;
			if (this._frame && this._frame.name === frame.name &&
				this._frame.tileBase === frame.tileBase) return true;
			this._generation++;
			this._cancelInteractionRequests();
			clearTimeout(this._routeTimer);
			this._cancelProjectionRequests();
			this._clearTiles();
			if (this._routeSvg) this._routeSvg.replaceChildren();
			this._frame = Object.assign({}, frame, {
				w: Number(frame.w) || 10560,
				h: Number(frame.h) || 14144,
			});
			if (!frame.preserveScale) this._nativeScale = 0;
			this._centerPixel = null;
			this._centerPixelKey = "";
			this._centerRequestKey = "";
			this._routeExact = false;
			this._routeError = false;
			if (this._map) {
				this._ensureScale();
				this._update();
				this._requestRoute();
			}
			return true;
		},

		clearFrame() {
			this._generation++;
			this._cancelInteractionRequests();
			clearTimeout(this._routeTimer);
			this._frame = null;
			this._nativeScale = 0;
			this._centerPixel = null;
			this._centerPixelKey = "";
			this._centerRequestKey = "";
			this._cancelProjectionRequests();
			this._clearTiles();
			if (this._routeSvg) this._routeSvg.replaceChildren();
			this._routeSources = [];
			this._routeMarkers = [];
		},

		getFrame() { return this._frame; },
		getLoadedTileCount() {
			let count = 0;
			for (const tile of this._tiles.values()) if (tile.loaded) count++;
			return count;
		},
		refresh() { if (this._map) { this._update(); this._requestRoute(); } },

		_ensureScale() {
			if (this._nativeScale || !this._map || !this._frame) return;
			const size = this._map.getSize();
			this._nativeScale = Math.max(size.x / this._frame.w, size.y / this._frame.h);
			this._baseZoom = this._map.getZoom();
		},

		_scale() {
			this._ensureScale();
			return this._nativeScale * (2 ** (this._map.getZoom() - this._baseZoom));
		},

		_fallbackPixel(latlng) {
			const uv = _vexcelInvBilinear(
				this._frame.corners, Number(latlng.lng), Number(latlng.lat));
			return [uv[0] * this._frame.w, uv[1] * this._frame.h];
		},

		_layout() {
			if (!this._map || !this._frame || !this._container || !this._routeSvg) return null;
			const scale = this._scale();
			const mapCenter = this._map.getCenter();
			const centerKey = mapCenter.lat.toFixed(6) + "," + mapCenter.lng.toFixed(6);
			const center = this._centerPixelKey === centerKey && this._centerPixel
				? this._centerPixel : this._fallbackPixel(mapCenter);
			const size = this._map.getSize();
			const layerCenter = this._map.containerPointToLayerPoint([size.x / 2, size.y / 2]);
			const left = layerCenter.x - center[0] * scale;
			const top = layerCenter.y - center[1] * scale;
			const transform = `translate3d(${left}px,${top}px,0) scale(${scale})`;
			this._container.style.transform = transform;
			this._routeSvg.style.transform = transform;
			this._routeSvg.setAttribute("width", String(this._frame.w));
			this._routeSvg.setAttribute("height", String(this._frame.h));
			this._routeSvg.setAttribute("viewBox", `0 0 ${this._frame.w} ${this._frame.h}`);
			for (const handle of this._routeSvg.querySelectorAll(".dw-vex-route-handle")) {
				handle.setAttribute("r", String(7 / scale));
			}
			return { scale, left, top };
		},

		_eventPixel(event) {
			if (!this._routeSvg || !this._frame) return null;
			const matrix = this._routeSvg.getScreenCTM();
			if (!matrix) return null;
			let point;
			try {
				point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
			} catch (_) { return null; }
			if (!Number.isFinite(point.x) || !Number.isFinite(point.y) ||
				point.x < 0 || point.y < 0 || point.x > this._frame.w || point.y > this._frame.h) {
				return null;
			}
			return [point.x, point.y];
		},

		_projectPixel(pixel, callback, isCurrent, onError) {
			if (!pixel || !this._frame || !options.transformPoints) return;
			this._interactionQueue.push({
				pixel: pixel.slice(), callback, isCurrent, onError,
				generation: this._generation, frame: this._frame,
			});
			this._pumpPixelProjection();
		},

		_queueInteractionAction(callback, isCurrent) {
			this._interactionQueue.push({
				action: callback, isCurrent,
				generation: this._generation, frame: this._frame,
			});
			this._pumpPixelProjection();
		},

		_pumpPixelProjection() {
			if (this._interactionHandle || !this._interactionQueue.length) return;
			const request = this._interactionQueue.shift();
			if (request.generation !== this._generation || request.frame !== this._frame) {
				this._pumpPixelProjection();
				return;
			}
			if (request.action) {
				if (!request.isCurrent || request.isCurrent()) request.action();
				this._pumpPixelProjection();
				return;
			}
			let handle = null, settled = false;
			const pending = { abort() { if (handle && typeof handle.abort === "function") handle.abort(); } };
			this._interactionHandle = pending;
			const finish = (points) => {
				settled = true;
				if (this._interactionHandle === handle || this._interactionHandle === pending) {
					this._interactionHandle = null;
				}
				const active = request.generation === this._generation && request.frame === this._frame &&
					(!request.isCurrent || request.isCurrent());
				if (active) {
					const exact = points && points[0];
					if (exact && Number.isFinite(exact[0]) && Number.isFinite(exact[1])) {
						request.callback(exact);
					} else if (request.onError) request.onError();
				}
				if (handle !== null) this._pumpPixelProjection();
			};
			handle = options.transformPoints(request.frame, [request.pixel], "pixel-2-world", finish);
			if (settled || handle && handle.completed) {
				this._interactionHandle = null;
				this._pumpPixelProjection();
			} else {
				this._interactionHandle = handle || pending;
			}
		},

		_projectMapEvent(event, type) {
			if (!this._map || !this._frame || event.defaultPrevented ||
				this._map.dragging && this._map.dragging.moved && this._map.dragging.moved()) return;
			const target = event.target;
			if (target && target.closest && target.closest(
				".leaflet-control,.leaflet-popup,.dw-vex-ctl,.leaflet-interactive,.leaflet-marker-icon," +
				".leaflet-tooltip,.dw-vex-route-hit,.dw-vex-route-handle")) return;
			const pixel = this._eventPixel(event);
			if (!pixel) return;
			event.preventDefault();
			event.stopImmediatePropagation();
			const containerRect = this._map.getContainer().getBoundingClientRect();
			const containerPoint = L.point(event.clientX - containerRect.left,
				event.clientY - containerRect.top);
			this._projectPixel(pixel, ([lng, lat]) => {
				const latlng = L.latLng(lat, lng);
				const data = {
					latlng,
					containerPoint,
					layerPoint: this._map.containerPointToLayerPoint(containerPoint),
					originalEvent: event,
				};
				if (type === "click") this._map.fire("preclick", data);
				this._map.fire(type, data);
			});
		},

		_routeClick(event) {
			const handle = event.target && event.target.closest &&
				event.target.closest(".dw-vex-route-handle");
			if (handle) {
				event.preventDefault();
				event.stopPropagation();
				if (Date.now() < (this._suppressMarkerClickUntil || 0)) return;
				const markerEntry = this._routeMarkers[Number(handle.dataset.markerIndex)];
				if (markerEntry && markerEntry.marker && typeof markerEntry.marker.fire === "function") {
					const marker = markerEntry.marker;
					this._queueInteractionAction(() => {
						this._map.fire("preclick", { latlng: marker.getLatLng(), originalEvent: event });
						marker.fire("click", { latlng: marker.getLatLng(), originalEvent: event });
						this._anchorPopup(event);
					}, () => this._map && this._map.hasLayer(marker) &&
						this._routeMarkers.some((entry) => entry.marker === marker));
				}
				return;
			}
			const hit = event.target && event.target.closest && event.target.closest(".dw-vex-route-hit");
			if (!hit) return;
			event.preventDefault();
			event.stopPropagation();
			const source = this._routeSources[Number(hit.dataset.sourceIndex)];
			const pixel = this._eventPixel(event);
			if (!source || !source.polyline || !pixel) return;
			this._projectPixel(pixel, ([lng, lat]) => {
				const latlng = L.latLng(lat, lng);
				const containerRect = this._map.getContainer().getBoundingClientRect();
				const containerPoint = L.point(event.clientX - containerRect.left,
					event.clientY - containerRect.top);
				const data = {
					latlng,
					containerPoint,
					layerPoint: this._map.containerPointToLayerPoint(containerPoint),
					originalEvent: event,
				};
				this._map.fire("preclick", data);
				source.polyline.fire("click", data);
			}, () => this._map && this._map.hasLayer(source.polyline) &&
				this._routeSources.some((entry) => entry.polyline === source.polyline));
		},

		_routeMarkerEvent(event, type) {
			const handle = event.target && event.target.closest &&
				event.target.closest(".dw-vex-route-handle");
			if (!handle) return;
			event.preventDefault();
			event.stopPropagation();
			const markerEntry = this._routeMarkers[Number(handle.dataset.markerIndex)];
			if (!markerEntry || !markerEntry.marker || typeof markerEntry.marker.fire !== "function") return;
			const marker = markerEntry.marker;
			this._queueInteractionAction(() => {
				marker.fire(type, { latlng: marker.getLatLng(), originalEvent: event });
				this._anchorPopup(event);
			}, () => this._map && this._map.hasLayer(marker) &&
				this._routeMarkers.some((entry) => entry.marker === marker));
		},

		_anchorPopup(event) {
			const popup = this._map && this._map._popup;
			if (!popup || !popup._container) return;
			const rect = this._map.getContainer().getBoundingClientRect();
			const point = this._map.containerPointToLayerPoint(
				L.point(event.clientX - rect.left, event.clientY - rect.top));
			L.DomUtil.setPosition(popup._container, point);
		},

		_routePointerDown(event) {
			const handle = event.target && event.target.closest &&
				event.target.closest(".dw-vex-route-handle");
			if (!handle || event.button !== 0) return;
			const markerIndex = Number(handle.dataset.markerIndex);
			const markerEntry = this._routeMarkers[markerIndex];
			if (!markerEntry || !markerEntry.marker) return;
			if (markerEntry.marker.dragging && typeof markerEntry.marker.dragging.enabled === "function" &&
				!markerEntry.marker.dragging.enabled()) return;
			event.preventDefault();
			event.stopPropagation();
			handle.setPointerCapture(event.pointerId);
			this._drag = {
				handle, markerEntry, pointerId: event.pointerId,
				startX: event.clientX, startY: event.clientY, moved: false,
			};
		},

		_routePointerMove(event) {
			const drag = this._drag;
			if (!drag || drag.pointerId !== event.pointerId) return;
			event.preventDefault();
			event.stopPropagation();
			if (!drag.moved && Math.hypot(event.clientX - drag.startX,
				event.clientY - drag.startY) >= 3) {
				drag.moved = true;
				drag.handle.classList.add("dw-vex-route-handle--dragging");
			}
			if (!drag.moved) return;
			const pixel = this._eventPixel(event);
			if (!pixel) return;
			drag.pixel = pixel;
			drag.handle.setAttribute("cx", String(pixel[0]));
			drag.handle.setAttribute("cy", String(pixel[1]));
		},

		_routePointerUp(event) {
			const drag = this._drag;
			if (!drag || drag.pointerId !== event.pointerId) return;
			this._drag = null;
			if (drag.handle.hasPointerCapture && drag.handle.hasPointerCapture(event.pointerId)) {
				drag.handle.releasePointerCapture(event.pointerId);
			}
			event.preventDefault();
			event.stopPropagation();
			drag.handle.classList.remove("dw-vex-route-handle--dragging");
			if (!drag.moved || !drag.pixel) {
				setTimeout(() => this._applyPendingRouteDraw(), 0);
				return;
			}
			this._routeGeneration++;
			if (this._routeHandle && typeof this._routeHandle.abort === "function") {
				this._routeHandle.abort();
			}
			this._routeHandle = null;
			this._pendingRouteDraw = null;
			this._suppressMarkerClickUntil = Date.now() + 500;
			this._projectPixel(drag.pixel, ([lng, lat]) => {
				const marker = drag.markerEntry.marker;
				if (!marker || typeof marker.setLatLng !== "function") return;
				marker.fire("dragstart", { originalEvent: event });
				marker.setLatLng(L.latLng(lat, lng));
				marker.fire("dragend", { originalEvent: event });
				this._scheduleRoute();
			}, () => this._map && this._map.hasLayer(drag.markerEntry.marker) &&
				this._routeMarkers.some((entry) => entry.marker === drag.markerEntry.marker),
				() => this._requestRoute());
		},

		_routePointerCancel(event) {
			const drag = this._drag;
			if (!drag || drag.pointerId !== event.pointerId) return;
			this._drag = null;
			if (drag.handle.hasPointerCapture && drag.handle.hasPointerCapture(event.pointerId)) {
				drag.handle.releasePointerCapture(event.pointerId);
			}
			drag.handle.classList.remove("dw-vex-route-handle--dragging");
			if (!this._applyPendingRouteDraw()) this._requestRoute();
		},

		_applyPendingRouteDraw() {
			const pending = this._pendingRouteDraw;
			if (!pending || this._drag) return false;
			this._pendingRouteDraw = null;
			this._routeExact = pending.exact;
			this._routeError = !pending.exact;
			this._drawRoute(pending.paths, pending.markers);
			this._notify();
			return true;
		},

		_visibleTiles(downsample, layout) {
			const frame = this._frame;
			const sourceScale = 2 ** downsample;
			const span = TILE_SIZE * sourceScale;
			const topLeft = this._map.containerPointToLayerPoint([-160, -160]);
			const size = this._map.getSize();
			const bottomRight = this._map.containerPointToLayerPoint([size.x + 160, size.y + 160]);
			const minX = Math.max(0, (Math.min(topLeft.x, bottomRight.x) - layout.left) / layout.scale);
			const minY = Math.max(0, (Math.min(topLeft.y, bottomRight.y) - layout.top) / layout.scale);
			const maxX = Math.min(frame.w, (Math.max(topLeft.x, bottomRight.x) - layout.left) / layout.scale);
			const maxY = Math.min(frame.h, (Math.max(topLeft.y, bottomRight.y) - layout.top) / layout.scale);
			if (maxX <= minX || maxY <= minY) return [];
			const x0 = Math.max(0, Math.floor(minX / span));
			const y0 = Math.max(0, Math.floor(minY / span));
			const x1 = Math.min(Math.ceil(frame.w / span) - 1, Math.floor(maxX / span));
			const y1 = Math.min(Math.ceil(frame.h / span) - 1, Math.floor(maxY / span));
			const tiles = [];
			const centerX = (minX + maxX) / 2, centerY = (minY + maxY) / 2;
			for (let y = y0; y <= y1; y++) {
				for (let x = x0; x <= x1; x++) {
					const tx0 = x * span, ty0 = y * span;
					const tx1 = Math.min(frame.w, tx0 + span);
					const ty1 = Math.min(frame.h, ty0 + span);
					const dx = (tx0 + tx1) / 2 - centerX;
					const dy = (ty0 + ty1) / 2 - centerY;
					tiles.push({
						x, y, x0: tx0, y0: ty0, x1: tx1, y1: ty1,
						downsample, sourceScale, distance: dx * dx + dy * dy,
					});
				}
			}
			return tiles.sort((a, b) => a.distance - b.distance);
		},

		_chooseTiles(layout) {
			const dpr = Math.max(1, Number(globalThis.devicePixelRatio) || 1);
			let downsample = Math.max(0, Math.min(3,
				Math.floor(Math.log2(Math.max(1, 1 / (layout.scale * dpr))))));
			let tiles = this._visibleTiles(downsample, layout);
			const budget = L.Browser && L.Browser.mobile ? 48 : 96;
			while (tiles.length > budget && downsample < 3) {
				tiles = this._visibleTiles(++downsample, layout);
			}
			return tiles.slice(0, budget);
		},

		_update() {
			if (!this._map || !this._container || !this._frame) return;
			const layout = this._layout();
			if (!layout) return;
			this._requestCenterPixel();
			const required = new Set();
			const tiles = this._chooseTiles(layout);
			for (const tile of tiles) required.add(tile.downsample + "/" + tile.x + "/" + tile.y);
			for (const [key, tile] of this._tiles) {
				if (!required.has(key)) this._removeTile(key, tile);
			}
			const currentBase = options.tileBase
				? options.tileBase(this._frame) : this._frame.tileBase;
			for (const tile of tiles) {
				const key = tile.downsample + "/" + tile.x + "/" + tile.y;
				let record = this._tiles.get(key);
				if (record && record.failed && currentBase &&
					record.lastTileBase && currentBase !== record.lastTileBase) {
					record.tries = 0;
					record.retryAt = 0;
				}
				if (record && record.failed && record.tries < 3 &&
					Date.now() >= record.retryAt) {
					record.failed = false;
					this._queue.push(record);
				}
				if (!record) {
					record = this._createTile(key, tile);
					this._tiles.set(key, record);
					this._queue.push(record);
				}
			}
			this._pump();
			this._notify();
		},

		_createTile(key, tile) {
			const root = document.createElement("div");
			root.className = "dw-vex-warp-tile";
			root.dataset.tile = key;
			root.dataset.imageName = this._frame.name;
			root.style.cssText = "position:absolute;pointer-events:none;overflow:hidden";
			root.style.left = tile.x0 + "px";
			root.style.top = tile.y0 + "px";
			root.style.width = (tile.x1 - tile.x0) + "px";
			root.style.height = (tile.y1 - tile.y0) + "px";
			this._container.appendChild(root);
			const img = document.createElement("img");
			img.alt = "";
			img.setAttribute("role", "presentation");
			const fullSpan = TILE_SIZE * tile.sourceScale;
			img.style.cssText = "display:block;max-width:none;opacity:0;width:" +
				fullSpan + "px;height:" + fullSpan + "px";
			root.appendChild(img);
			return Object.assign({
				key, root, img, loaded: false, removed: false, tries: 0, retryAt: 0,
			}, tile);
		},

		_requestCenterPixel() {
			if (!options.transformPoints || !this._map || !this._frame) return;
			const center = this._map.getCenter();
			const key = center.lat.toFixed(6) + "," + center.lng.toFixed(6);
			if (key === this._centerPixelKey || key === this._centerRequestKey) return;
			if (this._centerHandle && typeof this._centerHandle.abort === "function") {
				this._centerHandle.abort();
			}
			this._centerHandle = null;
			this._centerRequestKey = key;
			const generation = this._generation, frame = this._frame;
			let handle = null;
			handle = options.transformPoints(frame, [[center.lng, center.lat]],
				"world-2-pixel", (pixels) => {
					if (generation !== this._generation || frame !== this._frame) return;
					if (pixels && pixels[0] && isFinite(pixels[0][0]) && isFinite(pixels[0][1])) {
						this._centerPixel = pixels[0];
						this._centerPixelKey = key;
						this._update();
					}
					if (this._centerRequestKey === key) this._centerRequestKey = "";
					if (this._centerHandle === handle) this._centerHandle = null;
				});
			this._centerHandle = handle && !handle.completed ? handle : null;
		},

		_requestRoute() {
			if (!this._map || !this._frame || !this._routeSvg ||
				(!options.getRouteModel && !options.getRoutePaths)) return;
			clearTimeout(this._routeTimer);
			this._routeGeneration++;
			if (this._routeHandle && typeof this._routeHandle.abort === "function") {
				this._routeHandle.abort();
			}
			this._routeHandle = null;
			const rawModel = options.getRouteModel ? options.getRouteModel() : {
				paths: options.getRoutePaths().map((points) => ({ points })), markers: [],
			};
			const sources = Array.isArray(rawModel && rawModel.paths) ? rawModel.paths
				.filter((entry) => entry && Array.isArray(entry.points)) : [];
			const clippedPaths = [];
			for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
				for (const points of _vexcelClipPathToQuad(
					sources[sourceIndex].points, this._frame.corners)) {
					clippedPaths.push({ points, sourceIndex });
				}
			}
			const totalMeters = clippedPaths.reduce((total, entry) =>
				total + _vexcelPathLengthMeters(entry.points), 0);
			// Three-metre ground samples follow terrain/lens curvature closely;
			// very long routes are relaxed enough to keep API batches bounded.
			const routeSpacing = Math.max(3, totalMeters / 1800);
			const paths = clippedPaths.map((entry) => ({
				sourceIndex: entry.sourceIndex,
				points: _vexcelDensifyPath(entry.points, routeSpacing),
			}));
			const markers = (Array.isArray(rawModel && rawModel.markers) ? rawModel.markers : [])
				.filter((entry) => entry && Array.isArray(entry.point) &&
					Number.isFinite(entry.point[0]) && Number.isFinite(entry.point[1]) &&
					_pointInQuad(this._frame.corners, entry.point[0], entry.point[1]));
			this._routeSources = sources;
			this._routeMarkers = markers;
			if (!paths.length && !markers.length) {
				this._routeExact = true;
				this._routeError = false;
				this._drawRoute([], []);
				this._notify();
				return;
			}
			const flat = [], indices = [];
			const projected = paths.map((entry) => ({
				sourceIndex: entry.sourceIndex,
				points: entry.points.map(() => null),
			}));
			const projectedMarkers = markers.map((entry) => ({ entry, point: null }));
			for (let pathIdx = 0; pathIdx < paths.length; pathIdx++) {
				for (let pointIdx = 0; pointIdx < paths[pathIdx].points.length; pointIdx++) {
					const [lng, lat] = paths[pathIdx].points[pointIdx];
					flat.push([lng, lat]);
					indices.push({ pathIdx, pointIdx });
				}
			}
			for (let markerIdx = 0; markerIdx < markers.length; markerIdx++) {
				const [lng, lat] = markers[markerIdx].point;
				flat.push([lng, lat]);
				indices.push({ markerIdx });
			}
			this._routeExact = false;
			this._routeError = false;
			this._notify();
			if (!flat.length) {
				this._routeExact = true;
				this._routeError = false;
				this._notify();
				return;
			}
			if (!options.transformPoints) {
				this._routeError = true;
				this._drawRoute([], []);
				this._notify();
				return;
			}
			const generation = this._generation, routeGeneration = this._routeGeneration;
			const frame = this._frame;
			let handle = null;
			handle = options.transformPoints(frame, flat, "world-2-pixel", (pixels) => {
				if (generation !== this._generation || routeGeneration !== this._routeGeneration ||
					frame !== this._frame) return;
				if (!pixels || pixels.length !== flat.length) {
					this._routeError = true;
					this._drawRoute([], []);
					this._notify();
					if (this._routeHandle === handle) this._routeHandle = null;
					return;
				}
				let complete = true;
				for (let i = 0; i < indices.length; i++) {
					const pixel = pixels[i];
					if (!pixel || !isFinite(pixel[0]) || !isFinite(pixel[1])) {
						complete = false; continue;
					}
					const index = indices[i];
					if (index.markerIdx != null) projectedMarkers[index.markerIdx].point = pixel;
					else projected[index.pathIdx].points[index.pointIdx] = pixel;
				}
				if (!complete) {
					this._routeExact = false;
					this._routeError = true;
					this._drawRoute([], []);
					this._notify();
				} else if (this._drag) {
					this._pendingRouteDraw = {
						paths: projected, markers: projectedMarkers, exact: true,
					};
				} else {
					this._routeExact = true;
					this._routeError = false;
					this._drawRoute(projected, projectedMarkers);
					this._notify();
				}
				if (this._routeHandle === handle) this._routeHandle = null;
			});
			this._routeHandle = handle && !handle.completed ? handle : null;
		},

		_drawRoute(paths, markers) {
			if (!this._routeSvg || !this._frame) return;
			this._routeSvg.replaceChildren();
			const rendered = [];
			for (const entry of paths) {
				const points = entry.points || entry;
				const source = this._routeSources[entry.sourceIndex];
				const options = source && source.polyline && source.polyline.options || {};
				const weight = Number.isFinite(Number(options.weight)) ? Number(options.weight) : 8;
				const opacity = Number.isFinite(Number(options.opacity)) ? Number(options.opacity) : 0.4;
				for (const segment of _vexcelClipPathToRect(points, this._frame.w, this._frame.h)) {
					rendered.push({
						d: segment.map((p, i) => (i ? "L" : "M") + p[0] + " " + p[1]).join(" "),
						sourceIndex: entry.sourceIndex == null ? -1 : entry.sourceIndex,
						color: String(options.color || "#9400D3"),
						weight,
						opacity,
						lineCap: String(options.lineCap || "round"),
						lineJoin: String(options.lineJoin || "round"),
						dashArray: options.dashArray == null ? "" : String(options.dashArray),
						dashOffset: options.dashOffset == null ? "" : String(options.dashOffset),
					});
				}
			}
			for (const item of rendered) {
				const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
				path.classList.add("dw-vex-route-visual");
				path.dataset.sourceIndex = String(item.sourceIndex);
				path.setAttribute("d", item.d);
				path.setAttribute("fill", "none");
				path.setAttribute("stroke", item.color);
				path.setAttribute("stroke-width", String(item.weight));
				path.setAttribute("stroke-opacity", String(item.opacity));
				path.setAttribute("stroke-linecap", item.lineCap);
				path.setAttribute("stroke-linejoin", item.lineJoin);
				if (item.dashArray) path.setAttribute("stroke-dasharray", item.dashArray);
				if (item.dashOffset) path.setAttribute("stroke-dashoffset", item.dashOffset);
				path.setAttribute("vector-effect", "non-scaling-stroke");
				this._routeSvg.appendChild(path);
			}
			for (const item of rendered) {
				const hit = document.createElementNS("http://www.w3.org/2000/svg", "path");
				hit.classList.add("dw-vex-route-hit");
				hit.dataset.sourceIndex = String(item.sourceIndex);
				hit.setAttribute("d", item.d);
				hit.setAttribute("fill", "none");
				hit.setAttribute("stroke", "transparent");
				hit.setAttribute("stroke-width", String(Math.max(20, item.weight + 12)));
				hit.setAttribute("stroke-linecap", "round");
				hit.setAttribute("stroke-linejoin", "round");
				hit.setAttribute("vector-effect", "non-scaling-stroke");
				this._routeSvg.appendChild(hit);
			}
			const scale = this._scale() || 1;
			for (let markerIdx = 0; markerIdx < (markers || []).length; markerIdx++) {
				const marker = markers[markerIdx];
				const point = marker && marker.point;
				if (!point || !Number.isFinite(point[0]) || !Number.isFinite(point[1]) ||
					point[0] < 0 || point[1] < 0 || point[0] > this._frame.w || point[1] > this._frame.h) {
					continue;
				}
				const type = marker.entry && marker.entry.type || "via";
				const colors = {
					start: "#7ac943", end: "#ef2929", via: "#fff", waypoint: "#2684ff",
				};
				const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
				circle.classList.add("dw-vex-route-handle", "dw-vex-route-handle--" + type);
				const sourceMarker = marker.entry && marker.entry.marker;
				if (sourceMarker && sourceMarker.dragging &&
					typeof sourceMarker.dragging.enabled === "function" && !sourceMarker.dragging.enabled()) {
					circle.classList.add("dw-vex-route-handle--disabled");
				}
				circle.dataset.markerIndex = String(markerIdx);
				circle.setAttribute("cx", String(point[0]));
				circle.setAttribute("cy", String(point[1]));
				circle.setAttribute("r", String(7 / scale));
				circle.setAttribute("fill", colors[type] || colors.via);
				circle.setAttribute("stroke", "#333");
				circle.setAttribute("stroke-width", "2");
				circle.setAttribute("vector-effect", "non-scaling-stroke");
				this._routeSvg.appendChild(circle);
			}
		},

		_pump() {
			const max = L.Browser && L.Browser.mobile ? 4 : 6;
			while (this._inflight < max && this._queue.length) {
				const tile = this._queue.shift();
				if (!tile || tile.removed || tile.loaded || tile.loading) continue;
				this._loadTile(tile);
			}
		},

		_loadTile(tile) {
			tile.loading = true;
			tile.tries++;
			this._inflight++;
			const generation = this._generation;
			const tileBase = options.tileBase
				? options.tileBase(this._frame) : this._frame.tileBase;
			tile.lastTileBase = tileBase;
			if (!tileBase) {
				tile.loading = false;
				tile.failed = true;
				tile.retryAt = Date.now() + Math.min(30000, 1000 * (2 ** tile.tries));
				this._inflight = Math.max(0, this._inflight - 1);
				const retryGeneration = this._generation;
				if (tile.tries < 3) setTimeout(() => {
					if (retryGeneration === this._generation && this._map) this._update();
				}, tile.retryAt - Date.now());
				this._notify(new Error("Vexcel session unavailable"));
				this._pump();
				return;
			}
			const url = tileBase + "&downsample=" + tile.downsample +
				"&tile-x=" + tile.x + "&tile-y=" + tile.y;
			tile.handle = gmGet(url, {
				responseType: "arraybuffer",
				headers: options.headers || {},
			}, (err, response) => {
				tile.handle = null;
				tile.loading = false;
				this._inflight = Math.max(0, this._inflight - 1);
				this._pump();
				if (tile.removed || generation !== this._generation) return;
				if (err || !response || response.status !== 200) {
					tile.failed = true;
					tile.retryAt = Date.now() + Math.min(30000, 1000 * (2 ** tile.tries));
					const retryGeneration = this._generation;
					if (tile.tries < 3) setTimeout(() => {
						if (retryGeneration === this._generation && this._map) this._update();
					}, tile.retryAt - Date.now());
					this._notify(err || new Error("Vexcel HTTP " + (response && response.status)));
					return;
				}
				const blob = new Blob([response.response], { type: "image/jpeg" });
				tile.objectUrl = URL.createObjectURL(blob);
				tile.img.onload = () => {
					if (tile.removed) return;
					tile.loaded = true;
					tile.root.classList.add("dw-vex-warp-tile-loaded");
					tile.img.style.opacity = "1";
					this._notify();
				};
				tile.img.onerror = () => {
					if (tile.removed) return;
						tile.failed = true;
						tile.retryAt = Date.now() + Math.min(30000, 1000 * (2 ** tile.tries));
						if (tile.objectUrl) { URL.revokeObjectURL(tile.objectUrl); tile.objectUrl = null; }
						const retryGeneration = this._generation;
						if (tile.tries < 3) setTimeout(() => {
							if (retryGeneration === this._generation && this._map) this._update();
						}, tile.retryAt - Date.now());
						this._notify(new Error("Vexcel decode failed"));
				};
				tile.img.src = tile.objectUrl;
			});
		},

		_removeTile(key, tile) {
			tile.removed = true;
			if (tile.handle) {
				gmCancel(tile.handle);
				tile.handle = null;
				if (tile.loading) this._inflight = Math.max(0, this._inflight - 1);
			}
			if (tile.objectUrl) URL.revokeObjectURL(tile.objectUrl);
			if (tile.root && tile.root.parentNode) tile.root.parentNode.removeChild(tile.root);
			this._tiles.delete(key);
		},

		_clearTiles() {
			this._queue = [];
			for (const [key, tile] of [...this._tiles]) this._removeTile(key, tile);
			this._inflight = 0;
		},

		_cancelProjectionRequests() {
			for (const handle of [this._centerHandle, this._routeHandle]) {
				if (handle && typeof handle.abort === "function") handle.abort();
				else gmCancel(handle);
			}
			this._centerHandle = null;
			this._routeHandle = null;
		},

		_cancelInteractionRequests() {
			this._interactionQueue = [];
			if (this._interactionHandle && typeof this._interactionHandle.abort === "function") {
				this._interactionHandle.abort();
			}
			this._interactionHandle = null;
			this._pendingRouteDraw = null;
			if (this._drag && this._drag.handle) {
				this._drag.handle.classList.remove("dw-vex-route-handle--dragging");
			}
			this._drag = null;
		},

		_notify(error) {
			let loaded = 0, pending = 0;
			for (const tile of this._tiles.values()) {
				if (tile.loaded) loaded++;
				else if (!tile.failed) pending++;
			}
			if (this._routeSvg) this._routeSvg.classList.toggle("dw-vex-route--exact", this._routeExact);
			if (!options.onStatus) return;
			options.onStatus({
				loaded, pending, error: error || null, frame: this._frame,
				routeExact: this._routeExact, routeError: this._routeError,
			});
		},
	});

	return new PerspectiveLayer();
}
