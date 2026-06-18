import { CFG } from "./config.js";
import { gmGet, gmJsonGet } from "./utils/http.js";

export class TokenManagerBase {
	constructor(opts) {
		opts = opts || {};
		this._label = opts.label || "Token";
		this._refreshMargin = opts.refreshMarginMs || CFG.REFRESH_MARGIN;
		this.expires = 0;
		this.fetching = false;
		this.pending = [];
		this.refreshScheduled = false;
		this.retryCount = 0;
		this.onRefresh = null;
	}

	isValid() { return false; }
	_cached() { return []; }
	_fetch(done) { done(new Error(`${this._label} _fetch() not implemented`)); }

	get(cb) {
		if (this.isValid()) {
			cb(null, ...this._cached());
			return;
		}
		this.pending.push(cb);
		if (this.fetching) return;
		this.fetching = true;
		this._fetch((err, ...result) => {
			this.fetching = false;
			const cbs = this.pending.splice(0);
			cbs.forEach((fn) => fn(err, ...result));
			if (!err) {
				this.retryCount = 0;
				this.scheduleRefresh();
			} else if (!this.refreshScheduled) {
				const delay = Math.min(
					CFG.RETRY_DELAY * Math.pow(2, this.retryCount),
					CFG.RETRY_MAX_DELAY,
				);
				this.retryCount++;
				setTimeout(() => this.scheduleRefresh(), delay);
			}
		});
	}

	scheduleRefresh() {
		if (this.refreshScheduled) return;
		this.refreshScheduled = true;
		const wait = Math.min(
			2147483647,
			Math.max(30000, this.expires - Date.now() - this._refreshMargin),
		);
		setTimeout(() => {
			this.refreshScheduled = false;
			this._fetch((err, ...result) => {
				if (err) {
					const delay = Math.min(
						CFG.RETRY_DELAY * Math.pow(2, this.retryCount),
						CFG.RETRY_MAX_DELAY,
					);
					this.retryCount++;
					console.warn(
						`[CustomTiles] ${this._label} token refresh failed:`,
						err.message,
						"- retry in",
						Math.round(delay / 60000),
						"min",
					);
					setTimeout(() => this.scheduleRefresh(), delay);
					return;
				}
				this.retryCount = 0;
				if (this.onRefresh) this.onRefresh(...result);
				this.scheduleRefresh();
			});
		}, wait);
	}
}

export class QldTokenManager extends TokenManagerBase {
	constructor(opts) {
		opts = opts || {};
		super({ label: opts.label || "QLD" });
		this._serviceUrl = opts.serviceUrl || CFG.QLD_SERVICE;
		this._storageKey = opts.storageKey || "qld_token";
		this.token = GM_getValue(this._storageKey, null);
		this.expires = GM_getValue(this._storageKey + "_expires", 0);
	}

	isValid() {
		return !!(this.token && this.expires - Date.now() > CFG.REFRESH_MARGIN);
	}

	_cached() { return [this.token]; }

	save(token, expiresMs) {
		this.token = token;
		this.expires = expiresMs;
		GM_setValue(this._storageKey, token);
		GM_setValue(this._storageKey + "_expires", expiresMs);
	}

	_fetch(done) {
		gmGet(CFG.QLD_ORIGIN + "/", {
			anonymous: false,
			headers: {
				Accept: "text/html,*/*;q=0.8",
				"Accept-Language": "en-US,en;q=0.9",
				Origin: CFG.QLD_ORIGIN,
				Referer: CFG.QLD_ORIGIN + "/",
			},
		}, (err, r) => {
			if (err) {
				done(new Error(
					`[${this._label}] GET qldglobe.information.qld.gov.au failed`));
				return;
			}
			const csrf =
				QldTokenManager._xsrfFromSetCookie(r.responseHeaders) ||
				QldTokenManager._csrfFromHtml(r.responseText);
			if (!csrf) {
				done(new Error(
					`[${this._label}] CSRF token not found in Set-Cookie or HTML`));
				return;
			}
			this._doPost(csrf, done);
		});
	}

	_doPost(csrf, done) {
		gmJsonGet(CFG.QLD_TOKEN_EP, {
			method: "POST",
			anonymous: false,
			headers: {
				"Content-Type": "application/json",
				"X-Requested-With": "XMLHttpRequest",
				Origin: CFG.QLD_ORIGIN,
				Referer: CFG.QLD_ORIGIN + "/",
			},
			data: JSON.stringify({
				url: this._serviceUrl,
				location: {
					href: CFG.QLD_ORIGIN + "/",
					origin: CFG.QLD_ORIGIN,
					protocol: "https:",
					host: "qldglobe.information.qld.gov.au",
					hostname: "qldglobe.information.qld.gov.au",
					port: "",
					pathname: "/",
					search: "",
					hash: "",
					ancestorOrigins: {},
				},
				_csrf: csrf,
			}),
		}, (err, data, raw) => {
			if (err) {
				const tail = raw && raw.responseText
					? `: ${raw.responseText.slice(0, 160)}` : "";
				done(new Error(`[${this._label}] Token endpoint ${err.message}${tail}`), null);
				return;
			}
			if (!data.token) {
				done(new Error(`[${this._label}] Parse error: No token field in response`), null);
				return;
			}
			const exp = data.expires
				? data.expires > 1e12 ? data.expires : data.expires * 1000
				: Date.now() + CFG.DEFAULT_TTL;
			this.save(data.token, exp);
			console.info(
				`[CustomTiles] ${this._label} token acquired, expires`,
				new Date(exp).toISOString(),
			);
			done(null, data.token);
		});
	}

	static _xsrfFromSetCookie(rawHeaders) {
		if (!rawHeaders) return null;
		for (const line of rawHeaders.split(/\r?\n/)) {
			if (/^set-cookie\s*:/i.test(line)) {
				const pair = line.replace(/^set-cookie\s*:\s*/i, "").split(";")[0];
				const eq = pair.indexOf("=");
				if (eq > -1 && pair.slice(0, eq).trim() === "XSRF-TOKEN") {
					return decodeURIComponent(pair.slice(eq + 1).trim());
				}
			}
		}
		return null;
	}

	static _csrfFromHtml(html) {
		const patterns = [
			/<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)["']/i,
			/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']csrf-token["']/i,
			/window\._csrf\s*=\s*["']([^"']+)["']/,
			/['"_]csrf['"]\s*:\s*["']([^"']{20,80})["']/,
			/csrfToken\s*:\s*["']([^"']{20,80})["']/,
			/<input[^>]+name=["']_csrf["'][^>]+value=["']([^"']+)["']/i,
			/<input[^>]+value=["']([^"']+)["'][^>]+name=["']_csrf["']/i,
		];
		for (const p of patterns) {
			const m = html.match(p);
			if (m) return m[1];
		}
		return null;
	}
}

export class AppleTokenManager extends TokenManagerBase {
	constructor() {
		super({ label: "Apple" });
		this.accessKey = GM_getValue("apple_accesskey", null);
		this.version = GM_getValue("apple_version", CFG.APPLE_DEFAULT_V);
		this.expires = GM_getValue("apple_accesskey_expires", 0);
	}

	isValid() {
		return !!(
			this.accessKey && this.expires - Date.now() > CFG.REFRESH_MARGIN
		);
	}

	_cached() { return [this.accessKey, this.version]; }

	save(accessKey, version, expiresMs) {
		this.accessKey = accessKey;
		this.version = version || this.version;
		this.expires = expiresMs;
		GM_setValue("apple_accesskey", accessKey);
		GM_setValue("apple_version", this.version);
		GM_setValue("apple_accesskey_expires", expiresMs);
	}

	_fetch(done) {
		gmGet(CFG.APPLE_DDG_TOKEN_URL, {
			headers: {
				Accept: "*/*",
				Referer: CFG.APPLE_DDG_ORIGIN + "/",
			},
		}, (err, r) => {
			if (err || r.status < 200 || r.status >= 300) {
				done(new Error("[Apple] DDG token HTTP " + (r ? r.status : "network")));
				return;
			}
			const jwt = (r.responseText || "").trim();
			if (!/^[\w-]+\.[\w-]+\.[\w-]+$/.test(jwt)) {
				done(new Error("[Apple] DDG returned invalid JWT"));
				return;
			}
			this._doBootstrap(jwt, done);
		});
	}

	_doBootstrap(jwt, done) {
		gmGet(CFG.APPLE_BOOTSTRAP_URL, {
			headers: {
				Accept: "*/*",
				Authorization: "Bearer " + jwt,
				Origin: CFG.APPLE_DDG_ORIGIN,
				Referer: CFG.APPLE_DDG_ORIGIN + "/",
			},
		}, (err, r) => {
			if (err) {
				done(new Error("[Apple] Bootstrap network error"));
				return;
			}
			if (r.status < 200 || r.status >= 300) {
				done(new Error(
					`[Apple] Bootstrap HTTP ${r.status}: ${r.responseText.slice(0, 160)}`));
				return;
			}
			try {
				const data = JSON.parse(r.responseText);
				if (!data.accessKey) throw new Error("No accessKey in bootstrap response");
				const vMatch = r.responseText.match(/[?&]v=(\d+)/);
				const version = vMatch ? vMatch[1] : this.version;
				const exp = Date.now() + CFG.APPLE_TOKEN_TTL;
				this.save(data.accessKey, version, exp);
				console.info(
					"[CustomTiles] Apple accessKey acquired, v=" + version +
						", expires", new Date(exp).toISOString(),
				);
				done(null, data.accessKey, version);
			} catch (e) {
				done(new Error("[Apple] Bootstrap parse: " + e.message));
			}
		});
	}
}
