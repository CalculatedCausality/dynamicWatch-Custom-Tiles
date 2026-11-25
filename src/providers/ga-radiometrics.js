import { CFG } from "../config.js";
import { LayerProvider } from "../layers/provider-factories.js";
import { esc } from "../utils/html.js";
import { gmJsonGet } from "../utils/http.js";
import { tileToBBox3857 } from "../utils/tile-geometry.js";

/* -- Natural Radiation (Australia) ------------------------------------------
 * Geoscience Australia's Radiometric Grid of Australia (Radmap) v4 2019,
 * filtered terrestrial dose rate: natural gamma radiation from the ground,
 * in nanograys per hour, merged from over 600 airborne surveys at about
 * 100 m. Served by GA's National Geophysical Grids WMS (CC BY 4.0, CORS
 * open). Drawn in GA's own colour stretch: purple low, cyan, yellow, red
 * high. The hover reads the value under the pointer with GetFeatureInfo.
 * Safecast's map shows the 2010 edition of the same survey.
 */

const LAYER = "geophys:radmap_v4_2019_filtered_dose";
// "image/png8" is the service's compact form: about a quarter the size.
const COMMON = `SERVICE=WMS&VERSION=1.3.0&LAYERS=${encodeURIComponent(LAYER)}&STYLES=&CRS=EPSG:3857`;

export function gaDoseTileUrl(z, x, y) {
	const b = tileToBBox3857(z, x, y);
	return `${CFG.GA_GEOPHYS_WMS}?${COMMON}&REQUEST=GetMap&BBOX=${b.west},${b.south},${b.east},${b.north}` +
		`&WIDTH=256&HEIGHT=256&FORMAT=image%2Fpng8&TRANSPARENT=true`;
}

// GetFeatureInfo for one Web Mercator point: a 3 x 3 pixel window around it.
export function gaDoseInfoUrl(x, y, metresPerPixel) {
	const h = metresPerPixel * 1.5;
	return `${CFG.GA_GEOPHYS_WMS}?${COMMON}&REQUEST=GetFeatureInfo&QUERY_LAYERS=${encodeURIComponent(LAYER)}` +
		`&BBOX=${x - h},${y - h},${x + h},${y + h}&WIDTH=3&HEIGHT=3&I=1&J=1&INFO_FORMAT=application%2Fjson`;
}

// The dose rate (nGy/h) in a GetFeatureInfo answer; null where there is no
// survey (offshore, gaps) or the grid holds a filter artefact below zero.
export function gaDoseValue(data) {
	const f = data && Array.isArray(data.features) ? data.features[0] : null;
	const v = f && f.properties ? Number(f.properties.GRAY_INDEX) : NaN;
	return Number.isFinite(v) && v >= 0 && v < 100000 ? v : null;
}

// UNSCEAR's world average outdoor dose rate from the ground, nGy/h.
const WORLD_AVG = 59;

export function _formatDose(value) {
	if (value == null) return "";
	const v = value < 10 ? value.toFixed(1) : String(Math.round(value));
	const ratio = value / WORLD_AVG;
	const compare = ratio < 0.67 ? "below the world average outdoors"
		: ratio <= 1.5 ? "about the world average outdoors"
		: ratio <= 3 ? "above the world average outdoors"
		: "well above the world average outdoors (often granite or mineral sands)";
	return esc`<b>Natural radiation ${v} nGy/h</b><br>${compare} (${WORLD_AVG} nGy/h)` +
		`<br><span class="dw-cad-sub">Gamma from the ground, Geoscience Australia 2019 airborne survey</span>`;
}

// Value at a point, for the hover and the location pop-up.
export function fetchGaDose(map, latlng, cb) {
	const p = L.CRS.EPSG3857.project(latlng);
	const mpp = (2 * Math.PI * 6378137) / (256 * Math.pow(2, map.getZoom()));
	return gmJsonGet(gaDoseInfoUrl(p.x, p.y, mpp), { timeout: 15000 }, (err, data) => cb(err ? null : gaDoseValue(data)));
}

export function gaDoseIdentify(map, latlng, cb) {
	fetchGaDose(map, latlng, (v) => cb(v == null ? "" :
		`<div class="dw-mine-hd">Natural radiation here</div><div class="dw-mine-list"><div class="dw-mine-row">${_formatDose(v)}</div></div>`));
}

export class GaRadiometricsLayerProvider extends LayerProvider {
	create() {
		const Grid = L.TileLayer.extend({
			getTileUrl(coords) { return gaDoseTileUrl(this._getZoomForUrl(), coords.x, coords.y); },
			onAdd(map) {
				L.TileLayer.prototype.onAdd.call(this, map);
				const noHover = L.Browser.mobile || (window.matchMedia && window.matchMedia("(hover: none)").matches);
				if (noHover) return;
				const tip = L.tooltip({ sticky: true, opacity: 0.95, className: "dw-qpws-tip", direction: "right", offset: [12, 0] });
				let timer = null, gen = 0;
				this._dwMove = (e) => {
					clearTimeout(timer);
					const ll = e.latlng, my = ++gen;
					timer = setTimeout(() => fetchGaDose(map, ll, (v) => {
						if (my !== gen || !this._map) return;
						if (v == null) { if (tip._map) tip.remove(); return; }
						tip.setLatLng(ll).setContent(_formatDose(v));
						if (!tip._map) tip.addTo(map);
					}), 300);
				};
				this._dwOut = () => { clearTimeout(timer); gen++; if (tip._map) tip.remove(); };
				map.on("mousemove", this._dwMove);
				map.on("mouseout", this._dwOut);
			},
			onRemove(map) {
				if (this._dwMove) { this._dwOut(); map.off("mousemove", this._dwMove); map.off("mouseout", this._dwOut); }
				this._dwMove = this._dwOut = null;
				L.TileLayer.prototype.onRemove.call(this, map);
			},
		});
		const layer = new Grid("", {
			tileSize: 256, minZoom: 3, maxNativeZoom: 13, maxZoom: 25, opacity: 0.6, crossOrigin: true,
			bounds: L.latLngBounds([-44.5, 112], [-9, 154.5]),
			attribution: 'Radiometrics &copy; <a href="https://www.ga.gov.au/" target="_blank" rel="noreferrer">Geoscience Australia</a> (CC BY 4.0)',
		});
		layer._dwMb3DUrl = `${CFG.GA_GEOPHYS_WMS}?${COMMON}&REQUEST=GetMap&BBOX={bbox-epsg-3857}` +
			`&WIDTH=256&HEIGHT=256&FORMAT=image%2Fpng8&TRANSPARENT=true`;
		return layer;
	}
}
