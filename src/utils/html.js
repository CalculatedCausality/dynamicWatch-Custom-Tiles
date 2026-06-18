export function _escHtml(s) {
	return String(s == null ? "" : s)
		.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

// Tagged template that HTML-escapes EVERY interpolation while leaving
// the literal markup untouched: esc`<b>${name}</b>` is safe even when
// `name` is attacker-controlled. Use for tooltip/popup HTML built from
// upstream strings; Leaflet injects those strings through innerHTML.
export function esc(strings, ...values) {
	let out = strings[0];
	for (let i = 0; i < values.length; i++) {
		out += _escHtml(values[i]) + strings[i + 1];
	}
	return out;
}

// Return `c` only if it's a syntactically safe CSS colour (#hex,
// rgb/rgba/hsl, or a CSS named colour), otherwise use a fallback.
export function _safeColor(c, fallback) {
	fallback = fallback || "#888";
	if (typeof c !== "string") return fallback;
	const s = c.trim();
	return /^#[0-9a-f]{3,8}$/i.test(s) ||
		/^(?:rgb|rgba|hsl|hsla)\([0-9.,%\s/]+\)$/i.test(s) ||
		/^[a-z]{3,20}$/i.test(s)
		? s : fallback;
}

export function _fmtPrice(n) {
	if (!isFinite(n) || n <= 0) return "";
	if (n >= 1e6) return "$" + (n / 1e6).toFixed(n % 1e6 ? 2 : 1) + "M";
	if (n >= 1e3) return "$" + Math.round(n / 1e3) + "k";
	return "$" + n;
}

export function _fmtDate(s) {
	if (!s) return "";
	const m = /^(\d{4})-(\d{2})/.exec(String(s));
	if (!m) return String(s);
	const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
	return months[parseInt(m[2], 10) - 1] + " " + m[1];
}
