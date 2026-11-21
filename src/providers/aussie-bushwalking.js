import { CFG } from "../config.js";
import { LayerProvider } from "../layers/provider-factories.js";
import { makeVectorTileLayer } from "../layers/vector-tile-layer.js";
import { esc } from "../utils/html.js";

/* -- Aussie Bushwalking walks ---------------------------------------------
 * The walks in view, from the same vector tiles aussiebushwalking.com's own
 * walk map loads: a line per recorded track and a pin per walk, each linking
 * back to the walk's page. Layer "abwTracks" holds the lines and "abw" the
 * walk points (with region and description).
 */

// The site's own difficulty colours.
const DIFFICULTY_COLORS = {
	"Very Easy": "#1e4f9c", Easy: "#ac1c64", Medium: "#f0a830", Hard: "#e12e2a", "Very Hard": "#231f20",
};

export function abwDifficultyColor(difficulty) {
	return DIFFICULTY_COLORS[difficulty] || "#6b7280";
}

// Walk pages are site-relative paths; anything else is dropped.
export function abwWalkUrl(path) {
	const p = String(path || "");
	return /^\/[A-Za-z0-9][A-Za-z0-9/_\-.%]*$/.test(p) ? CFG.ABW_ORIGIN + p : "";
}

const clean = (value, max) => String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, max);

// "5.3km return · Medium · 90 mins"
export function abwSummary(props) {
	return [clean(props.Distance, 40), clean(props.Difficulty, 20), clean(props.Duration, 30)].filter(Boolean).join(" · ");
}

export function abwPopupHtml(props) {
	const url = abwWalkUrl(props.Url);
	const summary = abwSummary(props);
	const region = clean(props.Region, 120);
	let description = clean(props.Description, 400);
	if (description.length === 400) description = description.slice(0, 397) + "…";
	return `<div class="dw-abw-pop">` +
		esc`<b>${clean(props.Name, 120) || "Walk"}</b>` +
		(summary ? esc`<div>${summary}</div>` : "") +
		(region ? esc`<div class="dw-abw-sub">${region}</div>` : "") +
		(description ? esc`<div class="dw-abw-desc">${description}</div>` : "") +
		(url ? esc`<div><a href="${url}" target="_blank" rel="noopener noreferrer">Open on Aussie Bushwalking ↗</a></div>` : "") +
		`</div>`;
}

// Tile features → the elements the shared vector-tile layer draws. Ids keep
// a walk's pin from being drawn once per tile; a track clipped by tile edges
// arrives as one piece per tile and all pieces are kept.
export function abwToElements(layerName, props, geometryType, rings) {
	if (props.Id == null) return null;
	if (layerName === "abwTracks" && geometryType === 2) {
		return rings.filter((ring) => ring.length > 1).map((ring) => ({ type: "way", geometry: ring, tags: props }));
	}
	if (layerName === "abw" && geometryType === 1 && rings[0] && rings[0][0]) {
		const p = rings[0][0];
		return [{ type: "node", lat: p.lat, lon: p.lon, tags: props, _id: "abw" + props.Id }];
	}
	return null;
}

export class AussieBushwalkingLayerProvider extends LayerProvider {
	create() {
		const pin = (color) => L.divIcon({
			className: "dw-abw-icon",
			html: `<span class="dw-abw-pin" style="background:${color}"></span>`,
			iconSize: [14, 14], iconAnchor: [7, 7], popupAnchor: [0, -7], tooltipAnchor: [0, -7],
		});
		return makeVectorTileLayer({
			label:         "AussieBushwalking",
			pane:          "dwAbwPane",
			paneZIndex:    415,
			minZoom:       CFG.ABW_MIN_ZOOM,
			padBounds:     0.1,
			maxNativeZoom: CFG.ABW_MAX_NATIVE_Z,
			attribution:   'Walks © <a href="https://www.aussiebushwalking.com/" target="_blank" rel="noreferrer">Aussie Bushwalking</a> contributors',
			tileUrl: (z, x, y) => `${CFG.ABW_TILES}/${z}/${x}/${y}`,
			// Tiles with no walks come back as 404.
			missingIsEmpty: true,
			toElements: abwToElements,
			render: (group, elements) => {
				// Tracks first so the walk pins sit on top of them.
				for (const el of elements) {
					if (el.type !== "way") continue;
					const color = abwDifficultyColor(el.tags.Difficulty);
					const latlngs = el.geometry.map((g) => [g.lat, g.lon]);
					// A white casing keeps the line readable on imagery.
					L.polyline(latlngs, { pane: "dwAbwPane", color: "#fff", weight: 6, opacity: 0.85, interactive: false })
						.addTo(group);
					L.polyline(latlngs, { pane: "dwAbwPane", color, weight: 3, opacity: 0.95 })
						.bindTooltip(esc`<b>${el.tags.Name || "Walk"}</b><br>${abwSummary(el.tags)}`,
							{ className: "dw-abw-tip", sticky: true })
						.bindPopup(() => abwPopupHtml(el.tags), { className: "dw-abw-popup", maxWidth: 280, autoPan: false })
						.addTo(group);
				}
				for (const el of elements) {
					if (el.type !== "node") continue;
					const marker = L.marker([el.lat, el.lon], {
						icon: pin(abwDifficultyColor(el.tags.Difficulty)), pane: "dwAbwPane", keyboard: false,
					});
					marker._dwData = {
						name: el.tags.Name || "Walk", label: "", url: abwWalkUrl(el.tags.Url),
						color: abwDifficultyColor(el.tags.Difficulty), radius: 6,
					};
					marker
						.bindTooltip(esc`<b>${el.tags.Name || "Walk"}</b><br>${abwSummary(el.tags)}`,
							{ className: "dw-abw-tip", direction: "top" })
						.bindPopup(() => abwPopupHtml(el.tags), { className: "dw-abw-popup", maxWidth: 280, autoPan: false })
						.addTo(group);
				}
			},
		});
	}
}
