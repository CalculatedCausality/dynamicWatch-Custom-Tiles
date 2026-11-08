import { CFG } from "../config.js";
import { _vexcelTokenValid, vexcelChangeLogin, vexcelSignOut } from "../providers/vexcel-auth.js";

export const LOCAL_PREFERENCE_KEYS = [CFG.ARCHIVE_KEY, CFG.OVERLAY_STATE_KEY];
export const GM_PREFERENCE_DEFAULTS = {
	dw_collapsed_groups: "[]",
	[CFG.MODE_3D_STATE_KEY]: false,
	[CFG.ROUTE_POI_PREFS_KEY]: "{}",
	[CFG.SCC_APPS_STATE_KEY]: "{}",
};

const LOGIN_FAILURES = {
	badcreds: "Vexcel didn't accept that login. Check the email and password and try again.",
	unreadable: "That isn't a valid Vexcel token. Enter email:password, or paste a current token or URL.",
	neterr: "Couldn't reach Vexcel. Check your connection and try again.",
	cooldown: "Vexcel sign-in was just tried. Wait a few seconds and try again.",
};

// Only plain messages are retained; never serialize arbitrary objects or stacks.
export function redact(text) {
	return String(text ?? "")
		.replace(/\bhttps?:\/\/[^\s<>"']+/gi, (url) => url.split(/[?#]/)[0]
			.replace(/(https?:\/\/)[^/@]+@/i, "$1[private]@")
			.replace(/\/((?:plans?|routes?)\/)[^/]+/gi, "/$1[redacted]")
			.replace(/\/-?\d+(?:\.\d+)?(?=[/.]|$)/g, "/[number]"))
		.replace(/\b(?:eyJ[A-Za-z0-9_-]*|[A-Za-z0-9_-]{8,})\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[token]")
		.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
		.replace(/\b(?:password|passwd|username|authorization|cookie|session|token|plan[ _-]?id)\s*[:=]\s*[^\s,;]+/gi, "[private]")
		.replace(/\b\d+\s*\/?\s*(?:SP|RP|CP|BUP|GTP)\s*\d+\b/gi, "[plan]")
		.replace(/\b(?:lat(?:itude)?|lng|lon(?:gitude)?)\s*[=:]\s*[-+]?\d+(?:\.\d+)?/gi, "[coordinate]")
		.replace(/[-+]?\d{1,3}(?:\.\d+)?\s*[,/]\s*[-+]?\d{1,3}(?:\.\d+)?/g, "[coordinates]")
		.replace(/[A-Za-z0-9_+\/-]{24,}={0,2}/g, "[encoded]");
}

export function createLogBuffer() {
	const messages = [];
	return {
		add(level, args) {
			if (typeof args[0] !== "string" || !args[0].startsWith("[CustomTiles]")) return;
			const message = args.map((arg) => typeof arg === "string" || typeof arg === "number"
				? String(arg) : arg instanceof Error ? arg.message : "[object omitted]").join(" ");
			messages.push(`${level}: ${redact(message).slice(0, 2000)}`);
			if (messages.length > 20) messages.shift();
		},
		read() { return messages.slice(); },
	};
}

const consoleBuffers = new WeakMap();
export function captureUserscriptLogs(target) {
	if (consoleBuffers.has(target)) return consoleBuffers.get(target);
	const buffer = createLogBuffer();
	consoleBuffers.set(target, buffer);
	for (const level of ["warn", "error"]) {
		const original = target[level];
		target[level] = function (...args) {
			try { buffer.add(level, args); } catch (_) { /* Logging must never break the page. */ }
			return original.apply(this, args);
		};
	}
	return buffer;
}

// Explicit allowlist: even a snapshot containing secrets cannot serialize them.
export function buildDiagnostics(snapshot = {}) {
	const health = snapshot.health || {};
	return [
		`CustomTiles version: ${redact(snapshot.version || "?")}`,
		`Userscript manager: ${redact(snapshot.manager || "unknown")}`,
		`Browser: ${redact(snapshot.userAgent || "unknown")}`,
		`Active base: ${redact(snapshot.base || "unknown")}`,
		`Active overlays: ${(snapshot.overlays || []).map(redact).join(", ") || "none"}`,
		`3D mode: ${!!snapshot.mode3D}`,
		...['qldValid', 'appleValid', 'vexcelValid', 'loginStored', 'loginRejected']
			.map((key) => `${key}: ${!!health[key]}`),
		"Recent CustomTiles warnings/errors:",
		...(snapshot.logs || []).slice(-20).map(redact),
	].join("\n");
}

function showDiagnostics(win, text) {
	const doc = win.document;
	doc.getElementById("dw-diag-overlay")?.remove();
	if (!doc.getElementById("dw-diag-style")) {
		const style = doc.createElement("style");
		style.id = "dw-diag-style";
		style.textContent = "#dw-diag-overlay{position:fixed;inset:0;z-index:2147483647;background:#0009;display:grid;place-items:center}#dw-diag-overlay section{background:white;color:#222;padding:20px;width:min(760px,90vw);max-height:90vh;overflow:auto;border-radius:8px}#dw-diag-overlay textarea{width:100%;height:45vh;box-sizing:border-box}#dw-diag-overlay button,#dw-diag-overlay a{margin:8px}";
		(doc.head || doc.documentElement).appendChild(style);
	}
	const overlay = doc.createElement("div");
	overlay.id = "dw-diag-overlay";
	const panel = doc.createElement("section");
	panel.setAttribute("role", "dialog");
	panel.setAttribute("aria-modal", "true");
	panel.setAttribute("aria-label", "CustomTiles diagnostics");
	const heading = doc.createElement("h2");
	heading.textContent = "Diagnostics / report a problem";
	const textarea = doc.createElement("textarea");
	textarea.readOnly = true;
	textarea.setAttribute("aria-label", "Redacted diagnostic report");
	textarea.value = text;
	const copy = doc.createElement("button");
	copy.textContent = "Copy";
	const fallback = () => {
		textarea.focus(); textarea.select();
		try { copy.textContent = doc.execCommand("copy") ? "Copied" : "Select and copy manually"; }
		catch (_) { copy.textContent = "Select and copy manually"; }
	};
	copy.onclick = () => {
		try {
			if (!win.navigator.clipboard?.writeText) { fallback(); return; }
			win.navigator.clipboard.writeText(text).then(() => { copy.textContent = "Copied"; }, fallback);
		} catch (_) { fallback(); }
	};
	const close = doc.createElement("button");
	close.textContent = "Close";
	const previousFocus = doc.activeElement;
	close.onclick = () => { overlay.remove(); previousFocus?.focus(); };
	overlay.onkeydown = (event) => { if (event.key === "Escape") close.onclick(); };
	const link = doc.createElement("a");
	link.href = "https://github.com/CalculatedCausality/dynamicWatch-Custom-Tiles/issues/new";
	link.target = "_blank";
	link.rel = "noopener noreferrer";
	link.textContent = "Open a GitHub issue";
	panel.append(heading, textarea, copy, close, link);
	overlay.appendChild(panel);
	(doc.body || doc.documentElement).appendChild(overlay);
	textarea.focus(); textarea.select();
}

function defaultGm() {
	return {
		GM_registerMenuCommand: typeof GM_registerMenuCommand === "function" ? GM_registerMenuCommand : null,
		GM_getValue: typeof GM_getValue === "function" ? GM_getValue : (_, fallback) => fallback,
		GM_setValue: typeof GM_setValue === "function" ? GM_setValue : () => {},
		GM_info: typeof GM_info !== "undefined" ? GM_info : {},
	};
}

export function registerUserscriptMenu({ app, gm = defaultGm(), win = window }) {
	if (!/(^|\.)dynamic\.watch$/i.test(win.location.hostname)) return;
	const logs = captureUserscriptLogs(win.console);
	if (!gm.GM_registerMenuCommand) return;
	const register = (name, cb) => gm.GM_registerMenuCommand(name, cb);
	register("Vexcel: change login…", () => vexcelChangeLogin((ok, reason) => {
		if (ok) app?.layers?.[CFG.LAYER_VEXCEL]?._dwRefreshAuth?.();
		else if (reason && reason !== "cancelled") win.alert(LOGIN_FAILURES[reason] || LOGIN_FAILURES.badcreds);
	}));
	register("Vexcel: sign out on this device", () => {
		if (win.confirm("Sign out of Vexcel on this device and remove the saved login?")) vexcelSignOut(gm);
	});
	register("Reset layer & panel preferences", () => {
		if (!win.confirm("Reset CustomTiles layer and panel preferences? Saved logins and dynamic.watch data will not change.")) return;
		for (const key of LOCAL_PREFERENCE_KEYS) {
			try { win.localStorage.removeItem(key); } catch (_) {}
		}
		for (const [key, value] of Object.entries(GM_PREFERENCE_DEFAULTS)) gm.GM_setValue(key, value);
		if (win.confirm("Preferences reset. Reload this page now to apply them?")) win.location.reload();
	});
	register("Diagnostics / report a problem", () => {
		const ctrl = app?._ctrl;
		const active = (ctrl?._layers || []).filter((entry) => ctrl._map?.hasLayer(entry.layer));
		const get = (key, fallback = "") => gm.GM_getValue(key, fallback);
		const info = gm.GM_info || {};
		showDiagnostics(win, buildDiagnostics({
			version: info.script?.version,
			manager: [info.scriptHandler, info.version].filter(Boolean).join(" "),
			userAgent: win.navigator.userAgent,
			base: active.find((entry) => !entry.overlay)?.name,
			overlays: active.filter((entry) => entry.overlay).map((entry) => entry.name),
			mode3D: app?._mode3DController?.isActive(),
			health: {
				qldValid: app?.qldToken?.isValid(), appleValid: app?.appleToken?.isValid(),
				vexcelValid: _vexcelTokenValid(get(CFG.VEXCEL_TOKEN_KEY)),
				loginStored: !!(get(CFG.VEXCEL_USER_KEY) && get(CFG.VEXCEL_PASS_KEY)),
				loginRejected: !!get(CFG.VEXCEL_REJECTED_KEY, false),
			},
			logs: logs.read(),
		}));
	});
}
