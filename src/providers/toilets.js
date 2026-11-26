import { CFG } from "../config.js";
import { LayerProvider } from "../layers/provider-factories.js";
import { _escHtml, esc } from "../utils/html.js";
import { gmCancel, gmJsonGet } from "../utils/http.js";

/* -- Public Toilets (Australia) ---------------------------------------------
 * The National Public Toilet Map (Department of Health, Disability and
 * Ageing, CC BY 3.0 AU; about 23,600
 * toilets), from its ArcGIS feature service on the NSW data portal.
 * The toilets in view are fetched from zoom 11 each time the map stops
 * moving and kept while the layer is on. Hover gives hours and what's
 * there; a click opens the toilet's page on toiletmap.gov.au.
 */

export const TOILET_FIELDS = ["objectid", "facilityid", "name", "facilitytype", "address1", "town", "openinghours",
	"accessible", "drinkingwater", "shower", "babychange", "parking", "keyrequired", "mlak24", "paymentrequired",
	"dumppoint", "openinghoursnote", "accessnote"];

const yes = (v) => v === true || v === "TRUE" || v === "True" || v === "true" || v === 1;
const clean = (v, max) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);

export function toiletQueryUrl(bounds) {
	const q = new URLSearchParams({
		where: "1=1",
		geometry: [bounds.west, bounds.south, bounds.east, bounds.north].map((v) => v.toFixed(5)).join(","),
		geometryType: "esriGeometryEnvelope", inSR: "4326", outSR: "4326",
		spatialRel: "esriSpatialRelIntersects", outFields: TOILET_FIELDS.join(","),
		returnGeometry: "true", resultRecordCount: "2000", f: "json",
	});
	return CFG.TOILETS_SERVICE + "/query?" + q.toString();
}

// "OPEN: 24 hours" → "Open 24 hours"; "Currently closed" stays.
export function toiletHours(text) {
	const t = clean(text, 160);
	if (!t || /^opening hours unknown$/i.test(t)) return "";
	const m = /^OPEN:\s*(.*)$/i.exec(t);
	return m ? "Open " + m[1].replace(/^Daylight/, "daylight").replace(/^Variable/, "variable").replace(/^Venue/, "venue") : t;
}

export const toiletClosed = (a) => /^currently closed/i.test(clean(a && a.openinghours, 40));

export function toiletFacts(a) {
	return [
		yes(a.accessible) && "accessible", yes(a.drinkingwater) && "drinking water", yes(a.shower) && "shower",
		yes(a.babychange) && "baby change", yes(a.parking) && "parking", yes(a.dumppoint) && "dump point",
		(yes(a.keyrequired) || yes(a.mlak24)) && "key needed", yes(a.paymentrequired) && "pay to use",
	].filter(Boolean);
}

export function toiletPageUrl(id) {
	return /^\d{1,9}$/.test(String(id)) ? `https://toiletmap.gov.au/facility/${id}` : "";
}

export function _formatToilet(attrs, withLink) {
	const a = attrs || {};
	const name = clean(a.name, 120) || "Public toilet";
	const where = [clean(a.facilitytype, 40), clean(a.address1, 80), clean(a.town, 60)].filter((s) => s && s !== "Other").join(" · ");
	const lines = [esc`<b>${name}</b>`];
	if (where) lines.push(_escHtml(where));
	const hours = toiletHours(a.openinghours);
	if (hours) lines.push(_escHtml(hours));
	const facts = toiletFacts(a);
	if (facts.length) lines.push(esc`<span class="dw-cad-sub">${facts.join(" · ")}</span>`);
	const url = withLink && toiletPageUrl(a.facilityid);
	if (url) lines.push(esc`<a href="${url}" target="_blank" rel="noopener noreferrer">Open on the Toilet Map ↗</a>`);
	return lines.join("<br>");
}

export class ToiletsLayerProvider extends LayerProvider {
	create() {
		const PANE = "dwToiletPane";
		const icon = (closed) => L.divIcon({
			className: "dw-wc-icon",
			html: `<span class="dw-wc-pin${closed ? " dw-wc-closed" : ""}">WC</span>`,
			iconSize: [22, 16], iconAnchor: [11, 8], popupAnchor: [0, -8], tooltipAnchor: [0, -8],
		});
		const Layer = L.Layer.extend({
			onAdd(map) {
				if (!map.getPane(PANE)) { map.createPane(PANE); map.getPane(PANE).style.zIndex = "446"; }
				this._group = L.layerGroup().addTo(map);
				this._seen = new Map();
				map.on("moveend", this._update, this);
				this._update();
			},
			onRemove(map) {
				map.off("moveend", this._update, this);
				if (this._busy) { gmCancel(this._busy); this._busy = null; }
				if (this._group) { this._group.remove(); this._group = null; }
				this._seen = null;
			},
			_update() {
				const map = this._map;
				if (!map || !this._group) return;
				if (map.getZoom() < CFG.TOILETS_MIN_ZOOM) return;
				if (this._busy) { gmCancel(this._busy); this._busy = null; }
				const b = map.getBounds().pad(0.15);
				this._busy = gmJsonGet(toiletQueryUrl({ west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() }),
					{ timeout: 30000 }, (err, data) => {
						this._busy = null;
						if (err || !data || !Array.isArray(data.features) || !this._group) return;
						// Keep the layer light: start again past 5,000 pins.
						if (this._seen.size > 5000) { this._group.clearLayers(); this._seen.clear(); }
						for (const f of data.features) {
							const a = f.attributes || {}, g = f.geometry;
							if (!g || !Number.isFinite(g.x) || !Number.isFinite(g.y) || this._seen.has(a.objectid)) continue;
							const m = L.marker([g.y, g.x], { icon: icon(toiletClosed(a)), pane: PANE, keyboard: false })
								.bindTooltip(_formatToilet(a, false), { className: "dw-abw-tip", direction: "top" })
								.bindPopup(() => _formatToilet(a, true), { className: "dw-abw-popup", maxWidth: 280, autoPan: false });
							this._seen.set(a.objectid, m);
							m.addTo(this._group);
						}
					});
			},
			getAttribution() {
				return 'Toilets &copy; <a href="https://toiletmap.gov.au/" target="_blank" rel="noreferrer">National Public Toilet Map</a> (Department of Health, Disability and Ageing, CC BY 3.0 AU)';
			},
		});
		return new Layer();
	}
}
