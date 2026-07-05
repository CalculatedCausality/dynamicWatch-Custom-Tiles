export function gmGet(url, opts, cb) {
	if (typeof opts === "function") { cb = opts; opts = {}; }
	opts = opts || {};
	const handle = { aborted: false, _xhr: null };
	const req = GM_xmlhttpRequest({
		method: opts.method || "GET",
		url,
		headers: opts.headers || {},
		data: opts.data,
		responseType: opts.responseType,
		timeout: opts.timeout || 25000,
		anonymous: opts.anonymous === false ? false : true,
		onload: (r) => {
			if (handle.aborted) return;
			cb(null, r);
		},
		onerror: () => {
			if (handle.aborted) return;
			cb(new Error("network"), null);
		},
		ontimeout: () => {
			if (handle.aborted) return;
			cb(new Error("timeout"), null);
		},
	});
	handle._xhr = req;
	return handle;
}

export function gmJsonGet(url, opts, cb) {
	if (typeof opts === "function") { cb = opts; opts = {}; }
	opts = opts || {};
	const headers = Object.assign(
		{ Accept: "application/json" }, opts.headers || {},
	);
	return gmGet(url, Object.assign({}, opts, { headers }), (err, r) => {
		if (err) { cb(err, null, r); return; }
		if (r.status < 200 || r.status >= 300) {
			cb(new Error("http " + r.status), null, r);
			return;
		}
		try { cb(null, JSON.parse(r.responseText), r); }
		catch (e) { cb(new Error("parse: " + e.message), null, r); }
	});
}

export function gmCancel(handle) {
	if (!handle || handle.aborted) return;
	handle.aborted = true;
	if (handle._xhr && typeof handle._xhr.abort === "function") {
		try { handle._xhr.abort(); } catch (_) {}
	}
}

export function wireTileAbort(gridLayer) {
	gridLayer.on("tileunload", (e) => {
		const t = e.tile;
		if (!t) return;
		if (t._dwHandle) { gmCancel(t._dwHandle); t._dwHandle = null; }
		if (t._dwHandles) {
			for (const h of t._dwHandles) gmCancel(h);
			t._dwHandles = null;
		}
	});
}

const _gmInflight = new Map();

export function gmCoalesce(key, fn, cb) {
	const existing = _gmInflight.get(key);
	if (existing) { existing.push(cb); return; }
	const waiters = [cb];
	_gmInflight.set(key, waiters);
	fn((err, value) => {
		_gmInflight.delete(key);
		for (const w of waiters) {
			try { w(err, value); } catch (e) { console.error("[CustomTiles] cb error", e); }
		}
	});
}

export function cachedFetch(key, ttlMs, fetcher, cb) {
	const storageKey = "dw_cache_" + key;
	try {
		const raw = GM_getValue(storageKey, null);
		if (raw) {
			const parsed = JSON.parse(raw);
			if (parsed && (parsed.e === 0 || parsed.e > Date.now())) {
				cb(null, parsed.v);
				return;
			}
		}
	} catch (_) {}
	gmCoalesce(storageKey, fetcher, (err, value) => {
		if (!err && value !== undefined) {
			try {
				const expires = ttlMs > 0 ? Date.now() + ttlMs : 0;
				GM_setValue(storageKey, JSON.stringify({ v: value, e: expires }));
			} catch (_) {}
		}
		cb(err, value);
	});
}

export const _CACHE_TTL = {
	CAD_ADDRESS: 30 * 24 * 3600 * 1000,
	OTH_LOCATIONS:  7 * 24 * 3600 * 1000,
	OTH_PROPERTY:       6 * 3600 * 1000,
	OTH_EVENTS:        24 * 3600 * 1000,
	SCC_DETAIL:         6 * 3600 * 1000,
};
