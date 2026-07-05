// Waze georss token plumbing.
//
// Waze gates /live-map/api/georss behind reCAPTCHA Enterprise — every
// request needs an `X-Recaptcha-Token` header. The live-map bundle mints
// it with:
//
//   grecaptcha.enterprise.execute(SITE_KEY, { action: "api" })
//
// and attaches the returned string as `X-Recaptcha-Token`. The legacy
// token-free `rtserver/web/TGeoRSS` endpoint is gone.
//
// reCAPTCHA Enterprise embeds the *minting page's hostname* in the token,
// and Waze's backend can reject a token minted on a foreign origin. So we
// don't mint on dynamic.watch directly — we mint inside a hidden
// `embed.waze.com/iframe`:
//
//   - embed.waze.com serves the official embeddable live-map widget. It
//     ships NO X-Frame-Options and no CSP frame-ancestors, so
//     dynamic.watch is allowed to frame it (unlike www.waze.com, which is
//     X-Frame-Options: SAMEORIGIN). It loads the same grecaptcha site key
//     and calls the same georss endpoint, so tokens minted there are
//     exactly what georss accepts.
//   - Our userscript also @matches embed.waze.com/*, so it boots INSIDE
//     that iframe (see isWazeTokenFrame / startWazeTokenBroker), mints a
//     token in the embed.waze.com origin, and publishes it to shared
//     GM storage.
//   - The dynamic.watch side (getWazeToken) reads that shared token —
//     Tampermonkey GM_getValue/GM_setValue storage is shared across every
//     tab/frame the script runs in — and sends it on the georss request
//     via GM_xmlhttpRequest (which isn't bound by the page's origin).
//
// Fallbacks, in order: a token pasted into GM_setValue("dw_waze_token_
// manual", "<token>") wins outright; if the broker never publishes, we
// fall back to minting on the current page (may be origin-rejected).

// Public site key scraped from https://www.waze.com/live-map and
// https://embed.waze.com/iframe (enterprise.js?render=…). Not a secret.
export const WAZE_RECAPTCHA_SITE_KEY = "6Lf4WdUqAAAAAEUYUvzyLYIkO3PoFAqi8ZHGiDLW";
const WAZE_RECAPTCHA_ACTION = "api";

const SHARED_KEY = "dw_waze_token_shared";
const MANUAL_KEY = "dw_waze_token_manual";
// The broker re-mints on this cadence so the published token is always
// fresh (reCAPTCHA tokens are short-lived).
const BROKER_REMINT_MS = 75 * 1000;
// How stale a shared token may be before the consumer stops trusting it.
const SHARED_MAX_AGE_MS = 3 * 60 * 1000;
// Hidden broker frame. Location is irrelevant to token minting.
const EMBED_URL = "https://embed.waze.com/iframe?zoom=12&lat=0&lon=0";

const pageWin = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;

// ------------------------------------------------------------------
// Broker side — runs inside the embed.waze.com iframe.
// ------------------------------------------------------------------

// True when this script instance is executing inside an embed.waze.com
// document (the token-minting frame), not the dynamic.watch app.
export function isWazeTokenFrame() {
	try { return location.hostname === "embed.waze.com"; }
	catch (_) { return false; }
}

// Mint one token from the page's own grecaptcha (the embed widget loads
// it). Resolves to the token string, or null if grecaptcha isn't ready
// or execute() rejects.
function mintFromPage() {
	return new Promise((resolve) => {
		const g = pageWin.grecaptcha && pageWin.grecaptcha.enterprise;
		if (!g || typeof g.execute !== "function") { resolve(null); return; }
		try {
			g.ready(() => {
				try {
					g.execute(WAZE_RECAPTCHA_SITE_KEY,
						{ action: WAZE_RECAPTCHA_ACTION })
						.then((t) => resolve(t || null), () => resolve(null));
				} catch (_) { resolve(null); }
			});
		} catch (_) { resolve(null); }
	});
}

function publishToken(token) {
	if (!token) return;
	try {
		GM_setValue(SHARED_KEY, JSON.stringify({ token, ts: Date.now() }));
	} catch (_) {}
}

// Wait for the embed page's grecaptcha to load, then mint-and-publish on
// a timer so the shared token never goes stale. Idempotent.
export function startWazeTokenBroker() {
	if (startWazeTokenBroker._started) return;
	startWazeTokenBroker._started = true;
	let tries = 0;
	const kick = () => {
		const g = pageWin.grecaptcha && pageWin.grecaptcha.enterprise;
		if (g && typeof g.execute === "function") {
			const cycle = () => mintFromPage().then(publishToken);
			cycle();
			setInterval(cycle, BROKER_REMINT_MS);
			return;
		}
		// grecaptcha injects async; poll up to ~60s before giving up.
		if (tries++ < 120) setTimeout(kick, 500);
		else console.warn("[CustomTiles] Waze embed grecaptcha never appeared");
	};
	kick();
}

// ------------------------------------------------------------------
// Consumer side — runs on dynamic.watch.
// ------------------------------------------------------------------

let _iframe = null;
let _directMintPromise = null;
let _directGrecaptcha = null;

// Create the hidden embed.waze.com broker frame once. Lazy — only called
// when the Waze layer actually needs a token.
function ensureBrokerFrame() {
	if (_iframe || isWazeTokenFrame()) return;
	if (document.getElementById("dw-waze-token-frame")) { _iframe = true; return; }
	try {
		const f = document.createElement("iframe");
		f.id = "dw-waze-token-frame";
		f.setAttribute("aria-hidden", "true");
		f.setAttribute("tabindex", "-1");
		f.style.cssText =
			"position:absolute;left:-9999px;top:-9999px;width:1px;height:1px;" +
			"border:0;opacity:0;pointer-events:none;visibility:hidden;";
		f.src = EMBED_URL;
		(document.body || document.documentElement).appendChild(f);
		_iframe = f;
	} catch (e) {
		console.warn("[CustomTiles] Waze token iframe failed:", e.message);
	}
}

function readSharedToken() {
	try {
		const raw = GM_getValue(SHARED_KEY, "");
		if (!raw) return null;
		const o = JSON.parse(raw);
		if (o && o.token && (Date.now() - o.ts) < SHARED_MAX_AGE_MS) {
			return o.token;
		}
	} catch (_) {}
	return null;
}

// Last-ditch: mint on the current (dynamic.watch) page. May be rejected
// by Waze if the site key is domain-locked, but costs nothing to try.
function directMint() {
	try {
		const manual = GM_getValue(MANUAL_KEY, "");
		if (manual) return Promise.resolve(String(manual));
	} catch (_) {}
	if (_directGrecaptcha && _directGrecaptcha.enterprise) {
		return _directGrecaptcha.enterprise
			.execute(WAZE_RECAPTCHA_SITE_KEY, { action: WAZE_RECAPTCHA_ACTION })
			.then((t) => t || null, () => null);
	}
	if (!_directMintPromise) {
		_directMintPromise = new Promise((resolve, reject) => {
			if (pageWin.grecaptcha && pageWin.grecaptcha.enterprise) {
				resolve(pageWin.grecaptcha); return;
			}
			const existing = document.getElementById("dw-waze-recaptcha");
			if (existing) {
				existing.addEventListener("load",
					() => resolve(pageWin.grecaptcha), { once: true });
				return;
			}
			const s = document.createElement("script");
			s.id = "dw-waze-recaptcha";
			s.src = "https://www.google.com/recaptcha/enterprise.js?render=" +
				WAZE_RECAPTCHA_SITE_KEY;
			s.async = true;
			s.onload = () => resolve(pageWin.grecaptcha);
			s.onerror = () => reject(new Error("recaptcha load failed"));
			(document.head || document.documentElement).appendChild(s);
		}).catch(() => null);
	}
	return _directMintPromise.then((gr) => {
		if (!gr || !gr.enterprise) return null;
		_directGrecaptcha = gr;
		return new Promise((resolve) => {
			try {
				gr.enterprise.ready(() => {
					gr.enterprise
						.execute(WAZE_RECAPTCHA_SITE_KEY,
							{ action: WAZE_RECAPTCHA_ACTION })
						.then((t) => resolve(t || null), () => resolve(null));
				});
			} catch (_) { resolve(null); }
		});
	});
}

// Resolve with a usable X-Recaptcha-Token, or null if none can be
// obtained. Callers MUST handle null (skip the poll) — Waze answers 403
// without a valid token.
export function getWazeToken() {
	// Manual override always wins.
	try {
		const manual = GM_getValue(MANUAL_KEY, "");
		if (manual) return Promise.resolve(String(manual));
	} catch (_) {}

	const cached = readSharedToken();
	if (cached) return Promise.resolve(cached);

	// Spin up the broker frame and wait briefly for it to publish.
	ensureBrokerFrame();
	return new Promise((resolve) => {
		let waited = 0;
		const iv = setInterval(() => {
			const t = readSharedToken();
			if (t) { clearInterval(iv); resolve(t); return; }
			waited += 500;
			if (waited >= 15000) {
				clearInterval(iv);
				// Broker didn't deliver — try minting here as a fallback.
				directMint().then(resolve, () => resolve(null));
			}
		}, 500);
	});
}
