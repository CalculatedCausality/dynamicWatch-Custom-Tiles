import { LayerProvider } from "../layers/provider-factories.js";
import { pollingDataLayer } from "../layers/polling-data-layer.js";
import { gmJsonGet } from "../utils/http.js";
import { _escHtml, esc } from "../utils/html.js";

export class FlightsLayerProvider extends LayerProvider {
	create() {
		const OPENSKY = "https://opensky-network.org/api/states/all";
		const renderStates = (group, states) => {
			// Delta update keyed by ICAO24 (s[0], stable per aircraft):
			// reuse existing markers so minor 10s poll moves don't rebuild DOM.
			const prev = group._dwFlights instanceof Map
				? group._dwFlights : new Map();
			const next = new Map();
			for (const s of states) {
				const lon = s[5],
					lat = s[6];
				if (lon == null || lat == null) continue;
				const id = s[0];
				if (!id || next.has(id)) continue;
				const callsign = (s[1] || "").trim() || s[0];
				const track = s[10] || 0;
				const onGround = s[8];
				const altM = s[7];
				const speedMs = s[9];
				const country = s[2] || "";
				const altStr =
					altM != null ? Math.round(altM) + "\u202fm" : "\u2014";
				const spdStr =
					speedMs != null
						? Math.round(speedMs * 1.944) + "\u202fkts"
						: "\u2014";
				const fill = onGround ? "#aaa" : "#FFE066";
				const stroke = onGround ? "#666" : "#444";
				const plane =
					`<svg viewBox="0 0 20 20" width="20" height="20" xmlns="http://www.w3.org/2000/svg">` +
					`<g transform="translate(10,10) rotate(${track})">` +
					`<ellipse rx="1.5" ry="7" fill="${fill}" stroke="${stroke}" stroke-width="0.6"/>` +
					`<polygon points="0,-2 -9,4 -8,5.5 0,2 8,5.5 9,4" fill="${fill}" stroke="${stroke}" stroke-width="0.6"/>` +
					`<polygon points="0,5 -4,8 -3.5,9 0,7 3.5,9 4,8" fill="${fill}" stroke="${stroke}" stroke-width="0.6"/>` +
					`</g></svg>`;
				const icon = L.divIcon({
					className: "dw-flight-icon",
					html: plane,
					iconSize: [20, 20],
					iconAnchor: [10, 10],
				});
				const tip = esc`<b>${callsign}</b><br>Alt: ${altStr}&nbsp; Speed: ${spdStr}<br>${country}`;
				let m = prev.get(id);
				if (m && group.hasLayer(m)) {
					m.setLatLng([lat, lon]);
					if (m._dwIconKey !== plane) { m.setIcon(icon); m._dwIconKey = plane; }
					m.setTooltipContent(tip);
					prev.delete(id);
				} else {
					m = L.marker([lat, lon], {
						icon,
						pane: "dwFlightsPane",
						interactive: true,
					}).bindTooltip(tip, { className: "dw-flight-tip", sticky: true })
						.addTo(group);
					m._dwIconKey = plane;
				}
				next.set(id, m);
			}
			for (const m of prev.values()) {
				if (group.hasLayer(m)) group.removeLayer(m);
			}
			group._dwFlights = next;
		};

		const FlightsLayer = pollingDataLayer({
			pane: "dwFlightsPane", paneZIndex: 450,
			minZoom: 6, pollMs: 10000,
			attribution: 'Flights © <a href="https://opensky-network.org" target="_blank" rel="noreferrer">OpenSky Network</a>',
			fetch: (map, group) => {
				const b = map.getBounds();
				const url = OPENSKY +
					"?lamin=" + b.getSouth().toFixed(3) +
					"&lomin=" + b.getWest().toFixed(3) +
					"&lamax=" + b.getNorth().toFixed(3) +
					"&lomax=" + b.getEast().toFixed(3);
				gmJsonGet(url, (err, data) => {
					if (err || !data || !group._map) return;
					renderStates(group, data.states || []);
				});
			},
		});
		return new FlightsLayer();
	}
}

export class MarineTrafficLayerProvider extends LayerProvider {
	create() {
		const MAX_TILES = 25;
		const MT_BASE = "https://www.marinetraffic.com/getData/get_data_json_4";

		function latLonToTile(lat, lon, z) {
			lat = Math.max(-85.0511, Math.min(85.0511, lat));
			const n = Math.pow(2, z);
			const x = Math.floor(((lon + 180) / 360) * n);
			const rad = (lat * Math.PI) / 180;
			const y = Math.floor(
				((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n,
			);
			return {
				x: Math.max(0, Math.min(n - 1, x)),
				y: Math.max(0, Math.min(n - 1, y)),
			};
		}

		function shipColor(type) {
			const t = parseInt(type) || 0;
			if (t === 7) return "#5B9BD5";
			if (t === 8) return "#D9534F";
			if (t === 6) return "#9B59B6";
			if (t === 4) return "#F0A500";
			if (t === 3) return "#2ECC71";
			if (t === 5) return "#2980B9";
			if (t >= 70 && t < 80) return "#5B9BD5";
			if (t >= 80 && t < 90) return "#D9534F";
			if (t >= 60 && t < 70) return "#9B59B6";
			if (t >= 40 && t < 50) return "#F0A500";
			if (t === 30) return "#2ECC71";
			if (t >= 36 && t <= 37) return "#2980B9";
			return "#90A4AE";
		}

		function renderShip(group, v) {
			const fill = shipColor(v.type);
			const svg =
				`<svg viewBox="0 0 14 20" width="14" height="20" xmlns="http://www.w3.org/2000/svg">` +
				`<g transform="translate(7,10) rotate(${v.hdg})">` +
				`<polygon points="0,-9 4.5,8 0,5 -4.5,8" fill="${fill}" stroke="#333" stroke-width="0.7"/>` +
				`</g></svg>`;
			const icon = L.divIcon({ className: "dw-marine-icon", html: svg,
				iconSize: [14, 20], iconAnchor: [7, 10] });
			L.marker([v.lat, v.lon], { icon, pane: "dwMarinePane", interactive: true })
				.bindTooltip(
					esc`<b>${v.name}</b><br>MMSI: ${v.mmsi}<br>Speed: ${v.spdKts} kts Hdg: ${Math.round(v.hdg)}°`,
					{ className: "dw-marine-tip", sticky: true })
				.addTo(group);
		}

		function renderCluster(group, map, lat, lon, vessels) {
			const count = vessels.length;
			const size = count < 6 ? 22 : count < 21 ? 28 : 36;
			const fontPx = Math.round(size * 0.42);
			const fill = count < 6 ? "#5b9bd5" : count < 21 ? "#2e6a98" : "#1c4870";
			const icon = L.divIcon({
				className: "dw-marine-cluster",
				html: `<div style="background:${fill};color:#fff;width:${size}px;height:${size}px;border-radius:50%;display:flex;align-items:center;justify-content:center;font:bold ${fontPx}px/1 sans-serif;border:2px solid rgba(255,255,255,0.85);box-shadow:0 0 4px rgba(0,0,0,.5);">${count}</div>`,
				iconSize: [size, size], iconAnchor: [size / 2, size / 2],
			});
			const sample = vessels.slice(0, 5).map((v) => _escHtml(v.name)).join("<br>");
			const more = vessels.length > 5 ? `<br><i>+${vessels.length - 5} more</i>` : "";
			L.marker([lat, lon], { icon, pane: "dwMarinePane", interactive: true })
				.bindTooltip(
					`<b>${count} vessels</b><br><span class="dw-cad-sub">${sample}${more}</span>`,
					{ className: "dw-marine-tip", sticky: true })
				.on("click", () => {
					const zoom = Math.min(map.getZoom() + 2, map.getMaxZoom());
					const noMotion = window.matchMedia &&
						window.matchMedia("(prefers-reduced-motion: reduce)").matches;
					if (noMotion) map.setView([lat, lon], zoom, { animate: false });
					else map.flyTo([lat, lon], zoom, { duration: 0.5 });
				})
				.addTo(group);
		}

		function renderRows(group, map, rows) {
			group.clearLayers();
			const pick = (obj, ...keys) => {
				for (const k of keys) {
					const v = obj[k];
					if (v !== undefined && v !== null && v !== "") return v;
				}
				return "";
			};
			const vessels = [];
			for (const v of rows) {
				const lat = parseFloat(pick(v, "LAT", "lat"));
				const lon = parseFloat(pick(v, "LON", "lon"));
				if (!isFinite(lat) || !isFinite(lon)) continue;
				const name = String(pick(v, "SHIPNAME", "shipname", "NAME", "name", "MMSI") || "").trim() || "Unknown";
				const mmsi = pick(v, "MMSI", "mmsi") || "";
				const type = parseInt(pick(v, "SHIPTYPE", "shiptype", "TYPE", "type") || "0") || 0;
				const hdg  = parseFloat(pick(v, "HEADING", "heading", "COURSE", "course") || "0") || 0;
				const rawSpd = parseFloat(pick(v, "SPEED", "speed") || "0") || 0;
				const spdKts = rawSpd > 102 ? (rawSpd / 10).toFixed(1) : rawSpd.toFixed(1);
				vessels.push({ lat, lon, name, mmsi, type, hdg, spdKts });
			}
			if (!vessels.length) return;
			const CELL_PX = 50;
			const zoom = map.getZoom();
			const cells = new Map();
			for (const v of vessels) {
				const pt = map.project([v.lat, v.lon], zoom);
				const key = Math.floor(pt.x / CELL_PX) + "/" + Math.floor(pt.y / CELL_PX);
				let cell = cells.get(key);
				if (!cell) { cell = { vessels: [], sumLat: 0, sumLon: 0 }; cells.set(key, cell); }
				cell.vessels.push(v);
				cell.sumLat += v.lat;
				cell.sumLon += v.lon;
			}
			for (const cell of cells.values()) {
				if (cell.vessels.length === 1) {
					renderShip(group, cell.vessels[0]);
				} else {
					renderCluster(group, map,
						cell.sumLat / cell.vessels.length,
						cell.sumLon / cell.vessels.length,
						cell.vessels);
				}
			}
		}

		const MTLayer = pollingDataLayer({
			pane: "dwMarinePane", paneZIndex: 440,
			minZoom: 6, pollMs: 20000,
			attribution: 'Vessels © <a href="https://www.marinetraffic.com" target="_blank" rel="noreferrer">MarineTraffic</a>',
			fetch: (map, group) => {
				const tileZ = Math.max(4, Math.min(map.getZoom(), 8));
				const apiZ = tileZ + 1;
				const b = map.getBounds();
				const center = map.getCenter();
				const nw = latLonToTile(b.getNorth(), b.getWest(), tileZ);
				const se = latLonToTile(b.getSouth(), b.getEast(), tileZ);
				const tiles = [];
				for (let y = nw.y; y <= se.y && tiles.length < MAX_TILES; y++) {
					for (let x = nw.x; x <= se.x && tiles.length < MAX_TILES; x++) {
						tiles.push({ x, y });
					}
				}
				if (!tiles.length) return;
				const vessels = new Map();
				let remaining = tiles.length;
				const referer = `https://www.marinetraffic.com/en/ais/home/centerx:${center.lng.toFixed(1)}/centery:${center.lat.toFixed(1)}/zoom:${tileZ}`;
				const done = () => {
					if (--remaining === 0 && group._map) {
						renderRows(group, map, [...vessels.values()]);
					}
				};
				for (const { x, y } of tiles) {
					const url = `${MT_BASE}/z:${apiZ}/X:${x}/Y:${y}/station:0`;
					gmJsonGet(url, {
						headers: {
							"Accept": "*/*",
							"X-Requested-With": "XMLHttpRequest",
							"Referer": referer,
						},
					}, (err, parsed) => {
						if (err) { done(); return; }
						const raw =
							(parsed.data && parsed.data.rows) ||
							(Array.isArray(parsed.data) ? parsed.data : null) ||
							(Array.isArray(parsed) ? parsed : null);
						if (!Array.isArray(raw)) { done(); return; }
						let rows = raw;
						if (rows.length && Array.isArray(rows[0])) {
							const hdrs = rows[0];
							rows = rows.slice(1).map((row) => {
								const obj = {};
								hdrs.forEach((h, i) => { obj[h] = row[i]; });
								return obj;
							});
						}
						for (const v of rows) {
							const key = v.MMSI || v.mmsi ||
								String(v.LAT || v.lat) + "," + String(v.LON || v.lon);
							if (key && !vessels.has(key)) vessels.set(key, v);
						}
						done();
					});
				}
			},
		});
		return new MTLayer();
	}
}
