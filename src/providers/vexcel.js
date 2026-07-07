import { BLANK_TILE, CFG } from "../config.js";
import { LayerProvider } from "../layers/provider-factories.js";

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

export function _vexcelTileTpl(token) {
	return (
		CFG.VEXCEL_WMTS_BASE +
		"?service=wmts&request=getTile&layer=urban&Style=RGB" +
		"&TileMatrixSet=urban&TileMatrix={z}&TileRow={y}&TileCol={x}" +
		"&format=image/jpeg&token=" + encodeURIComponent(token)
	);
}

function _getStoredToken() {
	try { return GM_getValue(CFG.VEXCEL_TOKEN_KEY, "") || ""; }
	catch (_) { return ""; }
}

function _storeToken(t) {
	try { GM_setValue(CFG.VEXCEL_TOKEN_KEY, t); } catch (_) {}
}

function _promptForToken() {
	const raw = window.prompt(
		"Vexcel Aerial needs a fresh token (they expire daily).\n\n" +
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

export class VexcelLayerProvider extends LayerProvider {
	create() {
		const stored = _getStoredToken();
		const layer = L.tileLayer(
			_vexcelTokenValid(stored) ? _vexcelTileTpl(stored) : BLANK_TILE,
			{
				tileSize: 256,
				maxNativeZoom: 21,
				maxZoom: 25,
				crossOrigin: true,
				// Urban program tiles 404 outside flown areas — render
				// those as blank rather than broken-image icons.
				errorTileUrl: BLANK_TILE,
				attribution:
					'&copy; <a href="https://www.vexcelgroup.com/" target="_blank"' +
					' rel="noreferrer">Vexcel Imaging</a>',
			},
		);
		// Token check happens when the base is SELECTED, not at boot —
		// a page-load prompt would be obnoxious and the token may well
		// have rotated since the last session.
		layer.on("add", () => {
			let tok = _getStoredToken();
			if (!_vexcelTokenValid(tok)) tok = _promptForToken();
			if (!_vexcelTokenValid(tok)) return; // stays blank until re-add
			const tpl = _vexcelTileTpl(tok);
			if (layer._url !== tpl) layer.setUrl(tpl);
		});
		// 3D sync re-evaluates per sync, so a token pasted mid-session
		// flows into the Mapbox raster source without a mode toggle.
		layer._dwMb3DGetUrl = () => {
			const tok = _getStoredToken();
			return _vexcelTokenValid(tok) ? _vexcelTileTpl(tok) : "";
		};
		return layer;
	}
}
