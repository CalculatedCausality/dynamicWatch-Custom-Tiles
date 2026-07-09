import { dwMbGmFetchAB, dwRegisterMbLayer } from "../bridge/mapbox-tile-bridge.js";
import { BLANK_TILE, CFG } from "../config.js";
import { LayerProvider } from "../layers/provider-factories.js";
import { gmGet, gmJsonGet, wireTileAbort } from "../utils/http.js";

/* -- Vexcel high-res aerial (ANZ viewer WMTS) ---------------------------
 * api.vexcelgroup.com serves the "urban" ortho mosaic (7.5 cm class,
 * Sunshine Coast flown 2019+) through a standard WMTS discovered via
 * /v2/ortho/wmts GetCapabilities: EPSG:3857, levels 0-21, JPEG/PNG,
 * CORS *. getTile only needs the account JWT — the viewer's `session`
 * param is not required for tiles.
 *
 * The JWT expires ~24 h after login and there's no anonymous mint or
 * renew endpoint, so this follows the Waze manual-token pattern: the
 * user pastes any api.vexcelgroup.com request URL (or the bare token)
 * once per day when the layer asks; it's stored in GM until expiry.
 * The token is never baked into the script.
 */

// Accept a bare JWT, or any URL/curl blob containing token=<jwt>.
export function _vexcelParseToken(raw) {
	const s = String(raw || "").trim();
	const m =
		s.match(/token=([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/) ||
		s.match(/^([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/);
	return m ? m[1] : "";
}

// JWT payload `exp` (seconds) → epoch ms; 0 when undecodable.
export function _vexcelTokenExp(token) {
	try {
		const b64 = String(token).split(".")[1]
			.replace(/-/g, "+").replace(/_/g, "/");
		const payload = JSON.parse(atob(b64));
		return (Number(payload.exp) || 0) * 1000;
	} catch (_) { return 0; }
}

export function _vexcelTokenValid(token) {
	return !!token && _vexcelTokenExp(token) > Date.now() + 60 * 1000;
}

export function _vexcelTileTpl(token, session) {
	const base =
		CFG.VEXCEL_WMTS_BASE +
		"?service=wmts&request=getTile&layer=urban&Style=RGB" +
		"&TileMatrixSet=urban&TileMatrix={z}&TileRow={y}&TileCol={x}" +
		"&format=image/jpeg";
	// The imagery service needs BOTH the session (from configuration/init)
	// AND the JWT — verified: session-only → 403 Forbidden, token-only → 403
	// "Unauthorized by Service", session+token (with the viewer Origin) →
	// 200. The tiles also require an Origin header, so these URLs are fetched
	// via GM_xmlhttpRequest (blob-bridged), never as plain <img> src.
	return session
		? base + "&session=" + encodeURIComponent(session) +
			"&token=" + encodeURIComponent(token)
		: base + "&token=" + encodeURIComponent(token);
}

/* -- Oblique / directional views ---------------------------------------
 * The ortho WMTS is locked to the current-best mosaic on this account
 * (collection/date params ignored; layer=<collection> → 403). But the
 * OBLIQUE photography is per-capture and reachable token-only:
 *   POST /v2/oriented/query → every (direction × capture) at a point
 *   GET  /v2/oriented/tile?downsample=&tile-x=&tile-y=&image-name=…
 *        → 256px JPEG tiles (CORS *), so the oblique loads progressively
 *        in chunks and pans/zooms as a Leaflet image pyramid.
 * So directional N/E/S/W views AND date selection live here, mirroring
 * the Vexcel viewer's oblique panel.
 */

// product-type → compass label. Vexcel names an oblique by the side it
// looks toward; the viewer surfaces these as N/E/S/W.
export const VEXCEL_DIRECTIONS = [
	{ key: "oblique-north", label: "N" },
	{ key: "oblique-east",  label: "E" },
	{ key: "oblique-south", label: "S" },
	{ key: "oblique-west",  label: "W" },
	{ key: "nadir",         label: "Top" },
];

// collection id → capture year for the date picker (au-qld-...-2019 →
// "2019", au-qld-...r2-2021 → "2021"). Falls back to the raw id.
export function _vexcelCollectionYear(collection) {
	const m = String(collection || "").match(/(\d{4})(?!.*\d{4})/);
	return m ? m[1] : String(collection || "");
}

// Band of an image from its name suffix — Vexcel serves each frame as
// `..._rgb` (true colour) and sometimes `..._irg` (near-infrared, false-
// colour: vegetation reads bright red). Only nadir has IR on SCC.
export function _vexcelBand(name) {
	return /_irg$/i.test(String(name || "")) ? "irg" : "rgb";
}

// oriented/query FeatureCollection → { directions, captures, images }.
// images is keyed "<product-type>@<collection>" → { rgb?, irg? }, each
// { name, layer, w, h, corners } for the first (best) photo in that
// cell+band; captures is the distinct collection list newest-first.
export function _vexcelParseObliques(data) {
	const images = {};
	const captureMeta = new Map(); // collection → { year, date }
	const dirSet = new Set();
	for (const f of (data && Array.isArray(data.features) ? data.features : [])) {
		const p = f.properties || {};
		const dir = p["product-type"];
		const coll = p.collection;
		const name = p["image-name"];
		if (!dir || !coll || !name) continue;
		const key = dir + "@" + coll;
		const band = _vexcelBand(name);
		if (!images[key]) images[key] = {};
		if (!images[key][band]) {
			images[key][band] = {
				name,
				layer: p["source-layer"] || p.layer || "urban",
				w: Number(p["raster-size-width"]) || 0,
				h: Number(p["raster-size-height"]) || 0,
				corners: _vexcelFootprint(f.geometry),
			};
		}
		if (!captureMeta.has(coll)) {
			// capture-date like "2019-11-29T04:23:00" → "2019-11-29".
			const date = String(p["capture-date"] || "").slice(0, 10) ||
				_vexcelCollectionYear(coll);
			captureMeta.set(coll, { year: _vexcelCollectionYear(coll), date });
		}
		dirSet.add(dir);
	}
	const captures = [...captureMeta.entries()]
		.map(([collection, meta]) => ({ collection, year: meta.year, date: meta.date }))
		.sort((a, b) => b.date.localeCompare(a.date));
	const directions = VEXCEL_DIRECTIONS.filter((d) => dirSet.has(d.key));
	return { images, captures, directions };
}

export function _vexcelObliqueExtractUrl(imageName, layer, lat, lng, token) {
	if (!imageName || !_vexcelTokenValid(token)) return "";
	const wkt = `POINT(${Number(lng)} ${Number(lat)})`;
	return (
		CFG.VEXCEL_API_BASE + "/v2/oriented/extract?" +
		"wkt=" + encodeURIComponent(wkt) +
		"&srid=4326&layer=" + encodeURIComponent(layer || "urban") +
		"&image-name=" + encodeURIComponent(imageName) +
		"&token=" + encodeURIComponent(token)
	);
}

// Tile-pyramid base for an oblique — /v2/oriented/tile serves 256px JPEG
// tiles, so the oblique loads progressively in chunks (pan/zoom) instead of
// one giant image. Needs session+token (and, on the wire, the viewer Origin
// header — added by the GM fetch), so tiles are GM-fetched + blob-bridged.
// downsample/tile-x/tile-y are appended per tile.
export function _vexcelObliqueTileBase(imageName, layer, token, session) {
	if (!imageName || !_vexcelTokenValid(token)) return "";
	return (
		CFG.VEXCEL_API_BASE + "/v2/oriented/tile?layer=" +
		encodeURIComponent(layer || "urban") +
		"&image-name=" + encodeURIComponent(imageName) +
		(session ? "&session=" + encodeURIComponent(session) : "") +
		"&token=" + encodeURIComponent(token)
	);
}

// Deepest downsample level (whole image ≈ one 256px tile). Leaflet zoom
// z maps to downsample = maxDownsample - z.
export function _vexcelMaxDownsample(w, h) {
	const px = Math.max(Number(w) || 256, Number(h) || 256);
	return Math.max(0, Math.ceil(Math.log2(px / 256)));
}

/* -- Frame footprint ↔ image-pixel mapping (continuous panning) --------
 * Each oblique is one aerial photo; to pan CONTINUOUSLY across the
 * survey we map the current view's pixel position to a ground point via
 * the frame's footprint, then load the neighbouring frame there. The
 * footprint is a quad (TL,TR,BR,BL matching image corners
 * [0,0],[w,0],[w,h],[0,h]); a bilinear map is enough (frames are ~nadir-
 * aligned, kappa≈0) and needs no matrix solve.
 */
export function _vexcelFootprint(geometry) {
	const ring = geometry && geometry.coordinates && geometry.coordinates[0];
	if (!Array.isArray(ring) || ring.length < 4) return null;
	// Drop the closing point if present; keep TL,TR,BR,BL.
	const c = ring.slice(0, 4).map((p) => [Number(p[0]), Number(p[1])]);
	return c.every((p) => isFinite(p[0]) && isFinite(p[1])) ? c : null;
}

// (u,v) in the unit square (u:0=left→1=right, v:0=top→1=bottom) → ground
// [lng,lat] via bilinear interpolation of the footprint corners.
export function _vexcelBilinear(corners, u, v) {
	const a = (1 - u) * (1 - v), b = u * (1 - v), d = u * v, e = (1 - u) * v;
	return [
		a * corners[0][0] + b * corners[1][0] + d * corners[2][0] + e * corners[3][0],
		a * corners[0][1] + b * corners[1][1] + d * corners[2][1] + e * corners[3][1],
	];
}

// Inverse: ground [lng,lat] → (u,v). Newton iteration from the centre
// (the map is close to affine, so this converges in a few steps).
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

function _getStoredToken() {
	try { return GM_getValue(CFG.VEXCEL_TOKEN_KEY, "") || ""; }
	catch (_) { return ""; }
}

function _storeToken(t) {
	try { GM_setValue(CFG.VEXCEL_TOKEN_KEY, t); } catch (_) {}
}

/* -- Session (the viewer's proper tile credential) ---------------------
 * The official viewer doesn't just use the JWT: after login it POSTs
 * /api/viewer/configuration/init and, on accounts that are entitled that
 * way, gets back a `session` it appends to tile requests. The init call is
 * gated by hash = sha256(`${APP_NAME}_${timestamp}`) — reverse-engineered
 * from the viewer bundle, no secret salt. We reproduce that flow so tiles
 * carry whatever credential the account actually issues; accounts that
 * return session:null (this one currently) transparently use the JWT.
 * The session is bound to the token it was minted with, so a token refresh
 * re-mints it and we never re-POST init for an unchanged token.
 */
function _vexcelTokKey(token) { return String(token || "").split(".")[2] || ""; }

function _getStoredSession() {
	try {
		const o = JSON.parse(GM_getValue(CFG.VEXCEL_SESSION_KEY, "") || "null");
		return (o && o.s) || "";
	} catch (_) { return ""; }
}

function _sessionMintedFor(token) {
	try {
		const o = JSON.parse(GM_getValue(CFG.VEXCEL_SESSION_KEY, "") || "null");
		return !!o && o.k === _vexcelTokKey(token);
	} catch (_) { return false; }
}

function _storeSession(session, token) {
	try {
		GM_setValue(CFG.VEXCEL_SESSION_KEY,
			JSON.stringify({ s: session || "", k: _vexcelTokKey(token) }));
	} catch (_) {}
}

// Drop the cached session so the next _ensureSession re-mints one (used when
// tiles are refused — the session can expire while the JWT is still valid).
function _clearSession() {
	try { GM_setValue(CFG.VEXCEL_SESSION_KEY, ""); } catch (_) {}
}

// sha256 hex of a string via WebCrypto (dynamic.watch is a secure context),
// matching the viewer's hashCode(). cb("") on any failure.
function _vexcelHashCode(str, cb) {
	try {
		const bytes = new TextEncoder().encode(String(str));
		crypto.subtle.digest("SHA-256", bytes).then(
			(buf) => cb(Array.from(new Uint8Array(buf))
				.map((b) => b.toString(16).padStart(2, "0")).join("")),
			() => cb(""),
		);
	} catch (_) { cb(""); }
}

// Exchange a valid JWT for the viewer `session` via configuration/init.
// cb(session) — "" when the account issues none (then the JWT is used).
function _vexcelInitSession(token, cb) {
	cb = cb || function () {};
	if (!_vexcelTokenValid(token)) { cb(""); return; }
	const ts = (typeof Date !== "undefined" && Date.now) ? Date.now() : 0;
	_vexcelHashCode(CFG.VEXCEL_APP_NAME + "_" + ts, (hash) => {
		if (!hash) { cb(""); return; }
		gmJsonGet(
			CFG.VEXCEL_INIT_URL + "?token=" + encodeURIComponent(token),
			{
				method: "POST",
				data: "hash=" + hash + "&timestamp=" + ts +
					"&app=" + encodeURIComponent(CFG.VEXCEL_APP_NAME),
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					"X-App-Key": CFG.VEXCEL_APP_HDR,
					// REQUIRED: without the viewer Origin, init returns
					// session:null (the account looks unentitled). With it, a
					// real session is minted. GM_xmlhttpRequest can set Origin;
					// a page <fetch> can't.
					"Origin": CFG.VEXCEL_SPOOF_ORIGIN,
					"Referer": CFG.VEXCEL_SPOOF_ORIGIN + "/",
				},
			},
			(err, data) => {
				const s = data && (data.session ||
					(data.data && data.data.session));
				cb(s ? String(s) : "");
			},
		);
	});
}

// Ensure a session exists for the current token, minting it once. Runs
// init at most once per token (result — real session or "" — is cached
// bound to the token), so activation/tileerror paths can call it freely.
// Always resolves; the token remains the fallback credential.
function _ensureSession(token, cb) {
	cb = cb || function () {};
	if (!_vexcelTokenValid(token)) { cb(""); return; }
	if (_sessionMintedFor(token)) { cb(_getStoredSession()); return; }
	_vexcelInitSession(token, (s) => { _storeSession(s, token); cb(s); });
}

// Every Vexcel imagery service (ortho + oriented) gates on the ANZ-viewer
// Origin header AND session+token on the query string — verified: drop any
// one → 403. These headers ride on all GM imagery requests.
function _vexcelOriginHeaders(extra) {
	return Object.assign({
		Origin: CFG.VEXCEL_SPOOF_ORIGIN,
		Referer: CFG.VEXCEL_SPOOF_ORIGIN + "/",
	}, extra || {});
}

// Resolve BOTH a valid token and its session for the async oblique paths.
// cb(token, session) — token valid + session (may be ""); cb(null) if none.
function _ensureQueryAuth(cb) {
	_ensureTokenSilent((tok) => {
		if (!_vexcelTokenValid(tok)) { cb(null); return; }
		_ensureSession(tok, (sess) => cb(tok, sess || ""));
	});
}

// Baked-in Vexcel account — the default used when the user hasn't pasted
// their own creds/token. Requested to be embedded so the Vexcel base "just
// works" with no prompt. WARNING: this is a plaintext password shipped in
// the script — anyone with the built userscript (or this repo's history)
// can read it. Do NOT push this to a public remote; rotate the password if
// it leaks. Anything the user pastes (creds or a one-off token) still wins.
const VEXCEL_BAKED_USER = "szxc61qc8@mozmail.com";
const VEXCEL_BAKED_PASS = "4Bp6GoxdPzaZLAfhj@";

// Credentials for silent daily token refresh. Prefer GM-stored (whatever the
// user pasted on THIS device); fall back to the baked-in account above.
function _getStoredCreds() {
	try {
		return {
			user: GM_getValue(CFG.VEXCEL_USER_KEY, "") || VEXCEL_BAKED_USER,
			pass: GM_getValue(CFG.VEXCEL_PASS_KEY, "") || VEXCEL_BAKED_PASS,
		};
	} catch (_) { return { user: VEXCEL_BAKED_USER, pass: VEXCEL_BAKED_PASS }; }
}

function _storeCreds(user, pass) {
	try {
		GM_setValue(CFG.VEXCEL_USER_KEY, user || "");
		GM_setValue(CFG.VEXCEL_PASS_KEY, pass || "");
	} catch (_) {}
}

function _hasCreds() { const c = _getStoredCreds(); return !!(c.user && c.pass); }

// Detect a "user:password" login string vs a pasted token/URL. Creds =
// has a colon, an "@" in the part before it, and isn't an http(s) URL.
export function _vexcelIsCredString(s) {
	s = String(s || "").trim();
	const i = s.indexOf(":");
	return i > 0 && s.slice(0, i).indexOf("@") > 0 && !/^https?:/i.test(s);
}

// Exchange stored credentials for a fresh JWT. Guards against the two
// ways this could hammer the auth endpoint (→ account lockout): an
// in-flight coalescer (parallel 403s share one login) and a 15 s
// cooldown (sequential retries back off). Bad creds are CLEARED so we
// fall back to prompting instead of looping. cb(token|null, reason).
let _loginInFlight = null;
let _loginCooldownUntil = 0;
export function _vexcelLogin(cb) {
	cb = cb || function () {};
	const creds = _getStoredCreds();
	if (!creds.user || !creds.pass) { cb(null, "nocreds"); return; }
	if (_loginInFlight) { _loginInFlight.push(cb); return; }
	const now = (typeof Date !== "undefined" && Date.now) ? Date.now() : 0;
	if (now && now < _loginCooldownUntil) { cb(null, "cooldown"); return; }
	_loginCooldownUntil = now + 15000;
	_loginInFlight = [cb];
	const done = (tok, reason) => {
		const waiters = _loginInFlight; _loginInFlight = null;
		for (const w of waiters) { try { w(tok, reason); } catch (_) {} }
	};
	gmJsonGet(
		CFG.VEXCEL_ADMIN_BASE + "/api/auth/authenticate",
		{
			method: "POST",
			data: JSON.stringify({
				username: creds.user, password: creds.pass,
				application: CFG.VEXCEL_APP_KEY,
			}),
			headers: {
				"Content-Type": "application/json",
				"X-App-Key": CFG.VEXCEL_APP_HDR,
			},
		},
		(err, data, raw) => {
			const status = raw ? raw.status : 0;
			// Rejected credentials — drop them so we don't retry into a
			// lockout; the caller then prompts for fresh ones.
			if (status === 401 || status === 403) {
				_storeCreds("", ""); done(null, "badcreds"); return;
			}
			if (err || !data) { done(null, "neterr"); return; } // transient
			const tok = data.data && data.data.token;
			if (!_vexcelTokenValid(tok)) {
				_storeCreds("", ""); done(null, "badcreds"); return;
			}
			_storeToken(tok);
			_loginCooldownUntil = 0; // success unblocks retries immediately
			done(tok, null);
		},
	);
}

// Get a usable token WITHOUT ever prompting: valid stored token, else a
// silent auto-login with stored creds, else null. Used by the async
// query/frame paths so they self-heal when the basemap path re-auths.
function _ensureTokenSilent(cb) {
	const tok = _getStoredToken();
	if (_vexcelTokenValid(tok)) { cb(tok); return; }
	if (_hasCreds()) { _vexcelLogin((t) => cb(t || null)); return; }
	cb(null);
}

// Get a usable token, prompting the user as a last resort. Prefers a
// silent auto-login; only prompts when there are no creds or they were
// rejected. Transient failures stay silent (retry on the next event).
function _ensureAuthedToken(lead, cb) {
	const tok = _getStoredToken();
	if (_vexcelTokenValid(tok)) { cb(tok); return; }
	if (_hasCreds()) {
		_vexcelLogin((newTok, reason) => {
			if (newTok) { cb(newTok); return; }
			if (reason === "neterr" || reason === "cooldown") { cb(null, reason); return; }
			_promptForVexcelAuth(lead, (t2) => cb(t2 || null));
		});
		return;
	}
	_promptForVexcelAuth(lead, (t2) => cb(t2 || null));
}

// One prompt that accepts EITHER "email:password" (stored for silent
// daily refresh, then logged in) OR a pasted token/URL (one-off). Async
// because the credential path performs a network login. cb(token|null).
function _promptForVexcelAuth(lead, cb) {
	cb = cb || function () {};
	const raw = window.prompt(
		(lead || "Vexcel Aerial sign-in.") + "\n\n" +
		"Enter your Vexcel login as  email:password  — stored on THIS device " +
		"only and used to auto-refresh the daily token.\n\n" +
		"…or paste a one-off api.vexcelgroup.com token/URL instead " +
		"(log in at " + CFG.VEXCEL_VIEWER_URL + ").",
		"",
	);
	if (raw == null) { cb(null); return; } // cancelled — don't nag this add
	const s = raw.trim();
	if (_vexcelIsCredString(s)) {
		const i = s.indexOf(":");
		_storeCreds(s.slice(0, i).trim(), s.slice(i + 1).trim());
		_vexcelLogin((tok) => cb(_vexcelTokenValid(tok) ? tok : null));
		return;
	}
	const tok = _vexcelParseToken(s);
	if (tok) _storeToken(tok);
	cb(_vexcelTokenValid(tok) ? tok : null);
}

// Back-compat shim: some call sites still expect a synchronous
// token-only prompt. Kept for the frame/query fallbacks.
function _promptForToken(lead) {
	const raw = window.prompt(
		(lead || "Vexcel Aerial needs a fresh token (they expire daily).") + "\n\n" +
		"1. Log in at " + CFG.VEXCEL_VIEWER_URL + "\n" +
		"2. DevTools → Network → copy any api.vexcelgroup.com request URL\n" +
		"3. Paste it here (the whole URL is fine):",
		"",
	);
	if (raw == null) return ""; // cancelled — don't nag again this add
	const tok = _vexcelParseToken(raw);
	if (tok) _storeToken(tok);
	return tok;
}

// Fetch every oblique/nadir capture available at a point (token-only,
// not rate-limited — this is the metadata query, not the image pull).
// Queries both programs (wide-area + urban) so rural/edge points that
// only have wide-area coverage still resolve.
export function fetchVexcelObliques(lat, lng, cb) {
	_ensureQueryAuth((token, session) => {
		if (!token) { cb(null); return; }
		_fetchVexcelObliques(lat, lng, token, session, cb);
	});
}
function _fetchVexcelObliques(lat, lng, token, session, cb) {
	if (!_vexcelTokenValid(token)) { cb(null); return; }
	gmJsonGet(
		CFG.VEXCEL_API_BASE + "/v2/oriented/query?session=" +
			encodeURIComponent(session) + "&token=" + encodeURIComponent(token),
		{
			method: "POST",
			data: JSON.stringify({
				wkt: `POINT(${Number(lng)} ${Number(lat)})`,
				srid: "4326",
				layer: "wide-area,urban",
				// Both bands (rgb + irg) so the viewer can offer an IR
				// toggle; parse buckets them by the image-name suffix.
				// image-center-distance-asc → the first image per cell is
				// the one whose frame is centred nearest the clicked point,
				// so the user's spot sits near the middle of the oblique.
				"order-by": "image-center-distance-asc",
				include: "collection,capture-date,product-type,image-name," +
					"source-layer,raster-size-width,raster-size-height,geometry",
			}),
			headers: _vexcelOriginHeaders({ "Content-Type": "application/json" }),
		},
		(err, data, raw) => {
			// 401/403 = token rejected server-side despite a valid expiry
			// (quota/revoked). Do NOT clear the token here — `_ensureTokenSilent`
			// already refreshed an EXPIRED one, so a 403 means quota-capped,
			// and clearing would just make the basemap re-mint in a loop.
			// Report "auth" so the caller can show a message; the basemap's
			// give-up logic owns stopping the retries.
			if (raw && (raw.status === 401 || raw.status === 403)) {
				cb(null, "auth"); return;
			}
			if (err || !data) { cb(null); return; }
			const parsed = _vexcelParseObliques(data);
			cb(parsed.directions.length ? parsed : null);
		},
	);
}

function _dirLabel(key) {
	const d = VEXCEL_DIRECTIONS.find((x) => x.key === key);
	return d ? d.label : key;
}

// Fetch the single best-centred frame for a direction+collection at a
// ground point — used while panning to pull the ADJACENT frame as the
// view crosses the current frame's edge.
export function fetchVexcelFrame(lng, lat, collection, dir, band, cb) {
	_ensureQueryAuth((token, session) => {
		if (!token) { cb(null); return; }
		_fetchVexcelFrame(lng, lat, collection, dir, band, token, session, cb);
	});
}
function _fetchVexcelFrame(lng, lat, collection, dir, band, token, session, cb) {
	if (!_vexcelTokenValid(token)) { cb(null); return; }
	gmJsonGet(
		CFG.VEXCEL_API_BASE + "/v2/oriented/query?session=" +
			encodeURIComponent(session) + "&token=" + encodeURIComponent(token),
		{
			method: "POST",
			data: JSON.stringify({
				wkt: `POINT(${Number(lng)} ${Number(lat)})`,
				srid: "4326", layer: "wide-area,urban",
				collection, "product-type": dir, bands: band || "rgb",
				"order-by": "image-center-distance-asc", "total-records": 1,
				include: "image-name,source-layer,raster-size-width," +
					"raster-size-height,geometry",
			}),
			headers: _vexcelOriginHeaders({ "Content-Type": "application/json" }),
		},
		(err, data) => {
			const f = !err && data && Array.isArray(data.features) && data.features[0];
			if (!f) { cb(null); return; }
			const p = f.properties || {};
			cb({
				name: p["image-name"], layer: p["source-layer"] || "urban",
				w: Number(p["raster-size-width"]) || 0,
				h: Number(p["raster-size-height"]) || 0,
				corners: _vexcelFootprint(f.geometry),
			});
		},
	);
}

/* -- Vexcel imagery compass (docked, layer-attached) ------------------
 * A passive button compass shown whenever the Vexcel base is active —
 * the counterpart to the QLD Historical compass. A compass rose of
 * direction buttons (N top, E right, S bottom, W left, ⊙ centre =
 * straight-down nadir) plus a capture-DATE SLIDER (older ⇢ newer).
 *
 * It does NOT auto-fetch on pan — that caused a "No imagery" flicker
 * whenever the map centre drifted over an uncovered gap. Instead it
 * just sits there; clicking a direction queries the captures at the
 * current centre on demand and loads that stitched oblique into an
 * expanding panel (extract is a heavy, rate-limited stitch). The flat
 * ortho basemap stays current-best (a tier lock); date + angle drive
 * the panel — "⊙" is the closest thing to dated 2D (nadir).
 */
let _vexCtl = null;
let _vexLayer = null; // the base tile layer, so the control can drive date/band

// Flat-ortho capture dates at a point, newest-first — drives the date slider.
// Uses /v2/ortho/collections (final-ortho product), which lists every
// collection covering the point; the year is derived from the collection id.
export function fetchVexcelOrthoDates(lat, lng, cb) {
	_ensureQueryAuth((token, session) => {
		if (!token) { cb(null); return; }
		gmJsonGet(
			CFG.VEXCEL_API_BASE + "/v2/ortho/collections?wkt=" +
				encodeURIComponent(`POINT(${Number(lng)} ${Number(lat)})`) +
				"&srid=4326&layer=urban,wide-area&session=" +
				encodeURIComponent(session) + "&token=" + encodeURIComponent(token),
			{ headers: _vexcelOriginHeaders() },
			(err, data, raw) => {
				if (raw && (raw.status === 401 || raw.status === 403)) { cb(null, "auth"); return; }
				if (err || !data || !Array.isArray(data.features)) { cb(null); return; }
				const seen = new Set(), caps = [];
				for (const f of data.features) {
					const c = f.properties && f.properties.collection;
					if (!c || seen.has(c)) continue;
					seen.add(c);
					caps.push({ collection: c, year: _vexcelCollectionYear(c) });
				}
				// Newest first (year desc); the slider's index 0 = current-best.
				caps.sort((a, b) => String(b.year).localeCompare(String(a.year)));
				cb(caps.length ? caps : null);
			},
		);
	});
}

export function createVexcelControl() {
	if (_vexCtl) return _vexCtl;
	// A tiny docked control for the flat Vexcel base: an infrared toggle,
	// nothing more. Capture DATES ride the app's shared history bar via the
	// adapter below (getCaptureCount/…/setCapture + "capturechange") — the
	// same bar Wayback and QLD Historical use — so Vexcel behaves like a
	// normal dated base map: no compass, no full-map overlay. (The angled
	// oblique viewer was removed; obliques are perspective photos that can't
	// be reprojected onto the flat map, so they don't belong here.)
	const el = document.createElement("div");
	el.className = "dw-vex-ctl";
	el.innerHTML =
		'<button type="button" class="dw-vex-ir" title="Toggle near-infrared (vegetation shows red)">IR</button>' +
		'<div class="dw-vex-basemsg" style="display:none"></div>';
	L.DomEvent.disableClickPropagation(el);
	L.DomEvent.disableScrollPropagation(el);

	const listeners = {};
	const ctl = {
		el, _map: null,
		lat: 0, lng: 0, atKey: "",
		captures: [],   // [{collection, year}] newest-first
		capIdx: 0,
		band: "rgb",    // "rgb" | "irg" (near-infrared)
		queried: false, // has the dates query at the current point resolved?
		gen: 0,
		on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); return ctl; },
		off(ev, fn) { listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn); return ctl; },
		_fire(ev) { for (const f of listeners[ev] || []) { try { f(); } catch (_) {} } },
		// Surface a base-layer status note under the IR button (e.g. account
		// refused / no coverage). Empty/falsy hides it.
		setBaseMsg(text) {
			const n = el.querySelector(".dw-vex-basemsg");
			if (!n) return;
			n.textContent = text || "";
			n.style.display = text ? "block" : "none";
		},
	};
	const irBtn = el.querySelector(".dw-vex-ir");

	const updateIrBtn = () => {
		if (irBtn) irBtn.classList.toggle("dw-vex-ir--on", ctl.band === "irg");
	};
	// IR works at every date on the flat ortho (&bands=irg), so it's always
	// enabled; toggling swaps the base layer's band and repaints in place.
	if (irBtn) irBtn.addEventListener("click", () => {
		ctl.band = ctl.band === "irg" ? "rgb" : "irg";
		if (_vexLayer && _vexLayer._dwSetBand) _vexLayer._dwSetBand(ctl.band);
		updateIrBtn();
	});

	// -- history-bar adapter (capture dates) --------------------------
	ctl.getCaptureCount = () => ctl.captures.length;
	ctl.getCaptureIdx   = () => ctl.capIdx;
	// "loading" until the first query resolves, then "ready" (has dates) or
	// "empty" — so the bar stops spinning "Loading…" where there's no cover.
	ctl.getCaptureState = () =>
		!ctl.queried ? "loading" : (ctl.captures.length ? "ready" : "empty");
	ctl.getCaptureDate  = (i) => (ctl.captures[i] ? ctl.captures[i].year : "");
	ctl.setCapture = (i) => {
		ctl.capIdx = i;
		const cap = ctl.captures[i];
		// index 0 = newest = current-best; pass "" so the tile URL omits
		// order-by (identical bytes, one fewer param). Other indices scrub to
		// that collection's capture date.
		if (_vexLayer && _vexLayer._dwSetCollection) {
			_vexLayer._dwSetCollection(i === 0 ? "" : (cap ? cap.collection : ""));
		}
	};

	// Query the capture dates available at the current map centre and refresh
	// the date bar. Cheap + un-throttled, so safe to run on every settle.
	let refreshTimer = null;
	const refreshCaptures = () => {
		if (!ctl._map) return;
		const c = ctl._map.getCenter();
		const key = c.lat.toFixed(4) + "," + c.lng.toFixed(4);
		if (ctl.atKey === key) return;
		ctl.lat = c.lat; ctl.lng = c.lng; ctl.atKey = key;
		if (!_vexcelTokenValid(_getStoredToken()) && !_hasCreds()) {
			ctl.captures = []; ctl.queried = true; ctl._fire("capturechange"); return;
		}
		ctl.queried = false; ctl._fire("capturechange"); // show "Loading…" in flight
		const gen = ++ctl.gen;
		fetchVexcelOrthoDates(ctl.lat, ctl.lng, (caps) => {
			if (gen !== ctl.gen) return;
			ctl.captures = caps || [];
			ctl.queried = true;
			if (ctl.capIdx >= ctl.captures.length) ctl.capIdx = 0;
			ctl._fire("capturechange"); // history bar re-reads count/idx/label
		});
	};
	const scheduleRefresh = () => {
		clearTimeout(refreshTimer);
		refreshTimer = setTimeout(refreshCaptures, 500);
	};

	ctl.addTo = (m) => {
		if (ctl._map) return ctl;
		ctl._map = m;
		m.getContainer().appendChild(el);
		m.on("moveend", scheduleRefresh);
		updateIrBtn();
		refreshCaptures();
		return ctl;
	};
	ctl.remove = () => {
		if (!ctl._map) return ctl;
		ctl._map.off("moveend", scheduleRefresh);
		clearTimeout(refreshTimer);
		ctl.gen++;
		if (el.parentNode) el.parentNode.removeChild(el);
		ctl._map = null;
		return ctl;
	};
	_vexCtl = ctl;
	return ctl;
}

// True when a fresh-enough token exists.
export function vexcelHasToken() {
	return _vexcelTokenValid(_getStoredToken());
}

export class VexcelLayerProvider extends LayerProvider {
	create() {
		const spoofOrigin = CFG.VEXCEL_SPOOF_ORIGIN;
		// The imagery service requires the ANZ-viewer Origin header AND both
		// the session + JWT on the query string. An <img> tile can send
		// neither a spoofed Origin nor be gated behind an async session, so
		// tiles are GM-fetched (which CAN set Origin) and blob-bridged, the
		// same pattern Stamen/QLD-Historical use.
		const tileHeaders = {
			Origin: spoofOrigin,
			Referer: spoofOrigin + "/",
			Accept: "image/jpeg,image/*,*/*;q=0.8",
		};
		// Concrete per-tile URL on the viewer's world-layer /ortho/tile
		// endpoint (256px, same tiles as wmts but — unlike wmts — it honours
		// date + band params). "" until a session exists (then the layer
		// redraws), so we never fire a doomed token-only request.
		//   layer._dwVexColl : ""=newest, else order-by that collection (date)
		//   layer._dwVexBand : "rgb" | "irg" (near-infrared, &bands=irg)
		const tileUrl = (z, x, y) => {
			const tok = _getStoredToken(), sess = _getStoredSession();
			if (!_vexcelTokenValid(tok) || !sess) return "";
			let u = CFG.VEXCEL_API_BASE + "/v2/ortho/tile?zoom=" + z +
				"&tile-x=" + x + "&tile-y=" + y +
				"&interpolation=true&layer=urban,wide-area" +
				"&session=" + encodeURIComponent(sess) +
				"&token=" + encodeURIComponent(tok);
			if (layer._dwVexColl) {
				u += "&order-by=" + encodeURIComponent(layer._dwVexColl) +
					",collection-last-capture-date-desc";
			}
			if (layer._dwVexBand === "irg") u += "&bands=irg";
			return u;
		};

		const VexGrid = L.GridLayer.extend({
			createTile(coords, done) {
				const img = document.createElement("img");
				img.setAttribute("role", "presentation");
				const url = tileUrl(coords.z, coords.x, coords.y);
				// Given up, or creds not minted yet → blank (a redraw after
				// auth repaints). data: src so it "loads" without erroring.
				if (this._dwAuthGaveUp || !url) {
					img.src = BLANK_TILE;
					setTimeout(() => done(null, img), 0);
					return img;
				}
				img._dwHandle = gmGet(url, {
					responseType: "arraybuffer", headers: tileHeaders,
				}, (err, r) => {
					img._dwHandle = null;
					if (err) { done(new Error("Vexcel " + err.message), img); return; }
					// 404 = outside flown coverage → blank, NOT an error (so a
					// pan over a gap doesn't look like an auth failure). Only
					// 401/403 (session/token refused) trips the burst.
					if (r.status === 404) { img.src = BLANK_TILE; done(null, img); return; }
					if (r.status !== 200) { done(new Error("Vexcel HTTP " + r.status), img); return; }
					const blob = new Blob([r.response], { type: "image/jpeg" });
					const objUrl = URL.createObjectURL(blob);
					img.onload = () => { URL.revokeObjectURL(objUrl); done(null, img); };
					img.onerror = () => {
						URL.revokeObjectURL(objUrl);
						done(new Error("Vexcel decode failed"), img);
					};
					img.src = objUrl;
				});
				return img;
			},
		});

		const layer = new VexGrid({
			tileSize: 256,
			maxNativeZoom: 21,
			maxZoom: 25,
			attribution:
				'&copy; <a href="https://www.vexcelgroup.com/" target="_blank"' +
				' rel="noreferrer">Vexcel Imaging</a>',
		});
		wireTileAbort(layer);
		// Date (collection) + band state, driven by the docked control. ""
		// collection = current-best (newest); a set collection scrubs to that
		// capture date. Setters redraw only on a real change.
		layer._dwVexColl = "";
		layer._dwVexBand = "rgb";
		layer._dwSetCollection = (c) => {
			if ((c || "") === layer._dwVexColl) return;
			layer._dwVexColl = c || "";
			layer.redraw();
		};
		layer._dwSetBand = (b) => {
			if (b !== layer._dwVexBand) { layer._dwVexBand = b; layer.redraw(); }
		};
		_vexLayer = layer; // so the control can drive date/band

		// Auth happens when the base is SELECTED, not at boot — a page-load
		// prompt would be obnoxious and the token may have rotated. Mint the
		// session (once per token, via configuration/init with the Origin
		// header) then redraw so tiles carry session+token.
		layer.on("add", (e) => {
			layer._dwAuthTries = 0; // fresh activation → allow re-auth
			layer._dwAuthGaveUp = false;
			const ready = (tok) => {
				if (!_vexcelTokenValid(tok)) return;
				_ensureSession(tok, () => layer.redraw());
			};
			const cur = _getStoredToken();
			if (_vexcelTokenValid(cur)) ready(cur);
			else _ensureAuthedToken(undefined, ready); // silent auto-login / prompt
			// Show the docked IR toggle (dates ride the shared history bar).
			const map = e && e.target && e.target._map;
			if (map) createVexcelControl().addTo(map);
		});
		layer.on("remove", () => {
			if (_vexCtl) _vexCtl.remove();
		});
		// A real (blob:) tile painted ⇒ session+token+account are all fine →
		// re-arm re-auth and clear any notice. Ignore data: blanks (coverage
		// gaps / not-yet-authed), else the give-up counter would reset on
		// every blank and the storm would never converge.
		layer.on("tileload", (e) => {
			const src = (e && e.tile && e.tile.src) || "";
			if (src.slice(0, 5) === "data:") return; // blank fallback, not a real paint
			layer._dwAuthTries = 0;
			layer._dwAuthGaveUp = false;
			if (_vexCtl && _vexCtl.setBaseMsg) _vexCtl.setBaseMsg("");
		});
		// A BURST of tile errors = the session/token was refused (out-of-
		// coverage 404s blank instead of erroring, so they don't count).
		// Escalate cheaply: (0) the session may have expired while the JWT is
		// still valid → re-mint it via init; (1) the JWT itself is bad →
		// re-auth from creds/prompt + re-mint; (2) give up (account refused /
		// no coverage) — blank and stop, re-armed only by a real paint or a
		// base re-toggle. This bounds logins (≤1 extra) so we never storm.
		let errBurst = 0, errTimer = null;
		layer.on("tileerror", () => {
			if (!layer._map || layer._dwReprompt || layer._dwAuthGaveUp) return;
			errBurst++;
			clearTimeout(errTimer);
			errTimer = setTimeout(() => { errBurst = 0; }, 3000);
			if (errBurst < 6) return;
			errBurst = 0;
			layer._dwReprompt = true;
			const tok = _getStoredToken();
			if (layer._dwAuthTries === 0 && _vexcelTokenValid(tok)) {
				layer._dwAuthTries = 1;
				_clearSession(); // force a fresh session for the same JWT
				_ensureSession(tok, () => { layer._dwReprompt = false; layer.redraw(); });
				return;
			}
			if (layer._dwAuthTries === 1) {
				layer._dwAuthTries = 2;
				_storeToken(""); _clearSession(); // drop both, re-auth from scratch
				_ensureAuthedToken(
					"Vexcel refused the current session (expired or usage limit).",
					(t) => {
						layer._dwReprompt = false;
						if (_vexcelTokenValid(t)) {
							_ensureSession(t, () => layer.redraw());
							if (_vexCtl) { _vexCtl.atKey = ""; } // force a re-query
						} else {
							layer._dwAuthGaveUp = true; layer.redraw();
						}
					},
				);
				return;
			}
			// Re-minted the session AND re-authed and STILL refused → the
			// account/session is refused here or there's no coverage. Stop.
			layer._dwReprompt = false;
			layer._dwAuthGaveUp = true;
			layer.redraw();
			if (_vexCtl && _vexCtl.setBaseMsg) {
				_vexCtl.setBaseMsg(
					"No Vexcel imagery loaded here — either this area isn't " +
					"covered, or the account/session was refused. Try another " +
					"area, or reselect the base.");
			}
			console.warn("[CustomTiles] Vexcel: session+token still refused after " +
				"re-auth — no coverage or account refused; stopping retries.");
		});
		// 3D: the Mapbox raster source can't send a spoofed Origin either, so
		// register the same GM-fetch bridge (dw:// / transformRequest) 2D
		// uses. NO _dwMb3DGetUrl — that path would emit a plain raster URL
		// with no Origin header and 401.
		dwRegisterMbLayer(layer, (z, x, y) => new Promise((resolve, reject) => {
			// Self-heal: mint the session here too (cached), so 3D works even
			// if it activates before the 2D `add` minted it.
			const tok = _getStoredToken();
			if (!_vexcelTokenValid(tok)) { reject(new Error("Vexcel: no token")); return; }
			_ensureSession(tok, () => {
				const url = tileUrl(z, x, y);
				if (!url) { reject(new Error("Vexcel: no session")); return; }
				dwMbGmFetchAB(url, { headers: tileHeaders }).then(resolve, reject);
			});
		}));
		return layer;
	}
}
