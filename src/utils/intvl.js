import { _escHtml, _safeColor } from "./html.js";

// Append alpha to a #rrggbb colour -> 'rgba(r,g,b,a)' for canvas fill.
export function hexAlpha(hex, a) {
	const m = /^#([0-9a-f]{6})$/i.exec(hex);
	if (!m) return hex;
	const v = parseInt(m[1], 16);
	return `rgba(${(v >> 16) & 0xff},${(v >> 8) & 0xff},${v & 0xff},${a})`;
}

// Ray-casting point-in-polygon for hit testing.
export function pointInRing(px, py, ring) {
	let inside = false;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const xi = ring[i][0], yi = ring[i][1];
		const xj = ring[j][0], yj = ring[j][1];
		const intersect = ((yi > py) !== (yj > py)) &&
			(px < (xj - xi) * (py - yi) / (yj - yi + 1e-12) + xi);
		if (intersect) inside = !inside;
	}
	return inside;
}

export function intvlActivityTime(activityId) {
	if (typeof activityId !== "string" || activityId.length < 9 ||
	    activityId[0] !== "c") return null;
	const ms = parseInt(activityId.slice(1, 9), 36);
	if (!Number.isFinite(ms) ||
	    ms < Date.UTC(2018, 0, 1) || ms > Date.now() + 864e5) return null;
	return new Date(ms);
}

// Newer activity ids are random, and about one in ten of those that start
// with "c" decodes to a believable date by chance. So the decoded time is
// only used when it agrees with the territory's own capture day.
export function intvlTrustedActivityTime(activityId, dayDate) {
	const t = intvlActivityTime(activityId);
	if (!t) return null;
	if (!(dayDate instanceof Date) || isNaN(dayDate)) return t;
	return Math.abs(t.getTime() - dayDate.getTime()) <= 4 * 864e5 ? t : null;
}

export function intvlAgo(date) {
	if (!(date instanceof Date) || isNaN(date)) return "";
	const days = Math.floor((Date.now() - date.getTime()) / 864e5);
	if (days < 0) return "";
	if (days === 0) return "today";
	if (days === 1) return "yesterday";
	if (days < 30) return days + " days ago";
	const months = Math.floor(days / 30);
	if (months < 12) return months + (months === 1 ? " month" : " months") + " ago";
	const years = Math.floor(days / 365);
	const rem = Math.floor((days - years * 365) / 30);
	return years + "y" + (rem ? " " + rem + "mo" : "") + " ago";
}

export function intvlArea(m2) {
	const v = Number(m2) || 0;
	if (v < 1e5) return Math.round(v).toLocaleString() + " m\u00b2";
	const km2 = v / 1e6;
	return (km2 < 10 ? km2.toFixed(2) : km2.toFixed(1)) + " km²";
}

// What identifies a runner across territories: the tile's userHash. "" when
// the tile carries none (older rows).
export function intvlOwnerKey(props) {
	const h = props && props.userHash;
	return typeof h === "string" && h ? h : "";
}

// "16.3 km in 1 h 15 min · 4:36 /km" from the run that claimed a territory
// (distance in km, duration in minutes). "" when either is missing or absurd.
export function intvlRunLine(props) {
	const km = Number(props && props.distance), min = Number(props && props.duration);
	if (!(km > 0) || !(min > 0) || km > 1000 || min > 6000) return "";
	const whole = Math.round(min);
	const time = whole >= 60 ? `${Math.floor(whole / 60)} h ${whole % 60} min` : `${whole} min`;
	const paceSec = Math.round(min * 60 / km);
	// A pace outside 2–30 min/km is a bike, a car or a paused watch: leave it out.
	const pace = paceSec >= 120 && paceSec <= 1800
		? ` · ${Math.floor(paceSec / 60)}:${String(paceSec % 60).padStart(2, "0")} /km` : "";
	return `${km < 10 ? km.toFixed(1) : Math.round(km)} km in ${time}${pace}`;
}

// How much one runner holds across the loaded tiles. A territory that
// crosses a tile edge is in both tiles, so each runId is counted once.
export function intvlOwnerStats(tiles, ownerKey) {
	const seen = new Set();
	let area = 0;
	if (ownerKey) for (const prepared of tiles) for (const layer of prepared) for (const f of layer.features) {
		if (intvlOwnerKey(f.props) !== ownerKey || seen.has(f.props.runId)) continue;
		seen.add(f.props.runId);
		area += Number(f.props.currentArea) || 0;
	}
	return { count: seen.size, area };
}

// Names of the runners a territory is shared with. The tile sends them as a
// JSON string of [userHash, name] pairs; anything else gives [].
export function intvlSharedNames(value) {
	if (typeof value !== "string" || !value) return [];
	let pairs;
	try { pairs = JSON.parse(value); } catch (_) { return []; }
	if (!Array.isArray(pairs)) return [];
	return pairs.map((p) => (Array.isArray(p) && typeof p[1] === "string" ? p[1].trim() : ""))
		.filter(Boolean).slice(0, 5);
}

// Hover/long-press content for one territory. `when` is ready-made HTML for
// the date line; everything from the tile is escaped here.
export function intvlTooltipHtml(props, opts) {
	const p = props || {}, o = opts || {};
	const swatch =
		`<span style="display:inline-block;width:10px;height:10px;` +
		`background:${_safeColor(p.colour, "#3b82f6")};border:1px solid #444;vertical-align:middle"></span>`;
	// A runner who chose to be anonymous is sent with no name at all.
	const name = typeof p.username === "string" && p.username.trim() ? p.username.trim() : "";
	const who = name || (p.anonymous ? "Anonymous runner" : "Unnamed runner");
	const level = Number.isFinite(p.level) && p.level > 0 ? `Level ${p.level}` : "";
	const city = typeof p.city === "string" && p.city.trim() ? p.city.trim() : "";
	const lines = [`${swatch} <b>${_escHtml(who)}</b>`];
	const about = [level, city].filter(Boolean).join(" · ");
	if (about) lines.push(`<span class="dw-cad-sub">${_escHtml(about)}</span>`);
	lines.push(`${_escHtml(intvlArea(p.currentArea))} territory`);
	const shared = intvlSharedNames(p.sharedUserHashes);
	if (shared.length) lines.push(`Shared with ${_escHtml(shared.join(", "))}`);
	const run = intvlRunLine(p);
	if (run) lines.push(_escHtml(run));
	if (o.when) lines.push(o.when);
	const st = o.stats;
	if (st && st.count > 1) {
		lines.push(`<span class="dw-cad-sub">Holds ${st.count} territories on this part of the map, ${_escHtml(intvlArea(st.area))} in all</span>`);
	}
	return lines.join("<br>");
}

// Runners ranked by territory area within `bounds` ({west,south,east,north})
// across the loaded tiles. A territory counts when its own bounding box
// meets the view; one crossing tile edges is counted once (by runId).
export function intvlLeaderboard(tiles, bounds, limit) {
	const b = bounds || {};
	const seen = new Set();
	const byOwner = new Map();
	for (const prepared of tiles || []) for (const layer of prepared) for (const f of layer.features) {
		const p = f.props || {};
		if (seen.has(p.runId)) continue;
		if ([p.minLng, p.minLat, p.maxLng, p.maxLat].every(Number.isFinite) &&
			(p.maxLng < b.west || p.minLng > b.east || p.maxLat < b.south || p.minLat > b.north)) continue;
		seen.add(p.runId);
		const key = intvlOwnerKey(p);
		if (!key) continue;
		let o = byOwner.get(key);
		if (!o) {
			const name = typeof p.username === "string" && p.username.trim() ? p.username.trim() : "";
			o = { key, name, anonymous: !name, colour: f.colour || p.colour, count: 0, area: 0, latest: 0 };
			byOwner.set(key, o);
		}
		o.count++;
		o.area += Number(p.currentArea) || 0;
		if (typeof p.startTime === "number" && p.startTime > o.latest) o.latest = p.startTime;
	}
	return [...byOwner.values()].sort((a, b2) => b2.area - a.area || b2.count - a.count).slice(0, limit || 10);
}

// The leaderboard panel's rows. `pinned` is the pinned runner's key.
export function intvlLeaderboardHtml(rows, pinned) {
	if (!rows.length) return `<div class="dw-intvl-lb-empty">No territories loaded here yet.</div>`;
	return rows.map((r, i) =>
		`<button type="button" class="dw-intvl-lb-row${r.key === pinned ? " dw-intvl-lb-row--pinned" : ""}" data-key="${_escHtml(r.key)}" title="${r.key === pinned ? "Unpin" : "Pin this runner's territory"}">` +
		`<span class="dw-intvl-lb-n">${i + 1}</span>` +
		`<span class="dw-intvl-lb-sw" style="background:${_safeColor(r.colour, "#3b82f6")}"></span>` +
		`<span class="dw-intvl-lb-name">${_escHtml(r.name || "Anonymous runner")}</span>` +
		`<span class="dw-intvl-lb-fig">${_escHtml(intvlArea(r.area))} · ${r.count}</span>` +
		`</button>`).join("");
}
