import { CFG } from "../config.js";
import { gmJsonGet } from "../utils/http.js";

/* -- Vexcel authentication and viewer sessions -------------------------
 * This module owns credential/token persistence, login coalescing, session
 * minting, and the headers required by every Vexcel request. Keeping this
 * state shared prevents parallel imagery paths from starting duplicate logins.
 */

// Accept a bare JWT, or any URL/curl blob containing token=<jwt>.
export function _vexcelParseToken(raw) {
	const s = String(raw || "").trim();
	const m =
		s.match(/token=([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/) ||
		s.match(/^([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/);
	return m ? m[1] : "";
}

// JWT payload `exp` (seconds) -> epoch ms; 0 when undecodable.
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

export function _getStoredToken() {
	try { return GM_getValue(CFG.VEXCEL_TOKEN_KEY, "") || ""; }
	catch (_) { return ""; }
}

export function _storeToken(t) {
	try {
		const previous = GM_getValue(CFG.VEXCEL_TOKEN_KEY, "") || "";
		GM_setValue(CFG.VEXCEL_TOKEN_KEY, t);
		if (_vexcelTokKey(previous) !== _vexcelTokKey(t)) {
			GM_setValue(CFG.VEXCEL_SESSION_KEY, "");
		}
	} catch (_) {}
}

/* -- Session (the viewer's proper tile credential) ---------------------
 * The official viewer doesn't just use the JWT: after login it POSTs
 * /api/viewer/configuration/init and, on accounts that are entitled that
 * way, gets back a `session` it appends to tile requests. The init call is
 * gated by hash = sha256(`${APP_NAME}_${timestamp}`) -- reverse-engineered
 * from the viewer bundle, no secret salt. We reproduce that flow so tiles
 * carry whatever credential the account actually issues; accounts that
 * return session:null (this one currently) transparently use the JWT.
 * The session is bound to the token it was minted with, so a token refresh
 * re-mints it and we never re-POST init for an unchanged token.
 */
function _vexcelTokKey(token) { return String(token || "").split(".")[2] || ""; }

export function _getStoredSession() {
	try {
		const o = JSON.parse(GM_getValue(CFG.VEXCEL_SESSION_KEY, "") || "null");
		return o && o.k === _vexcelTokKey(_getStoredToken()) ? (o.s || "") : "";
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

// Drop the cached session so the next _ensureSession re-mints one.
export function _clearSession() {
	try { GM_setValue(CFG.VEXCEL_SESSION_KEY, ""); } catch (_) {}
}

// sha256 hex via WebCrypto, matching the viewer's hashCode().
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
function _vexcelInitSession(token, cb) {
	cb = cb || function () {};
	if (!_vexcelTokenValid(token)) { cb("", false); return; }
	const ts = (typeof Date !== "undefined" && Date.now) ? Date.now() : 0;
	_vexcelHashCode(CFG.VEXCEL_APP_NAME + "_" + ts, (hash) => {
		if (!hash) { cb("", false); return; }
		gmJsonGet(
			CFG.VEXCEL_INIT_URL + "?token=" + encodeURIComponent(token),
			{
				method: "POST",
				data: "hash=" + hash + "&timestamp=" + ts +
					"&app=" + encodeURIComponent(CFG.VEXCEL_APP_NAME),
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					"X-App-Key": CFG.VEXCEL_APP_HDR,
					Origin: CFG.VEXCEL_SPOOF_ORIGIN,
					Referer: CFG.VEXCEL_SPOOF_ORIGIN + "/",
				},
			},
			(err, data) => {
				if (err || !data) { cb("", false); return; }
				const s = data && (data.session || (data.data && data.data.session));
				cb(s ? String(s) : "", true);
			},
		);
	});
}

// Ensure the current token has a cached session. Always resolves.
const _sessionFlights = new Map();
export function _ensureSession(token, cb) {
	cb = cb || function () {};
	if (!_vexcelTokenValid(token)) { cb(""); return; }
	if (_sessionMintedFor(token)) { cb(_getStoredSession()); return; }
	if (_sessionFlights.has(token)) {
		_sessionFlights.get(token).push(cb);
		return;
	}
	_sessionFlights.set(token, [cb]);
	_vexcelInitSession(token, (s, succeeded) => {
		const current = _getStoredToken() === token;
		if (succeeded && current) _storeSession(s, token);
		const waiters = _sessionFlights.get(token) || [];
		_sessionFlights.delete(token);
		for (const waiter of waiters) waiter(succeeded && current ? s : "");
	});
}

// Every Vexcel request must look as though it came from the ANZ viewer.
export function _vexcelOriginHeaders(extra) {
	return Object.assign({
		Origin: CFG.VEXCEL_SPOOF_ORIGIN,
		Referer: CFG.VEXCEL_SPOOF_ORIGIN + "/",
		"X-App-Key": CFG.VEXCEL_APP_HDR,
	}, extra || {});
}

// Baked-in account used only when this device has no stored credentials.
// These values are shipped in plaintext and must be rotated if exposed.
const VEXCEL_BAKED_USER = "szxc61qc8@mozmail.com";
const VEXCEL_BAKED_PASS = "4Bp6GoxdPzaZLAfhj@";

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

export function _hasCreds() {
	const c = _getStoredCreds();
	return !!(c.user && c.pass);
}

// Detect a "user:password" login string vs a pasted token/URL.
export function _vexcelIsCredString(s) {
	s = String(s || "").trim();
	const i = s.indexOf(":");
	return i > 0 && s.slice(0, i).indexOf("@") > 0 && !/^https?:/i.test(s);
}

// Parallel login attempts share one request, and retries observe a cooldown.
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
		const waiters = _loginInFlight;
		_loginInFlight = null;
		for (const w of waiters) { try { w(tok, reason); } catch (_) {} }
	};
	const acceptToken = (tok) => {
		if (!_vexcelTokenValid(tok)) return false;
		_storeToken(tok);
		_loginCooldownUntil = 0;
		done(tok, null);
		return true;
	};
	gmJsonGet(
		CFG.VEXCEL_ADMIN_BASE + "/api/auth/authenticate",
		{
			method: "POST",
			data: JSON.stringify({
				username: creds.user,
				password: creds.pass,
				application: CFG.VEXCEL_APP_KEY,
			}),
			headers: {
				"Content-Type": "application/json",
				"X-App-Key": CFG.VEXCEL_APP_HDR,
			},
		},
		(err, data, raw) => {
			const status = raw ? raw.status : 0;
			if (status === 401 || status === 403) {
				_storeCreds("", "");
				done(null, "badcreds");
				return;
			}
			if (err || !data) { done(null, "neterr"); return; }
			const tok = data.data && data.data.token;
			if (!acceptToken(tok)) {
				_storeCreds("", "");
				done(null, "badcreds");
			}
		},
	);
}

// Get a usable token without prompting.
function _ensureTokenSilent(cb) {
	const tok = _getStoredToken();
	if (_vexcelTokenValid(tok)) { cb(tok); return; }
	if (_hasCreds()) { _vexcelLogin((t) => cb(t || null)); return; }
	cb(null);
}

// Resolve a valid token and its session for metadata and oblique requests.
export function _ensureQueryAuth(cb) {
	const resolve = () => _ensureTokenSilent((tok) => {
		if (!_vexcelTokenValid(tok)) { cb(null); return; }
		_ensureSession(tok, (sess) => {
			if (_getStoredToken() !== tok) { resolve(); return; }
			cb(tok, sess || "");
		});
	});
	resolve();
}

// Get a usable token, prompting only when silent authentication cannot.
export function _ensureAuthedToken(lead, cb) {
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

// Accept either stored credentials or a one-off token in one prompt.
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
	if (raw == null) { cb(null); return; }
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

export function vexcelHasToken() {
	return _vexcelTokenValid(_getStoredToken());
}
