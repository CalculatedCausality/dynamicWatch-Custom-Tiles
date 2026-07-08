// Tampermonkey polyfill — injected into the page BEFORE every navigation
// so that when we then inject the userscript itself, its `GM_*` calls
// land on real-looking implementations instead of `ReferenceError`s.
//
// The userscript also references `unsafeWindow` (its sandbox bridge to
// the page's `window`). Playwright runs JS directly in the page context,
// so `unsafeWindow === window` is the right alias.
//
// CORS: launch Chromium with `--disable-web-security` so GM_xmlhttpRequest
// (now a plain `fetch`) can reach all the cross-origin tile endpoints
// the script touches.
(() => {
	if (window.__dwTmShim) return;
	window.__dwTmShim = true;

	window.unsafeWindow = window;

	const STORE_PREFIX = "GM:";
	window.GM_getValue = (key, def) => {
		try {
			const raw = localStorage.getItem(STORE_PREFIX + key);
			if (raw == null) return def;
			return JSON.parse(raw);
		} catch (_) { return def; }
	};
	window.GM_setValue = (key, value) => {
		try { localStorage.setItem(STORE_PREFIX + key, JSON.stringify(value)); }
		catch (_) {}
	};
	window.GM_deleteValue = (key) => {
		try { localStorage.removeItem(STORE_PREFIX + key); } catch (_) {}
	};
	window.GM_listValues = () => {
		const out = [];
		for (let i = 0; i < localStorage.length; i++) {
			const k = localStorage.key(i);
			if (k && k.startsWith(STORE_PREFIX)) out.push(k.slice(STORE_PREFIX.length));
		}
		return out;
	};

	window.GM_addStyle = (css) => {
		const s = document.createElement("style");
		s.textContent = css;
		document.head.appendChild(s);
		return s;
	};

	window.GM_setClipboard = (text) => {
		try { navigator.clipboard?.writeText(text); } catch (_) {}
	};

	window.GM_openInTab = (url, opts) => {
		const w = window.open(url, "_blank");
		return w ? { close: () => w.close() } : null;
	};

	// GM_xmlhttpRequest → fetch. Browser-strips Origin header (can't be
	// set via fetch headers), so layers that depend on a spoofed Origin
	// (Stamen's `localhost` trick) won't work here — but every other
	// cross-origin endpoint will because we launched with disabled web
	// security. The script's existing fallbacks render those layers as
	// blank in 3D rather than crash, which is fine for verification.
	window.GM_xmlhttpRequest = (opts) => {
		// @connect audit. Real Tampermonkey BLOCKS (or prompts on) GM
		// requests to hosts not listed in the userscript's @connect
		// header — this fetch-backed shim doesn't, which let a missing
		// `@connect strava.com` slip through every harness run while
		// breaking in production. If the runner injected the parsed
		// @connect list (window.__dwConnectList), warn loudly on any
		// host that real Tampermonkey would have refused.
		try {
			const list = window.__dwConnectList;
			if (Array.isArray(list) && list.length) {
				const host = new URL(opts.url, location.href).hostname;
				const ok = list.some((d) => host === d || host.endsWith("." + d));
				if (!ok) {
					console.warn("[TM-shim] @connect VIOLATION: GM request to " +
						host + " — real Tampermonkey would block this");
					// When enforcing, actually refuse — so a diagnostic can
					// reproduce the real "blocked → feature fails" behaviour.
					if (window.__dwConnectEnforce) {
						if (typeof opts.onerror === "function") {
							opts.onerror({ error: "@connect blocked: " + host, status: 0 });
						}
						return { abort() {} };
					}
				}
			}
		} catch (_) {}
		const controller = new AbortController();
		const method = (opts.method || "GET").toUpperCase();
		const headers = {};
		for (const [k, v] of Object.entries(opts.headers || {})) {
			// Skip forbidden headers fetch can't set.
			if (/^(origin|referer|host|cookie|user-agent)$/i.test(k)) continue;
			headers[k] = v;
		}
		const init = {
			method,
			headers,
			body: opts.data,
			signal: controller.signal,
			credentials: opts.anonymous ? "omit" : "include",
		};
		fetch(opts.url, init).then(async (r) => {
			let response, responseText = "";
			const rt = (opts.responseType || "").toLowerCase();
			try {
				if (rt === "arraybuffer") response = await r.arrayBuffer();
				else if (rt === "blob")   response = await r.blob();
				else if (rt === "json")   response = await r.json();
				else { responseText = await r.text(); response = responseText; }
			} catch (e) {
				opts.onerror?.({ status: r.status, error: e.message });
				return;
			}
			opts.onload?.({
				status: r.status,
				statusText: r.statusText,
				response,
				responseText,
				responseHeaders: [...r.headers.entries()]
					.map(([k, v]) => `${k}: ${v}`).join("\r\n"),
				finalUrl: r.url,
			});
		}).catch((err) => {
			if (err?.name === "AbortError") {
				opts.onabort?.();
				return;
			}
			opts.onerror?.({ status: 0, error: err?.message || String(err) });
		});
		return { abort: () => controller.abort() };
	};

	window.GM_info = {
		script: { name: "dynamicwatch-custom-tiles (e2e)", version: "test" },
		scriptHandler: "Playwright shim",
		version: "test",
	};
})();
