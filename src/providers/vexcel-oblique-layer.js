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
			map.getContainer().classList.add("dw-vex-perspective-active");
			this._hiddenReferencePanes = [];
			for (const name of ["dwRoadsPane", "dwLabelsPane"]) {
				const pane = map.getPane(name);
				if (!pane) continue;
				this._hiddenReferencePanes.push([pane, pane.style.opacity]);
				pane.style.opacity = "0";
			}
			const overlayPane = map.getPane("overlayPane");
			if (overlayPane && options.getRoutePaths) {
				this._routeObserver = new MutationObserver(() => {
					clearTimeout(this._routeTimer);
					this._routeTimer = setTimeout(() => this._requestRoute(), 400);
				});
				this._routeObserver.observe(overlayPane, {
					subtree: true, childList: true, attributes: true,
					attributeFilter: ["d", "transform"],
				});
			}
			this._update();
			this._requestRoute();
		},

		onRemove() {
			this._generation++;
			this._cancelProjectionRequests();
			this._clearTiles();
			clearTimeout(this._routeTimer);
			if (this._routeObserver) { this._routeObserver.disconnect(); this._routeObserver = null; }
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
		},

		getEvents() {
			return {
				moveend: this._update,
				zoomend: this._update,
				viewreset: this._update,
				resize: this._update,
			};
		},

		setFrame(frame) {
			if (!frame || !frame.name || !frame.tileBase || !frame.corners ||
				frame.corners.length !== 4) return false;
			if (this._frame && this._frame.name === frame.name &&
				this._frame.tileBase === frame.tileBase) return true;
			this._generation++;
			this._cancelProjectionRequests();
			this._clearTiles();
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
			this._frame = null;
			this._nativeScale = 0;
			this._centerPixel = null;
			this._centerPixelKey = "";
			this._centerRequestKey = "";
			this._cancelProjectionRequests();
			this._clearTiles();
			if (this._routeSvg) this._routeSvg.replaceChildren();
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
			return { scale, left, top };
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
			if (!this._map || !this._frame || !this._routeSvg || !options.getRoutePaths) return;
			this._routeGeneration++;
			if (this._routeHandle && typeof this._routeHandle.abort === "function") {
				this._routeHandle.abort();
			}
			this._routeHandle = null;
			const paths = options.getRoutePaths()
				.flatMap((path) => _vexcelClipPathToQuad(path, this._frame.corners));
			if (!paths.length) {
				this._routeExact = true;
				this._drawRoute([]);
				this._notify();
				return;
			}
			const flat = [], indices = [];
			const projected = paths.map((path) => path.map(() => null));
			for (let pathIdx = 0; pathIdx < paths.length; pathIdx++) {
				for (let pointIdx = 0; pointIdx < paths[pathIdx].length; pointIdx++) {
					const [lng, lat] = paths[pathIdx][pointIdx];
					const uv = _vexcelInvBilinear(this._frame.corners, lng, lat);
					projected[pathIdx][pointIdx] = [uv[0] * this._frame.w, uv[1] * this._frame.h];
					flat.push([lng, lat]);
					indices.push([pathIdx, pointIdx]);
				}
			}
			this._drawRoute(projected);
			if (!flat.length) {
				this._routeExact = true;
				this._notify();
				return;
			}
			if (!options.transformPoints) {
				this._routeError = true;
				this._notify();
				return;
			}
			const generation = this._generation, routeGeneration = this._routeGeneration;
			const frame = this._frame;
			this._routeExact = false;
			this._routeError = false;
			let handle = null;
			handle = options.transformPoints(frame, flat, "world-2-pixel", (pixels) => {
				if (generation !== this._generation || routeGeneration !== this._routeGeneration ||
					frame !== this._frame) return;
				if (!pixels || pixels.length !== flat.length) {
					this._routeError = true;
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
					const [pathIdx, pointIdx] = indices[i];
					projected[pathIdx][pointIdx] = pixel;
				}
				this._routeExact = complete;
				this._routeError = !this._routeExact;
				this._drawRoute(projected);
				this._notify();
				if (this._routeHandle === handle) this._routeHandle = null;
			});
			this._routeHandle = handle && !handle.completed ? handle : null;
		},

		_drawRoute(paths) {
			if (!this._routeSvg || !this._frame) return;
			this._routeSvg.replaceChildren();
			for (const points of paths) {
				let segment = [];
				const flush = () => {
					if (segment.length < 2) { segment = []; return; }
					const d = segment.map((p, i) => (i ? "L" : "M") + p[0] + " " + p[1]).join(" ");
					for (const [color, width] of [["#fff", 7], ["#ef2929", 4]]) {
						const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
						path.setAttribute("d", d);
						path.setAttribute("fill", "none");
						path.setAttribute("stroke", color);
						path.setAttribute("stroke-width", String(width));
						path.setAttribute("stroke-linecap", "round");
						path.setAttribute("stroke-linejoin", "round");
						path.setAttribute("vector-effect", "non-scaling-stroke");
						this._routeSvg.appendChild(path);
					}
					segment = [];
				};
				for (const point of points) {
					if (!point || !isFinite(point[0]) || !isFinite(point[1]) ||
						point[0] < 0 || point[1] < 0 ||
						point[0] > this._frame.w || point[1] > this._frame.h) {
						flush(); continue;
					}
					segment.push(point);
				}
				flush();
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
