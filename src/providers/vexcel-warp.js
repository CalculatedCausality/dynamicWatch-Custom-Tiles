import { gmCancel, gmGet } from "../utils/http.js";

const TILE_SIZE = 256;
const MESH_DIVISIONS = 2;
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

function _convexQuad(quad) {
	let sign = 0;
	for (let i = 0; i < 4; i++) {
		const a = quad[i], b = quad[(i + 1) % 4], c = quad[(i + 2) % 4];
		const cross = (b[0] - a[0]) * (c[1] - b[1]) -
			(b[1] - a[1]) * (c[0] - b[0]);
		if (Math.abs(cross) < 1e-9) return false;
		const next = Math.sign(cross);
		if (sign && next !== sign) return false;
		sign = next;
	}
	return true;
}

// Homography from (0,0), (width,0), (width,height), (0,height) to quad.
// The returned row-major matrix maps source pixels to Leaflet layer points.
export function _vexcelRectToQuad(width, height, quad) {
	if (!(width > 0 && height > 0) || !Array.isArray(quad) || quad.length !== 4 ||
		quad.some((p) => !p || !isFinite(p[0]) || !isFinite(p[1])) ||
		!_convexQuad(quad)) return null;

	const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = quad;
	const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
	const dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
	const den = dx1 * dy2 - dx2 * dy1;
	const scale = Math.max(1, Math.hypot(dx1, dy1), Math.hypot(dx2, dy2));
	if (Math.abs(den) <= 1e-12 * scale * scale) return null;

	const gu = (dx3 * dy2 - dx2 * dy3) / den;
	const hu = (dx1 * dy3 - dx3 * dy1) / den;
	const cornerW = [1, 1 + gu, 1 + gu + hu, 1 + hu];
	if (cornerW.some((n) => !isFinite(n) || n <= 1e-10)) return null;

	const matrix = [
		(x1 - x0 + gu * x1) / width,
		(x3 - x0 + hu * x3) / height,
		x0,
		(y1 - y0 + gu * y1) / width,
		(y3 - y0 + hu * y3) / height,
		y0,
		gu / width,
		hu / height,
		1,
	];
	return matrix.every(isFinite) ? matrix : null;
}

export function _vexcelApplyHomography(matrix, x, y) {
	if (!matrix) return null;
	const den = matrix[6] * x + matrix[7] * y + matrix[8];
	if (!isFinite(den) || Math.abs(den) < 1e-12) return null;
	return [
		(matrix[0] * x + matrix[1] * y + matrix[2]) / den,
		(matrix[3] * x + matrix[4] * y + matrix[5]) / den,
	];
}

// Affine transform between two triangles. Adjacent triangles interpolate a
// shared edge identically, avoiding the cracks independent homographies cause.
export function _vexcelTriangleToTriangle(source, target) {
	if (!Array.isArray(source) || !Array.isArray(target) ||
		source.length !== 3 || target.length !== 3) return null;
	const [[x0, y0], [x1, y1], [x2, y2]] = source;
	const [[X0, Y0], [X1, Y1], [X2, Y2]] = target;
	const det = x0 * (y1 - y2) + x1 * (y2 - y0) + x2 * (y0 - y1);
	if (!isFinite(det) || Math.abs(det) < 1e-12) return null;
	const matrix = [
		(X0 * (y1 - y2) + X1 * (y2 - y0) + X2 * (y0 - y1)) / det,
		(Y0 * (y1 - y2) + Y1 * (y2 - y0) + Y2 * (y0 - y1)) / det,
		(X0 * (x2 - x1) + X1 * (x0 - x2) + X2 * (x1 - x0)) / det,
		(Y0 * (x2 - x1) + Y1 * (x0 - x2) + Y2 * (x1 - x0)) / det,
		(X0 * (x1 * y2 - x2 * y1) + X1 * (x2 * y0 - x0 * y2) +
			X2 * (x0 * y1 - x1 * y0)) / det,
		(Y0 * (x1 * y2 - x2 * y1) + Y1 * (x2 * y0 - x0 * y2) +
			Y2 * (x0 * y1 - x1 * y0)) / det,
	];
	return matrix.every(isFinite) ? matrix : null;
}

export function _vexcelApplyAffine(matrix, x, y) {
	return matrix ? [
		matrix[0] * x + matrix[2] * y + matrix[4],
		matrix[1] * x + matrix[3] * y + matrix[5],
	] : null;
}

function _pointKey(x, y) {
	return Number(x).toFixed(3) + "," + Number(y).toFixed(3);
}

function _bbox(quad) {
	return {
		minX: Math.min(...quad.map((p) => p[0])),
		minY: Math.min(...quad.map((p) => p[1])),
		maxX: Math.max(...quad.map((p) => p[0])),
		maxY: Math.max(...quad.map((p) => p[1])),
	};
}

function _intersects(a, b) {
	return a.maxX >= b.minX && a.minX <= b.maxX &&
		a.maxY >= b.minY && a.minY <= b.maxY;
}

export function createVexcelWarpedLayer(options) {
	options = options || {};
	const WarpedLayer = L.Layer.extend({
		initialize() {
			this._frame = null;
			this._tiles = new Map();
			this._queue = [];
			this._inflight = 0;
			this._generation = 0;
			this._worldPoints = new Map();
			this._pendingPoints = new Set();
			this._transformRetryAt = 0;
			this._transformError = false;
			this._transformHandles = new Set();
		},

		onAdd(map) {
			if (!map.getPane(WARP_PANE)) {
				const pane = map.createPane(WARP_PANE);
				pane.style.zIndex = "220";
				pane.style.pointerEvents = "none";
			}
			this._container = L.DomUtil.create(
				"div", "leaflet-layer leaflet-zoom-hide dw-vex-warp",
				map.getPane(WARP_PANE));
			this._container.style.pointerEvents = "none";
			this._update();
		},

		onRemove() {
			this._generation++;
			this._cancelTransforms();
			this._clearTiles();
			if (this._container && this._container.parentNode) {
				this._container.parentNode.removeChild(this._container);
			}
			this._container = null;
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
			this._cancelTransforms();
			this._clearTiles();
			this._worldPoints.clear();
			this._pendingPoints.clear();
			this._transformRetryAt = 0;
			this._transformError = false;
			this._frame = Object.assign({}, frame, {
				w: Number(frame.w) || 10560,
				h: Number(frame.h) || 14144,
			});
			if (this._map) this._update();
			return true;
		},

		clearFrame() {
			this._generation++;
			this._frame = null;
			this._worldPoints.clear();
			this._pendingPoints.clear();
			this._cancelTransforms();
			this._clearTiles();
		},

		getFrame() { return this._frame; },
		getLoadedTileCount() {
			let count = 0;
			for (const tile of this._tiles.values()) if (tile.loaded) count++;
			return count;
		},
		refresh() { if (this._map) this._update(); },

		_fallbackWorld(x, y) {
			const frame = this._frame;
			return _vexcelBilinear(frame.corners, x / frame.w, y / frame.h);
		},

		_worldPoint(x, y) {
			return this._worldPoints.get(_pointKey(x, y)) || this._fallbackWorld(x, y);
		},

		_layerPoint(x, y) {
			const world = this._worldPoint(x, y);
			const projected = this._map.project([world[1], world[0]], this._map.getZoom());
			const origin = this._map.getPixelOrigin();
			return [projected.x - origin.x, projected.y - origin.y];
		},

		_tileQuad(tile) {
			return [
				this._layerPoint(tile.x0, tile.y0),
				this._layerPoint(tile.x1, tile.y0),
				this._layerPoint(tile.x1, tile.y1),
				this._layerPoint(tile.x0, tile.y1),
			];
		},

		_visibleTiles(downsample) {
			const frame = this._frame;
			const scale = 2 ** downsample;
			const cols = Math.ceil(frame.w / (TILE_SIZE * scale));
			const rows = Math.ceil(frame.h / (TILE_SIZE * scale));
			const topLeft = this._map.containerPointToLayerPoint([-160, -160]);
			const size = this._map.getSize();
			const bottomRight = this._map.containerPointToLayerPoint([size.x + 160, size.y + 160]);
			const viewport = {
				minX: Math.min(topLeft.x, bottomRight.x),
				minY: Math.min(topLeft.y, bottomRight.y),
				maxX: Math.max(topLeft.x, bottomRight.x),
				maxY: Math.max(topLeft.y, bottomRight.y),
			};
			const centerX = (viewport.minX + viewport.maxX) / 2;
			const centerY = (viewport.minY + viewport.maxY) / 2;
			const tiles = [];
			for (let y = 0; y < rows; y++) {
				for (let x = 0; x < cols; x++) {
					const x0 = x * TILE_SIZE * scale;
					const y0 = y * TILE_SIZE * scale;
					const x1 = Math.min(frame.w, (x + 1) * TILE_SIZE * scale);
					const y1 = Math.min(frame.h, (y + 1) * TILE_SIZE * scale);
					const tile = { x, y, x0, y0, x1, y1, downsample, scale };
					const box = _bbox(this._tileQuad(tile));
					if (!_intersects(box, viewport)) continue;
					const dx = (box.minX + box.maxX) / 2 - centerX;
					const dy = (box.minY + box.maxY) / 2 - centerY;
					tile.distance = dx * dx + dy * dy;
					tiles.push(tile);
				}
			}
			return tiles.sort((a, b) => a.distance - b.distance);
		},

		_chooseTiles() {
			const frame = this._frame;
			const fullQuad = [
				this._layerPoint(0, 0), this._layerPoint(frame.w, 0),
				this._layerPoint(frame.w, frame.h), this._layerPoint(0, frame.h),
			];
			const top = Math.hypot(fullQuad[1][0] - fullQuad[0][0], fullQuad[1][1] - fullQuad[0][1]);
			const bottom = Math.hypot(fullQuad[2][0] - fullQuad[3][0], fullQuad[2][1] - fullQuad[3][1]);
			const left = Math.hypot(fullQuad[3][0] - fullQuad[0][0], fullQuad[3][1] - fullQuad[0][1]);
			const right = Math.hypot(fullQuad[2][0] - fullQuad[1][0], fullQuad[2][1] - fullQuad[1][1]);
			const displayW = Math.max(1, top, bottom);
			const displayH = Math.max(1, left, right);
			const nativePerCss = Math.min(frame.w / displayW, frame.h / displayH);
			const dpr = Math.max(1, Number(globalThis.devicePixelRatio) || 1);
			const maxDownsample = Math.min(3, _vexcelMaxDownsample(frame.w, frame.h));
			let downsample = Math.max(0, Math.min(maxDownsample,
				Math.floor(Math.log2(Math.max(1, nativePerCss / dpr)))));
			let tiles = this._visibleTiles(downsample);
			const budget = L.Browser && L.Browser.mobile ? 48 : 96;
			while (tiles.length > budget && downsample < maxDownsample) {
				tiles = this._visibleTiles(++downsample);
			}
			return tiles.slice(0, budget);
		},

		_update() {
			if (!this._map || !this._container || !this._frame) return;
			const required = new Set();
			const tiles = this._chooseTiles();
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
				this._positionTile(record);
			}
			this._requestExactPoints();
			this._pump();
			this._notify();
		},

		_createTile(key, tile) {
			const root = document.createElement("div");
			root.className = "dw-vex-warp-tile";
			root.dataset.tile = key;
			root.dataset.imageName = this._frame.name;
			root.style.cssText = "position:absolute;left:0;top:0;width:0;height:0;pointer-events:none";
			this._container.appendChild(root);

			const tileW = (tile.x1 - tile.x0) / tile.scale;
			const tileH = (tile.y1 - tile.y0) / tile.scale;
			const cells = [];
			for (let cy = 0; cy < MESH_DIVISIONS; cy++) {
				for (let cx = 0; cx < MESH_DIVISIONS; cx++) {
					const sx0 = tileW * cx / MESH_DIVISIONS;
					const sy0 = tileH * cy / MESH_DIVISIONS;
					const sx1 = tileW * (cx + 1) / MESH_DIVISIONS;
					const sy1 = tileH * (cy + 1) / MESH_DIVISIONS;
					for (const source of [
						[[sx0, sy0], [sx1, sy0], [sx1, sy1]],
						[[sx0, sy0], [sx1, sy1], [sx0, sy1]],
					]) {
						const el = document.createElement("div");
						el.className = "dw-vex-warp-cell";
						el.style.cssText = "position:absolute;left:0;top:0;overflow:hidden;" +
							"transform-origin:0 0;pointer-events:none;opacity:0";
						el.style.width = tileW + "px";
						el.style.height = tileH + "px";
						el.style.clipPath = "polygon(" + source
							.map((p) => p[0] + "px " + p[1] + "px").join(",") + ")";
						const img = document.createElement("img");
						img.alt = "";
						img.setAttribute("role", "presentation");
						img.style.cssText = "position:absolute;left:0;top:0;max-width:none;" +
							"width:256px;height:256px";
						el.appendChild(img);
						root.appendChild(el);
						cells.push({ el, img, source });
					}
				}
			}
			return Object.assign({
				key, root, cells, loaded: false, removed: false, tries: 0, retryAt: 0,
			}, tile);
		},

		_positionTile(tile) {
			for (const cell of tile.cells) {
				const target = cell.source.map((p) => this._layerPoint(
					tile.x0 + p[0] * tile.scale,
					tile.y0 + p[1] * tile.scale));
				const matrix = _vexcelTriangleToTriangle(cell.source, target);
				cell.el.style.display = matrix ? "" : "none";
				if (matrix) cell.el.style.transform = `matrix(${matrix.join(",")})`;
			}
		},

		_requestExactPoints() {
			if (!options.transformPoints || Date.now() < this._transformRetryAt) return;
			const points = [], keys = [];
			for (const tile of this._tiles.values()) {
				for (const cell of tile.cells) {
					for (const [sx, sy] of cell.source) {
						const x = tile.x0 + sx * tile.scale;
						const y = tile.y0 + sy * tile.scale;
						const key = _pointKey(x, y);
						if (this._worldPoints.has(key) || this._pendingPoints.has(key)) continue;
						this._pendingPoints.add(key);
						keys.push(key); points.push([x, y]);
					}
				}
			}
			if (!points.length) return;
			const generation = this._generation;
			const frame = this._frame;
			let handle = null;
			handle = options.transformPoints(frame, points, (worldPoints) => {
				if (handle) this._transformHandles.delete(handle);
				if (generation !== this._generation || frame !== this._frame) return;
				for (const key of keys) this._pendingPoints.delete(key);
				if (!worldPoints || worldPoints.length !== points.length) {
					this._transformRetryAt = Date.now() + 30000;
					this._transformError = true;
					const retryGeneration = this._generation;
					setTimeout(() => {
						if (retryGeneration === this._generation && this._map) this._update();
					}, 30000);
					this._notify();
					return;
				}
				let complete = true;
				for (let i = 0; i < keys.length; i++) {
					const p = worldPoints[i];
					if (p && isFinite(p[0]) && isFinite(p[1])) this._worldPoints.set(keys[i], p);
					else complete = false;
				}
				this._transformError = !complete;
				if (!complete) {
					this._transformRetryAt = Date.now() + 30000;
					const retryGeneration = this._generation;
					setTimeout(() => {
						if (retryGeneration === this._generation && this._map) this._update();
					}, 30000);
				}
				this._update();
			});
			if (handle && !handle.completed) this._transformHandles.add(handle);
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
				let remaining = tile.cells.length, failed = false;
				const settled = () => {
					if (--remaining > 0 || tile.removed) return;
					if (failed) {
						tile.failed = true;
						tile.retryAt = Date.now() + Math.min(30000, 1000 * (2 ** tile.tries));
						if (tile.objectUrl) { URL.revokeObjectURL(tile.objectUrl); tile.objectUrl = null; }
						const retryGeneration = this._generation;
						if (tile.tries < 3) setTimeout(() => {
							if (retryGeneration === this._generation && this._map) this._update();
						}, tile.retryAt - Date.now());
						this._notify(new Error("Vexcel decode failed"));
						return;
					}
					tile.loaded = true;
					tile.root.classList.add("dw-vex-warp-tile-loaded");
					for (const cell of tile.cells) cell.el.style.opacity = "1";
					this._notify();
				};
				for (const cell of tile.cells) {
					cell.img.onload = settled;
					cell.img.onerror = () => { failed = true; settled(); };
					cell.img.src = tile.objectUrl;
				}
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

		_cancelTransforms() {
			for (const handle of this._transformHandles) {
				if (handle && typeof handle.abort === "function") handle.abort();
				else gmCancel(handle);
			}
			this._transformHandles.clear();
		},

		_exactReady() {
			if (!this._tiles.size) return false;
			for (const tile of this._tiles.values()) {
				for (const cell of tile.cells) {
					for (const [sx, sy] of cell.source) {
						const x = tile.x0 + sx * tile.scale;
						const y = tile.y0 + sy * tile.scale;
						if (!this._worldPoints.has(_pointKey(x, y))) return false;
					}
				}
			}
			return true;
		},

		_notify(error) {
			let loaded = 0, pending = 0;
			for (const tile of this._tiles.values()) {
				if (tile.loaded) loaded++;
				else if (!tile.failed) pending++;
			}
			const exactReady = this._exactReady();
			if (this._container) this._container.classList.toggle("dw-vex-warp--exact", exactReady);
			if (!options.onStatus) return;
			options.onStatus({
				loaded, pending, error: error || null, frame: this._frame,
				exactReady, transformError: this._transformError,
			});
		},
	});

	return new WarpedLayer();
}
