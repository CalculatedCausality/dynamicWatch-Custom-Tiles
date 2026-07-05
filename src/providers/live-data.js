import { LayerProvider } from "../layers/provider-factories.js";
import { pollingDataLayer } from "../layers/polling-data-layer.js";
import { gmJsonGet } from "../utils/http.js";
import { _escHtml, esc } from "../utils/html.js";
import { getWazeToken } from "./waze-token.js";

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

export class WazeLayerProvider extends LayerProvider {
	create() {
		const GEORSS = "https://www.waze.com/live-map/api/georss";

		// Waze shards the world across three server environments; the
		// wrong env returns an empty result set rather than an error.
		function wazeEnv(lat, lon) {
			if (lat >= 29 && lat <= 34 && lon >= 34 && lon <= 36) return "il";
			if (lat >= 12 && lat <= 76 && lon >= -170 && lon <= -48) return "na";
			return "row";
		}

		const ALERT_STYLE = {
			POLICE:        { glyph: "\u{1F46E}", color: "#4A89F3" },
			ACCIDENT:      { glyph: "\u{1F4A5}", color: "#E74C3C" },
			HAZARD:        { glyph: "⚠️", color: "#F0A500" },
			WEATHERHAZARD: { glyph: "⚠️", color: "#F0A500" },
			ROAD_CLOSED:   { glyph: "⛔", color: "#C0392B" },
			JAM:           { glyph: "\u{1F697}", color: "#E67E22" },
			CONSTRUCTION:  { glyph: "\u{1F6A7}", color: "#E67E22" },
			CHIT_CHAT:     { glyph: "\u{1F4AC}", color: "#90A4AE" },
		};
		const DEFAULT_STYLE = { glyph: "\u{1F4CD}", color: "#90A4AE" };
		// Jam severity is 0-5 (5 = standstill); index by clamped level.
		const JAM_COLORS =
			["#7CB342", "#C0CA33", "#F0A500", "#E67E22", "#D9534F", "#7F1D1D"];

		// Wazer "mood" is Waze's avatar id. Base moods are 1-60 (matching
		// Waze's own enum); FIRST_CUSTOM_MOOD=100, so anything >=100 is a
		// paid/seasonal custom avatar with no base emotion — Waze itself
		// renders those as the default "happy" face, so we do too. Female
		// variants (14-26) map to the same emoji as their base.
		const MOOD_EMOJI = {
			1: "🙂", 14: "🙂",          // HAPPY
			2: "😢", 15: "😢",          // SAD
			3: "😠", 16: "😠",          // MAD
			4: "😐", 17: "😐",          // BORED
			5: "💨", 18: "💨",          // SPEEDY
			6: "😋", 19: "😋",          // STARVING
			7: "😴", 20: "😴",          // SLEEPY
			8: "😎", 21: "😎",          // COOL
			9: "😍", 22: "😍",          // IN_LOVE
			10: "😂", 23: "😂",         // LOL
			11: "😌", 24: "😌",         // PEACEFUL
			12: "🎤", 25: "🎤",         // SINGING
			13: "🤔", 26: "🤔",         // WONDERING
			27: "🤖", 28: "👾", 29: "🦕", // ROBOT, BIT, DINO
			30: "😫", 31: "😫",         // BUSY
			32: "🏃", 33: "🏃",         // IN_A_HURRY
			34: "👶", 35: "👹",         // BABY, MONSTER
			36: "🦆", 37: "🦆",         // DUCK
			38: "🤓", 39: "🤓",         // GEEK
			40: "😏", 41: "😏",         // SARCASTIC
			42: "😊", 43: "😊",         // SHY
			44: "🤒", 45: "🤒",         // SICK
			46: "🥷", 47: "🥷",         // NINJA
			48: "🐶", 49: "🐱",         // DOG, CAT
			50: "🌻", 51: "🧟", 52: "😤", 53: "😤", // SUNFLOWER, ZOMBIE, PROUD
			54: "🗑️", 55: "❄️", 56: "👨‍🔬", 57: "🐛", // GARBAGE, SNOW, ALBERT, BUG_BUSTER
			58: "🏍️", 59: "🏍️",        // BIKER_RED, BIKER_DARK
		};
		const moodEmoji = (m) => MOOD_EMOJI[m] || "🙂";
		// Wazer marker: the mood emoji on a blue disc (keeps the "live
		// driver" identity while replacing the bare dot).
		const wazerIcon = (emoji) => L.divIcon({
			className: "dw-waze-user-icon",
			html: `<div style="background:#33ccff;width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;line-height:1;border:2px solid #fff;box-shadow:0 0 3px rgba(0,0,0,.5);">${emoji}</div>`,
			iconSize: [20, 20], iconAnchor: [10, 10],
		});

		const agoStr = (ms) => {
			if (!ms) return "";
			const s = Math.max(0, (Date.now() - ms) / 1000);
			if (s < 90) return Math.round(s) + "s ago";
			if (s < 5400) return Math.round(s / 60) + " min ago";
			return (s / 3600).toFixed(1) + " h ago";
		};
		const titleCase = (s) => String(s || "").replace(/_/g, " ")
			.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
		// Prefer the (more specific) subtype, e.g. "Police With Mobile
		// Camera", falling back to the coarse type.
		const alertTitle = (a) => titleCase(a.subtype || a.type) || "Report";
		const placeStr = (o) =>
			[o.street, o.city].filter(Boolean).join(", ");
		// Count community thumbs-up on an alert's comment thread.
		const thumbsCount = (a) => {
			if (typeof a.nThumbsUp === "number") return a.nThumbsUp;
			if (Array.isArray(a.comments))
				return a.comments.filter((c) => c && c.isThumbsUp).length;
			return 0;
		};
		// Trim + cap free-text so a giant council road-closure notice
		// doesn't blow the tooltip out.
		const clip = (s, n) => {
			const t = String(s || "").trim().replace(/\s+/g, " ");
			return t.length > n ? t.slice(0, n - 1) + "…" : t;
		};

		const render = (group, data) => {
			// Delta update keyed by stable id, same pattern as flights:
			// alerts are static and jams only mutate speed/level, so
			// 30s polls mostly reuse existing DOM.
			const prev = group._dwWaze instanceof Map
				? group._dwWaze : new Map();
			const next = new Map();
			const keep = (key, make, update) => {
				if (next.has(key)) return;
				let lyr = prev.get(key);
				if (lyr && group.hasLayer(lyr)) {
					update(lyr);
					prev.delete(key);
				} else {
					lyr = make();
					if (!lyr) return;
					lyr.addTo(group);
				}
				next.set(key, lyr);
			};

			for (const a of data.alerts || []) {
				const loc = a.location;
				if (!a.id || !loc || loc.x == null || loc.y == null) continue;
				const style = ALERT_STYLE[a.type] || DEFAULT_STYLE;
				const title = alertTitle(a);
				const meta = [placeStr(a), agoStr(a.pubMillis)]
					.filter(Boolean).join(" · ");
				const thumbs = thumbsCount(a);
				const thumbStr = thumbs ? ` · \u{1F44D} ${thumbs}` : "";
				// Reporter's free-text note (e.g. "Pothole Detected",
				// "Disabled Car Ahead", closure schedules).
				const desc = clip(a.reportDescription, 160);
				const descStr = desc ? esc`<br><i>${desc}</i>` : "";
				// Attribution — usually an official feed (Waymo, HAAS,
				// council road-works), occasionally a community handle.
				const by = clip(a.reportBy || a.provider, 48);
				const byStr = by ? esc`<br><span class="dw-cad-sub">via ${by}</span>` : "";
				const metaStr = (meta || thumbStr)
					? esc`<br><span class="dw-cad-sub">${meta}${thumbStr}</span>` : "";
				const tip = esc`<b>${style.glyph} ${title}</b>` +
					descStr + metaStr + byStr;
				keep("a:" + a.id, () => {
					const icon = L.divIcon({
						className: "dw-waze-icon",
						html: `<div style="background:${style.color};width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;border:2px solid #fff;box-shadow:0 0 3px rgba(0,0,0,.6);">${style.glyph}</div>`,
						iconSize: [22, 22], iconAnchor: [11, 11],
					});
					const m = L.marker([loc.y, loc.x], {
						icon, pane: "dwWazePane", interactive: true,
					}).bindTooltip(tip, { className: "dw-waze-tip", sticky: true });
					m._dwData = {
						color: style.color,
						name: title + (a.street ? " — " + a.street : ""),
					};
					return m;
				}, (m) => m.setTooltipContent(tip));
			}

			for (const j of data.jams || []) {
				if (j.id == null || !Array.isArray(j.line) || j.line.length < 2)
					continue;
				const pts = j.line
					.filter((p) => p && p.x != null && p.y != null)
					.map((p) => [p.y, p.x]);
				if (pts.length < 2) continue;
				const level = Math.max(0, Math.min(5, j.level || 0));
				const color = JAM_COLORS[level];
				// `speed` is m/s; `delay` (when present) is seconds lost.
				const kmh = j.speed != null ? Math.round(j.speed * 3.6) : null;
				const spdStr = kmh != null ? kmh + " km/h" : "";
				const delayStr = j.delay > 0
					? "+" + Math.round(j.delay / 60) + " min" : "";
				const lenStr = j.length != null
					? (j.length / 1000).toFixed(1) + " km" : "";
				const place = placeStr(j);
				// endNode names the cross-street the jam clears at.
				const endTo = clip(j.endNode, 40);
				const head = "Traffic" +
					(place ? " — " + place : "") +
					(endTo ? " → " + endTo : "");
				const meta = [spdStr, delayStr, lenStr, agoStr(j.updateMillis)]
					.filter(Boolean).join(" · ");
				// Waze often attributes a jam to the alert that caused it
				// (crash / hazard / construction) — name it if present.
				const ca = j.causeAlert;
				const cause = ca
					? clip(alertTitle(ca) +
						(ca.reportDescription ? " — " + ca.reportDescription : ""), 140)
					: "";
				const causeStr = cause
					? esc`<br><span class="dw-cad-sub">Cause: ${cause}</span>` : "";
				const tip = esc`<b>\u{1F697} ${head}</b>` +
					(meta ? esc`<br><span class="dw-cad-sub">${meta}</span>` : "") +
					causeStr;
				keep("j:" + j.id, () =>
					L.polyline(pts, {
						pane: "dwWazePane", color, weight: 5, opacity: 0.8,
						interactive: true,
					}).bindTooltip(tip, { className: "dw-waze-tip", sticky: true }),
				(pl) => {
					pl.setLatLngs(pts);
					pl.setStyle({ color });
					pl.setTooltipContent(tip);
				});
			}

			for (const u of data.users || []) {
				const loc = u.location;
				if (u.id == null || loc == null || loc.x == null || loc.y == null)
					continue;
				// The public georss anonymises wazers: userName is "guest"
				// for everyone but you/your friends, and there's no heading
				// or destination. Surface what's actually there — name when
				// present, speed when the region includes it, and the live
				// coordinates (which is the one thing that always updates).
				const named = u.userName && u.userName !== "guest"
					? u.userName : "";
				const title = named || "Active Waze driver";
				const spd = u.speed != null && u.speed > 0
					? Math.round(u.speed * 3.6) + " km/h" : "";
				const coords = loc.y.toFixed(5) + ", " + loc.x.toFixed(5);
				const meta = [spd, coords].filter(Boolean).join(" · ");
				const emoji = moodEmoji(u.mood);
				const tip = esc`<b>${emoji} ${title}</b><br>` +
					esc`<span class="dw-cad-sub">${meta}</span>`;
				keep("u:" + u.id, () => {
					const m = L.marker([loc.y, loc.x], {
						icon: wazerIcon(emoji), pane: "dwWazePane", interactive: true,
					}).bindTooltip(tip, { className: "dw-waze-tip", sticky: true });
					m._dwEmoji = emoji;
					m._dwData = { color: "#33ccff", name: title };
					return m;
				}, (m) => {
					m.setLatLng([loc.y, loc.x]);
					if (m._dwEmoji !== emoji) { m.setIcon(wazerIcon(emoji)); m._dwEmoji = emoji; }
					m.setTooltipContent(tip);
				});
			}

			for (const lyr of prev.values()) {
				if (group.hasLayer(lyr)) group.removeLayer(lyr);
			}
			group._dwWaze = next;
		};

		const WazeLayer = pollingDataLayer({
			pane: "dwWazePane", paneZIndex: 445,
			minZoom: 9, pollMs: 30000,
			attribution: 'Traffic © <a href="https://www.waze.com/live-map" target="_blank" rel="noreferrer">Waze</a>',
			fetch: (map, group) => {
				const b = map.getBounds();
				const c = map.getCenter();
				const url = GEORSS +
					"?top=" + b.getNorth().toFixed(6) +
					"&bottom=" + b.getSouth().toFixed(6) +
					"&left=" + b.getWest().toFixed(6) +
					"&right=" + b.getEast().toFixed(6) +
					"&env=" + wazeEnv(c.lat, c.lng) +
					"&types=alerts,traffic,users";
				// Waze answers 403 without a valid reCAPTCHA token, so
				// mint one first and bail quietly if unavailable.
				getWazeToken().then((token) => {
					if (!token || !group._map) return;
					gmJsonGet(url, {
						headers: {
							Referer: "https://www.waze.com/live-map",
							"X-Recaptcha-Token": token,
						},
					}, (err, data) => {
						if (err || !data || !group._map) return;
						render(group, data);
					});
				});
			},
		});
		return new WazeLayer();
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
