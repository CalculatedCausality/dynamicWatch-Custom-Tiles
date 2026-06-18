import { CFG } from "../config.js";
import { LayerProvider } from "../layers/provider-factories.js";
import { makeVectorTileLayer } from "../layers/vector-tile-layer.js";
import { esc } from "../utils/html.js";

// Shared SVG circle-with-glyph icon used by Power, Telecoms, and Water.
export function oimIcon(className, glyph, fill, size) {
	size = size || 15;
	return L.divIcon({
		className,
		html: `<svg viewBox="0 0 16 16" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">` +
			  `<circle cx="8" cy="8" r="6.5" fill="${fill}" stroke="#222" stroke-width="1" opacity="0.92"/>` +
			  `<text x="8" y="11.5" text-anchor="middle" font-size="9" font-family="sans-serif" fill="#fff">${glyph}</text>` +
			  `</svg>`,
		iconSize: [size, size], iconAnchor: [size / 2, size / 2],
	});
}

export class PowerInfraLayerProvider extends LayerProvider {
	create() {
		function fmtVoltage(v) {
			const n = parseInt(v, 10) || 0;
			if (!n) return null;
			if (n >= 1000) {
				const kv = n / 1000;
				return (Number.isInteger(kv) ? kv : kv.toFixed(1)) + " kV";
			}
			return n + " V";
		}

		function lineColor(voltageStr) {
			const v = parseInt(voltageStr, 10) || 0;
			if (v >= 300000) return "#D9534F";
			if (v >= 100000) return "#F0A500";
			if (v >=  33000) return "#FFD93D";
			if (v >       0) return "#9CCC65";
			return "#aaa";
		}

		function lineWeight(power, voltageStr) {
			const v = parseInt(voltageStr, 10) || 0;
			if (power === "line") return v >= 300000 ? 3 : v >= 100000 ? 2.5 : 2;
			if (power === "cable") return 1.6;
			return 1.2;
		}

		const pointIcon = (g, f, s) => oimIcon("dw-infra-icon", g, f, s || 16);

		function kvToV(v) {
			const x = parseFloat(v);
			return x ? String(Math.round(x * 1000)) : "";
		}
		function fmtMW(v) {
			const x = parseFloat(v);
			if (!x) return "";
			return (Number.isInteger(x) ? x
				: (x < 10 ? x.toFixed(2) : x.toFixed(1))) + " MW";
		}

		return makeVectorTileLayer({
			label:         "PowerInfra",
			pane:          "dwInfraPane",
			paneZIndex:    410,
			minZoom:       9,
			padBounds:     0.1,
			maxNativeZoom: CFG.OIM_MAX_NATIVE_Z,
			attribution:   'Power data © <a href="https://openinframap.org/" target="_blank" rel="noreferrer">OpenInfraMap</a> / <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>',
			tileUrl: (z, x, y) => `${CFG.OIM_POWER_TILES}/${z}/${x}/${y}.pbf`,

			toElements: (layerName, p, gtype, rings) => {
				if (p.disused) return null;
				if (layerName === "power_line") {
					const t = p.type;
					const power = t === "cable" ? "cable"
						: t === "minor_line" ? "minor_line" : "line";
					const tags = { power, voltage: kvToV(p.voltage),
						name: p.name, operator: p.operator, ref: p.ref };
					return rings.map((r) => ({ type: "way", geometry: r, tags }));
				}
				if (layerName === "power_substation") {
					const tags = { power: "substation", voltage: kvToV(p.voltage),
						name: p.name, operator: p.operator };
					return rings.map((r) => ({ type: "way", geometry: r, tags,
						_id: "sub/" + p.osm_id }));
				}
				if (layerName === "power_substation_point") {
					const r = rings[0]; if (!r || !r.length) return null;
					return [{ type: "node", lat: r[0].lat, lon: r[0].lon,
						_id: "sub/" + p.osm_id, tags: { power: "substation",
							voltage: kvToV(p.voltage), name: p.name,
							operator: p.operator } }];
				}
				if (layerName === "power_plant") {
					const tags = { power: "plant", "plant:source": p.source,
						"plant:output:electricity": fmtMW(p.output),
						name: p.name, operator: p.operator };
					return rings.map((r) => ({ type: "way", geometry: r, tags,
						_id: "plant/" + p.osm_id }));
				}
				if (layerName === "power_plant_point") {
					const r = rings[0]; if (!r || !r.length) return null;
					return [{ type: "node", lat: r[0].lat, lon: r[0].lon,
						_id: "plant/" + p.osm_id, tags: { power: "plant",
							"plant:source": p.source,
							"plant:output:electricity": fmtMW(p.output),
							name: p.name, operator: p.operator } }];
				}
				if (layerName === "power_generator_area") {
					const tags = { power: "generator",
						"generator:source": p.source,
						"generator:output:electricity": fmtMW(p.output),
						name: p.name, operator: p.operator };
					return rings.map((r) => ({ type: "way", geometry: r, tags }));
				}
				return null;
			},

			render: (group, elements, zoom) => {
				for (const el of elements) {
					const tags  = el.tags || {};
					const power = tags.power;
					if (!power) continue;
					const geom  = el.geometry || [];

					if (el.type === "way" && geom.length &&
						(power === "line" || power === "minor_line" || power === "cable")) {
						const latlngs = geom.map(g => [g.lat, g.lon]);
						const color   = lineColor(tags.voltage);
						const weight  = lineWeight(power, tags.voltage);
						const vLabel  = fmtVoltage(tags.voltage);
						const tip =
							esc`<b>${vLabel || (power === "cable" ? "Underground cable" : "Power line")}</b>` +
							(tags.name     ? esc`<br>${tags.name}` : "") +
							(tags.operator ? esc`<br>${tags.operator}` : "") +
							(tags.ref      ? esc`<br>Ref: ${tags.ref}` : "");
						L.polyline(latlngs, {
							pane: "dwInfraPane", color: "#222",
							weight: weight + 2.5, opacity: 0.35, interactive: false,
						}).addTo(group);
						L.polyline(latlngs, {
							pane: "dwInfraPane", color,
							weight, opacity: 0.92,
							dashArray: power === "cable" ? "6 4" : null,
						}).bindTooltip(tip, { className: "dw-infra-tip", sticky: true })
						  .addTo(group);
						continue;
					}

					if (el.type === "way" && geom.length &&
						(power === "substation" || power === "plant")) {
						const latlngs = geom.map(g => [g.lat, g.lon]);
						const isPlant = power === "plant";
						const fill    = isPlant ? "#9B59B6" : "#F0A500";
						const vLabel  = fmtVoltage(tags.voltage);
						const tip =
							esc`<b>${tags.name || (isPlant ? "Power plant" : "Substation")}</b>` +
							(vLabel                           ? esc`<br>${vLabel}` : "") +
							(tags.operator                    ? esc`<br>${tags.operator}` : "") +
							(tags["plant:source"]             ? esc`<br>Source: ${tags["plant:source"]}` : "") +
							(tags["plant:output:electricity"] ? esc`<br>Output: ${tags["plant:output:electricity"]}` : "");
						L.polygon(latlngs, {
							pane: "dwInfraPane", color: fill, weight: 1.5,
							opacity: 0.9, fillColor: fill, fillOpacity: 0.2,
						}).bindTooltip(tip, { className: "dw-infra-tip", sticky: true })
						  .addTo(group);
						continue;
					}

					if (el.type === "way" && geom.length &&
						power === "generator" && tags["generator:source"] === "solar") {
						const latlngs = geom.map(g => [g.lat, g.lon]);
						const tip =
							esc`<b>${tags.name || "Solar farm"}</b>` +
							(tags["generator:output:electricity"] ? esc`<br>Output: ${tags["generator:output:electricity"]}` : "") +
							(tags.operator                        ? esc`<br>${tags.operator}` : "");
						L.polygon(latlngs, {
							pane: "dwInfraPane", color: "#F6C90E", weight: 1.5,
							opacity: 0.9, fillColor: "#F6C90E", fillOpacity: 0.25,
						}).bindTooltip(tip, { className: "dw-infra-tip", sticky: true })
						  .addTo(group);
						continue;
					}

					let lat, lon;
					if (el.type === "node") {
						lat = el.lat; lon = el.lon;
					} else if (geom.length) {
						let sLat = 0, sLon = 0;
						for (const g of geom) { sLat += g.lat; sLon += g.lon; }
						lat = sLat / geom.length; lon = sLon / geom.length;
					} else { continue; }
					if (!isFinite(lat) || !isFinite(lon)) continue;

					const src = tags["generator:source"] || "";
					let glyph, fill, label;
					if      (power === "substation")   { glyph = "⚡"; fill = "#F0A500"; label = tags.name || "Substation"; }
					else if (power === "plant")        { glyph = "⚙"; fill = "#9B59B6"; label = tags.name || "Power plant"; }
					else if (power === "transformer")  { glyph = "T";  fill = "#E67E22"; label = "Transformer"; }
					else if (src   === "wind")         { glyph = "〇"; fill = "#5B9BD5"; label = tags.name || "Wind turbine"; }
					else if (src   === "solar")        { glyph = "☀"; fill = "#F6C90E"; label = tags.name || "Solar generator"; }
					else                               { glyph = "⚡"; fill = "#aaa";    label = tags.name || power; }

					const sz  = power === "transformer" ? 12 : 16;
					const vLabel = fmtVoltage(tags.voltage);
					let tip = esc`<b>${label}</b>`;
					if (vLabel)                                   tip += esc`<br>${vLabel}`;
					if (tags.operator)                            tip += esc`<br>${tags.operator}`;
					if (tags["generator:output:electricity"])     tip += esc`<br>Output: ${tags["generator:output:electricity"]}`;
					if (tags["plant:source"])                     tip += esc`<br>Source: ${tags["plant:source"]}`;

					L.marker([lat, lon], { icon: pointIcon(glyph, fill, sz), pane: "dwInfraPane", interactive: true })
						.bindTooltip(tip, { className: "dw-infra-tip", sticky: true })
						.addTo(group);
				}
			},
		});
	}
}

export class TelecomsLayerProvider extends LayerProvider {
	create() {
		const dotIcon = (g, f, s) => oimIcon("dw-telecom-icon", g, f, s || 15);
		const DC_FILL = "#00897B";
		const MAST_FILL = "#26A69A";

		return makeVectorTileLayer({
			label:         "Telecoms",
			pane:          "dwTelecomPane",
			paneZIndex:    409,
			minZoom:       10,
			padBounds:     0.1,
			maxNativeZoom: CFG.OIM_MAX_NATIVE_Z,
			attribution:   'Telecoms data © <a href="https://openinframap.org/" target="_blank" rel="noreferrer">OpenInfraMap</a> / <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>',
			tileUrl: (z, x, y) => `${CFG.OIM_TELECOM_TILES}/${z}/${x}/${y}.pbf`,

			toElements: (layerName, p, gtype, rings) => {
				if (p.disused) return null;
				if (layerName === "telecoms_data_center") {
					const tags = { kind: "datacenter", name: p.name,
						operator: p.operator, dtype: p.type };
					return rings.map((r) => ({ type: "way", geometry: r, tags,
						_id: "dc/" + p.osm_id }));
				}
				if (layerName === "telecoms_data_center_point") {
					const r = rings[0]; if (!r || !r.length) return null;
					return [{ type: "node", lat: r[0].lat, lon: r[0].lon,
						_id: "dc/" + p.osm_id, tags: { kind: "datacenter",
							name: p.name, operator: p.operator, dtype: p.type } }];
				}
				if (layerName === "telecoms_mast" || layerName === "telecoms_antenna") {
					const r = rings[0]; if (!r || !r.length) return null;
					return [{ type: "node", lat: r[0].lat, lon: r[0].lon,
						tags: { kind: layerName === "telecoms_mast" ? "mast" : "antenna",
							name: p.name, operator: p.operator } }];
				}
				return null;
			},

			render: (group, elements) => {
				for (const el of elements) {
					const t = el.tags || {};
					if (el.type === "way" && el.geometry && el.geometry.length) {
						const latlngs = el.geometry.map((g) => [g.lat, g.lon]);
						const tip =
							esc`<b>${t.name || "Telephone exchange / data centre"}</b>` +
							(t.dtype    ? esc`<br>${t.dtype}` : "") +
							(t.operator ? esc`<br>${t.operator}` : "");
						L.polygon(latlngs, {
							pane: "dwTelecomPane", color: DC_FILL, weight: 1.5,
							opacity: 0.9, fillColor: DC_FILL, fillOpacity: 0.2,
						}).bindTooltip(tip, { className: "dw-infra-tip", sticky: true })
						  .addTo(group);
						continue;
					}
					if (el.type !== "node" || !isFinite(el.lat) || !isFinite(el.lon))
						continue;
					let glyph, fill, label;
					if (t.kind === "datacenter") {
						glyph = "▣"; fill = DC_FILL;
						label = t.name || "Telephone exchange / data centre";
					} else if (t.kind === "mast") {
						glyph = "T"; fill = MAST_FILL; label = t.name || "Comms mast";
					} else {
						glyph = "Y"; fill = MAST_FILL; label = t.name || "Antenna";
					}
					let tip = esc`<b>${label}</b>`;
					if (t.dtype)    tip += esc`<br>${t.dtype}`;
					if (t.operator) tip += esc`<br>${t.operator}`;
					L.marker([el.lat, el.lon], {
						icon: dotIcon(glyph, fill, t.kind === "datacenter" ? 16 : 13),
						pane: "dwTelecomPane", interactive: true,
					}).bindTooltip(tip, { className: "dw-infra-tip", sticky: true })
					  .addTo(group);
				}
			},
		});
	}
}

export class WaterLayerProvider extends LayerProvider {
	create() {
		const dotIcon = (g, f, s) => oimIcon("dw-water-icon", g, f, s || 14);
		const STYLE = {
			plant_water: { fill: "#0277BD", glyph: "≈", label: "Water treatment plant" },
			plant_waste: { fill: "#6D4C41", glyph: "≈", label: "Wastewater plant" },
			reservoir:   { fill: "#0288D1", glyph: "R", label: "Reservoir" },
			tower:       { fill: "#0288D1", glyph: "T", label: "Water tower" },
			well:        { fill: "#0288D1", glyph: "○", label: "Well" },
			pump:        { fill: "#00897B", glyph: "P", label: "Pumping station" },
		};
		const WASTE = /waste|sewage|sewer|drain/i;

		return makeVectorTileLayer({
			label:         "Water",
			pane:          "dwWaterPane",
			paneZIndex:    400,
			minZoom:       10,
			padBounds:     0.1,
			maxNativeZoom: CFG.OIM_MAX_NATIVE_Z,
			attribution:   'Water data © <a href="https://openinframap.org/" target="_blank" rel="noreferrer">OpenInfraMap</a> / <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>',
			tileUrl: (z, x, y) => `${CFG.OIM_WATER_TILES}/${z}/${x}/${y}.pbf`,

			toElements: (layerName, p, gtype, rings) => {
				if (p.disused) return null;
				const tagsFor = (wk) => ({ wk: wk, name: p.name,
					operator: p.operator, substance: p.substance });
				const ways = (wk, id) => rings.map((r) => ({ type: "way",
					geometry: r, tags: tagsFor(wk), _id: id }));
				const point = (wk, id) => {
					const r = rings[0]; if (!r || !r.length) return null;
					return [{ type: "node", lat: r[0].lat, lon: r[0].lon,
						_id: id, tags: tagsFor(wk) }];
				};
				switch (layerName) {
					case "water_pipeline": {
						const wk = WASTE.test(p.substance || "")
							? "pipe_waste" : "pipe_water";
						return rings.map((r) => ({ type: "way", geometry: r,
							tags: tagsFor(wk) }));
					}
					case "water_treatment_plant_polygon": return ways("plant_water", "wtp/" + p.osm_id);
					case "water_treatment_plant_point":   return point("plant_water", "wtp/" + p.osm_id);
					case "wastewater_plant_polygon":      return ways("plant_waste", "wwp/" + p.osm_id);
					case "wastewater_plant_point":        return point("plant_waste", "wwp/" + p.osm_id);
					case "water_reservoir":               return ways("reservoir", "res/" + p.osm_id);
					case "water_reservoir_point":         return point("reservoir", "res/" + p.osm_id);
					case "pumping_station_polygon":       return ways("pump", "pmp/" + p.osm_id);
					case "pumping_station_point":         return point("pump", "pmp/" + p.osm_id);
					case "water_tower":                   return point("tower");
					case "water_well":                    return point("well");
					default: return null;
				}
			},

			render: (group, elements) => {
				for (const el of elements) {
					const t = el.tags || {};
					const extra = (t.operator ? esc`<br>${t.operator}` : "") +
						(t.substance ? esc`<br>${t.substance}` : "");
					if (el.type === "way" && el.geometry && el.geometry.length) {
						const latlngs = el.geometry.map((g) => [g.lat, g.lon]);
						if (t.wk === "pipe_water" || t.wk === "pipe_waste") {
							const waste = t.wk === "pipe_waste";
							L.polyline(latlngs, {
								pane: "dwWaterPane",
								color: waste ? "#8D6E63" : "#039BE5",
								weight: 2, opacity: 0.9,
								dashArray: waste ? "5 4" : null,
							}).bindTooltip(esc`<b>${t.name ||
								(waste ? "Wastewater pipeline" : "Water pipeline")}</b>` + extra,
								{ className: "dw-infra-tip", sticky: true }).addTo(group);
							continue;
						}
						const st = STYLE[t.wk] || STYLE.reservoir;
						L.polygon(latlngs, {
							pane: "dwWaterPane", color: st.fill, weight: 1.5,
							opacity: 0.9, fillColor: st.fill, fillOpacity: 0.2,
						}).bindTooltip(esc`<b>${t.name || st.label}</b>` + extra,
							{ className: "dw-infra-tip", sticky: true }).addTo(group);
						continue;
					}
					if (el.type !== "node" || !isFinite(el.lat) || !isFinite(el.lon))
						continue;
					const st = STYLE[t.wk]; if (!st) continue;
					L.marker([el.lat, el.lon], {
						icon: dotIcon(st.glyph, st.fill, t.wk === "well" ? 12 : 14),
						pane: "dwWaterPane", interactive: true,
					}).bindTooltip(esc`<b>${t.name || st.label}</b>` + extra,
						{ className: "dw-infra-tip", sticky: true }).addTo(group);
				}
			},
		});
	}
}
