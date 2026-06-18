import { BLANK_TILE } from "../config.js";
import { tileToBBox4326 } from "../utils/tile-geometry.js";

export class LayerProvider {
	/** @returns {L.Layer} */
	create() {
		throw new Error(`${this.constructor.name}.create() not implemented`);
	}
}

// Pure: where to place an ancestor `depth` levels up so its correct
// sub-quadrant fills one `size`-px tile. Exported for unit tests.
export function _overzoomPlacement(x, y, depth, size) {
	const scale = Math.pow(2, depth);
	const qx = ((x % scale) + scale) % scale;
	const qy = ((y % scale) + scale) % scale;
	return {
		scale,
		imgSize: size * scale,
		offsetX: -(qx * size),
		offsetY: -(qy * size),
	};
}

function _overzoomUrl(layer, x, y, z) {
	const o = layer.options;
	let ty = y;
	if (o.tms) ty = (1 << z) - 1 - y;
	const data = L.Util.extend({
		r: (o.detectRetina && L.Browser.retina && o.maxZoom > 0) ? "@2x" : "",
		s: layer._getSubdomain({ x, y, z }),
		x, y: ty, z,
	}, o);
	return L.Util.template(layer._url, data);
}

export function wireOverzoomFallback(layer, fallbackOpts) {
	fallbackOpts = fallbackOpts || {};
	const minLevel = fallbackOpts.minLevel != null ? fallbackOpts.minLevel : 0;
	layer.createTile = function (coords, done) {
		const size = this.getTileSize();
		const cell = document.createElement("div");
		cell.style.width = size.x + "px";
		cell.style.height = size.y + "px";
		cell.style.overflow = "hidden";
		const img = document.createElement("img");
		img.setAttribute("role", "presentation");
		img.alt = "";
		if (this.options.crossOrigin || this.options.crossOrigin === "") {
			img.crossOrigin =
				this.options.crossOrigin === true ? "" : this.options.crossOrigin;
		}
		cell.appendChild(img);

		let depth = 0;
		const place = () => {
			const p = _overzoomPlacement(coords.x, coords.y, depth, size.x);
			img.style.width  = p.imgSize + "px";
			img.style.height = (size.y * p.scale) + "px";
			img.style.marginLeft = p.offsetX + "px";
			img.style.marginTop  = p.offsetY + "px";
			img.src = _overzoomUrl(
				this, coords.x >> depth, coords.y >> depth, coords.z - depth);
		};
		L.DomEvent.on(img, "load", () => { done(null, cell); });
		L.DomEvent.on(img, "error", () => {
			if (coords.z - depth <= minLevel) { done(null, cell); return; }
			depth += 1;
			place();
		});
		place();
		return cell;
	};
	return layer;
}

export function tileProvider(url, opts = {}) {
	return class extends LayerProvider {
		create() {
			const { overzoom, ...rest } = opts;
			const layer = L.tileLayer(url, {
				tileSize: 256, maxNativeZoom: 18, maxZoom: 25,
				crossOrigin: true, ...rest,
			});
			if (overzoom) wireOverzoomFallback(layer);
			return layer;
		}
	};
}

export function arcgisExportProvider(opts) {
	return class extends LayerProvider {
		create() { return makeArcgisExportTileLayer(opts); }
	};
}

export function tokenTileProvider(buildUrl, opts = {}) {
	return class extends LayerProvider {
		constructor(tokenMgr) { super(); this._token = tokenMgr; }
		create() {
			const tok = this._token;
			const { overzoom, ...rest } = opts;
			const layer = L.tileLayer(
				tok.isValid() ? buildUrl(tok) : BLANK_TILE,
				{ tileSize: 256, maxNativeZoom: 21, maxZoom: 25,
				  crossOrigin: true, ...rest },
			);
			if (overzoom) wireOverzoomFallback(layer);
			if (!tok.isValid()) {
				tok.get(() => {
					if (tok.isValid()) layer.setUrl(buildUrl(tok));
				});
			}
			return layer;
		}
	};
}

export function makeArcgisExportTileLayer(opts) {
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
		maxNativeZoom: opts.maxNativeZoom,
		tileSize,
		pane: opts.pane,
	});
	const showParam = opts.showLayers != null ? `&layers=show:${opts.showLayers}` : "";
	inst._dwMb3DUrl =
		`${opts.baseUrl}/export?bbox={bbox-epsg-3857}` +
		`&bboxSR=3857&imageSR=3857` +
		`&size=${tileSize},${tileSize}` +
		`&format=png32&transparent=true&f=image${showParam}`;
	return inst;
}
