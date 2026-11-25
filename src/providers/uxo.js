import { CFG } from "../config.js";
import { LayerProvider } from "../layers/provider-factories.js";
import { makeVectorTileLayer } from "../layers/vector-tile-layer.js";
import { hoverSlot } from "../ui/hover-stack.js";
import { _escHtml, esc } from "../utils/html.js";
import { gmGet } from "../utils/http.js";
import { pointInRing } from "../utils/intvl.js";
import { pmDecompress, pmtilesReader } from "../utils/pmtiles.js";

/* -- Unexploded Ordnance (Defence) ------------------------------------------
 * The Department of Defence's record of land and sea that may hold
 * unexploded ordnance from past military use, plus Defence controlled
 * areas, read from the one PMTiles file behind Defence's UXO Mapping
 * Application (served from its contractor's host, read with HTTP Range
 * requests). The file's very large "parcel" layer is skipped.
 * Categories are Defence's own and are not risk ratings.
 * Areas don't take clicks (route points can still be added inside them);
 * the hover finds the areas under the pointer itself.
 */

export const UXO_KINDS = {
	"substantial-potential-uxo": { label: "Substantial UXO potential", color: "#dc2626", order: 1 },
	"slight-potential-uxo": { label: "Slight UXO potential", color: "#ea580c", order: 2 },
	"remote-potential-uxo": { label: "Remote UXO potential", color: "#ca8a04", order: 3 },
	"other-uxo": { label: "Former military training area (UXO category: Other)", color: "#a16207", order: 4 },
	"wwii-depth-charge-operations-uxo": { label: "WWII depth charge operations", color: "#0e7490", order: 5 },
	"sea-dumping-sites-uxo": { label: "Sea dumping site", color: "#2563eb", order: 6 },
	"dca": { label: "Defence controlled area", color: "#166534", order: 7 },
};

// Tile features → polygons to draw ("parcel" and unknown layers skipped).
export function uxoToElements(layerName, props, geometryType, rings) {
	if (geometryType !== 3 || !UXO_KINDS[layerName]) return null;
	const kept = rings.filter((r) => r.length > 2);
	return kept.length ? [{ type: "way", kind: layerName, geometry: kept, tags: props }] : null;
}

export function _formatUxo(kind, p) {
	const k = UXO_KINDS[kind] || { label: "Defence site" };
	const name = String(p.siteName || p.name || "").trim();
	const desc = String(p.siteDescription || "").trim();
	const lines = [esc`<b>${name || k.label}</b>`];
	if (name) lines.push(_escHtml(k.label));
	if (desc) lines.push(esc`<span class="dw-cad-sub">${desc.length > 200 ? desc.slice(0, 199) + "…" : desc}</span>`);
	return lines.join("<br>");
}

// The polygon (rings of {lat, lon}) contains the point: even-odd over all rings.
export function polygonContains(rings, lat, lon) {
	let inside = false;
	for (const ring of rings) if (pointInRing(lon, lat, ring.map((p) => [p.lon, p.lat]))) inside = !inside;
	return inside;
}

let reader = null;
function uxoReader() {
	if (!reader) {
		reader = pmtilesReader({
			fetchRange: (offset, length, cb) => gmGet(CFG.UXO_PMTILES, {
				responseType: "arraybuffer", timeout: 30000,
				headers: { Range: `bytes=${offset}-${offset + length - 1}` },
			}, (err, r) => {
				if (err || !r || (r.status !== 206 && r.status !== 200) || !r.response) cb(err || new Error("http " + (r && r.status)));
				else cb(null, r.response);
			}),
			decompress: pmDecompress,
		});
	}
	return reader;
}

export class UxoLayerProvider extends LayerProvider {
	create() {
		// Each map square repeats a strip of its neighbours' shapes, so the
		// shapes are drawn solid and each pane is faded as a whole: overlaps
		// then don't show as darker bands. Controlled areas get a fainter pane.
		const PANE = "dwUxoPane", DCA_PANE = "dwUxoDcaPane";
		let shapes = [];
		const tip = hoverSlot({ className: "dw-qpws-tip", order: 20 });
		let onMove = null, onOut = null;
		const layer = makeVectorTileLayer({
			label: "UXO",
			pane: PANE,
			paneZIndex: 386,
			minZoom: CFG.UXO_MIN_ZOOM,
			// The file's tiles hold every parcel too, so fetch one fixed zoom.
			maxNativeZoom: 11,
			maxTiles: 24,
			attribution: 'UXO areas &copy; <a href="https://www.defence.gov.au/about/locations-property/unexploded-ordnance-australia" target="_blank" rel="noreferrer">Department of Defence</a>',
			fetchTile: (z, x, y, cb) => {
				let cancelled = false;
				uxoReader().tile(z, x, y).then(
					(buf) => { if (!cancelled) cb(null, buf ? { status: 200, response: buf } : { status: 204, response: null }); },
					(e) => { if (!cancelled) cb(e, null); });
				return { aborted: false, _xhr: { abort() { cancelled = true; } } };
			},
			missingIsEmpty: true,
			toElements: uxoToElements,
			onAdd: (_l, map) => {
				if (!map.getPane(DCA_PANE)) { const p = map.createPane(DCA_PANE); p.style.zIndex = "385"; p.style.opacity = "0.15"; }
				map.getPane(PANE).style.opacity = "0.35";
				onMove = (e) => {
					const { lat, lng } = e.latlng;
					const hits = shapes.filter((s) => polygonContains(s.geometry, lat, lng))
						.sort((a, b) => UXO_KINDS[a.kind].order - UXO_KINDS[b.kind].order);
					const seen = new Set(), html = [];
					for (const s of hits) {
						const h = _formatUxo(s.kind, s.tags);
						if (!seen.has(h)) { seen.add(h); html.push(h); }
					}
					if (!html.length) { tip.remove(); return; }
					tip.setLatLng(e.latlng).setContent(html.join('<div class="dw-hover-sep"></div>'));
					if (!tip._map) tip.addTo(map);
				};
				onOut = () => tip.remove();
				map.on("mousemove", onMove);
				map.on("mouseout", onOut);
			},
			onRemove: (_l, map) => {
				if (onMove) { map.off("mousemove", onMove); map.off("mouseout", onOut); }
				onMove = onOut = null;
				tip.remove();
				shapes = [];
			},
			render: (group, elements) => {
				shapes = elements.filter((e) => e.type === "way");
				// Sea and controlled areas first, so the UXO categories sit on top.
				for (const el of [...shapes].sort((a, b) => UXO_KINDS[b.kind].order - UXO_KINDS[a.kind].order)) {
					const k = UXO_KINDS[el.kind];
					L.polygon(el.geometry.map((r) => r.map((g) => [g.lat, g.lon])), {
						pane: el.kind === "dca" ? DCA_PANE : PANE, interactive: false, stroke: false,
						fillColor: k.color, fillOpacity: 1,
					}).addTo(group);
				}
			},
		});
		return layer;
	}
}
