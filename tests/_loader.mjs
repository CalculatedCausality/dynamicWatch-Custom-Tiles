// Shared sandbox loader. Reads the userscript, stubs every browser /
// Leaflet / Greasemonkey global the IIFE references, evals it, and
// returns the helpers leaked via `globalThis.__dw`. Used by unit.mjs
// (helper assertions) and shape.mjs (PBF decode against live tiles).

import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.join(HERE, "..", "dynamicwatch-custom-tiles.user.js");

const HELPERS = [
	// config/grouping
	"CFG", "DW_LAYER_GROUPS", "DW_OVERLAY_GROUPS",
	// tile geometry
	"tileToBBox4326", "tileToBBox3857", "utfGridCellToLatLng",
	"_overzoomPlacement",
	// MVT / protobuf
	"mvtDecode", "parseLayer", "parseValue", "parseFeature",
	"decodeGeometry", "zig", "readVarint", "skipField", "utf8",
	// colour + geometry primitives
	"hexAlpha", "pointInRing", "prepareLayers",
	// INTVL formatters
	"intvlActivityTime", "intvlAgo", "intvlArea",
	// Cadastre / OnTheHouse formatters (underscore-prefixed module-scope)
	"_cadVal", "_escHtml", "esc", "_safeColor", "_fmtPrice", "_fmtDate",
	"_slugify", "_othStreetTypeSlug", "_othCanonicalUrlFromLocation",
	"_formatCadastreTooltip", "_formatAddressLine",
	// SCC applications (Development.i) formatters + submenu state
	"_deviAppUrl", "_fmtSccDate", "_formatSccTooltip", "_formatSccPopup",
	"_sccDefaultState", "_sccLoadState",
	"_deviDetailUrl", "_parseSccDetailHtml", "_renderSccDetail",
	"_deviAppByIdUrl", "_deviFilterBody", "_dedupeDeviFeatures",
	"_formatNotifTooltip", "_notifPopupProps",
	"_deviKindFromCategory", "_histFromFilterResults", "_decisionClass",
	"_histRowHtml", "_renderSccPropertyHistory",
	"_deviReportUrl", "_sccDocsSearchUrl", "_sccDocDownloadUrl", "_parseSccDocs",
	"_sccFeatureKey",
	// Vexcel aerial token + oblique helpers
	"_vexcelParseToken", "_vexcelTokenExp", "_vexcelTokenValid", "_vexcelTileTpl",
	"_vexcelCollectionYear", "_vexcelParseObliques", "_vexcelObliqueExtractUrl",
	"_vexcelObliqueTileBase", "_vexcelMaxDownsample", "_vexcelBand",
	"_vexcelFootprint", "_vexcelBilinear", "_vexcelInvBilinear",
	"_vexcelClipPathToQuad", "_vexcelClipPathToRect", "_vexcelDensifyPath",
	"_vexcelIsCredString",
	// Layer-provider factories
	"LayerProvider", "tileProvider", "tokenTileProvider",
	"arcgisExportProvider", "pollingDataLayer", "oimIcon",
	"_fowDecodeFilename", "_fowFilenameForId", "_fowParseInflated", "_fowVisited",
];

export function loadHelpers() {
	const raw = fs.readFileSync(SCRIPT_PATH, "utf8");

	const noop = () => {};
	const stubExtend = (proto) => function (opts) {
		const inst = Object.assign(Object.create(null), proto || {});
		if (typeof inst.initialize === "function") inst.initialize.call(inst, opts);
		return inst;
	};
	const stubTileLayer = function () { return { on: noop, options: {} }; };
	stubTileLayer.extend = stubExtend;

	const L = {
		Browser:  { mobile: false },
		DomUtil:  { create: () => ({ classList: { add: noop }, style: {} }) },
		DomEvent: {
			on: noop, off: noop,
			disableClickPropagation: noop, disableScrollPropagation: noop,
			preventDefault: noop,
		},
		tileLayer: stubTileLayer,
		GridLayer: { extend: stubExtend, prototype: { onAdd: noop, onRemove: noop } },
		TileLayer: { extend: stubExtend, prototype: { onAdd: noop, onRemove: noop } },
		Layer:     { extend: stubExtend },
		marker:    () => ({ addTo: noop, bindTooltip: () => ({}), on: noop }),
		polyline:  () => ({ addTo: noop, bindTooltip: () => ({}) }),
		polygon:   () => ({ addTo: noop, bindTooltip: () => ({}) }),
		layerGroup: () => ({ addTo: noop, clearLayers: noop, remove: noop }),
		tooltip:   () => ({ setLatLng: function () { return this; }, addTo: noop }),
		popup:     () => ({ setLatLng: function () { return this; }, setContent: function () { return this; }, openOn: noop, isOpen: () => false }),
		divIcon:   () => ({}),
		control:   { layers: () => ({ addTo: noop }) },
		geoJSON:   () => ({ addTo: noop }),
		latLng:    (a, b) => ({ lat: a, lng: b }),
	};
	L.tileLayer.extend = stubExtend;

	const stubEl = () => ({
		appendChild: noop, setAttribute: noop, classList: {
			add: noop, toggle: () => false, contains: () => false, remove: noop,
		},
		style: {}, dataset: {}, addEventListener: noop,
		querySelector: () => null, querySelectorAll: () => [],
		insertBefore: noop, removeChild: noop,
	});
	const sandboxDoc = {
		createElement: stubEl,
		getElementById: () => null,
		head: stubEl(),
		documentElement: stubEl(),
		cookie: "",
		addEventListener: noop,
	};

	const sandbox = {
		console,
		setTimeout, clearTimeout, setInterval, clearInterval,
		TextDecoder, URLSearchParams,
		atob, btoa,
		Date, Math, JSON, Object, Array, Set, Map, Number, String, Boolean, Symbol,
		Promise, Error, RegExp,
		isFinite, isNaN, parseInt, parseFloat,
		Infinity, NaN, undefined,
		Image: function () {}, Blob: function () {},
		URL: { createObjectURL: () => "blob:fake", revokeObjectURL: noop },
		DataView: globalThis.DataView,
		Uint8Array: globalThis.Uint8Array,
		Float32Array: globalThis.Float32Array,
		Float64Array: globalThis.Float64Array,
		Int16Array: globalThis.Int16Array, Int32Array: globalThis.Int32Array,
		ArrayBuffer: globalThis.ArrayBuffer,
		MutationObserver: function () { this.observe = noop; this.disconnect = noop; },
		document: sandboxDoc,
		unsafeWindow: { L, document: sandboxDoc },
		L,
		navigator: { clipboard: { writeText: () => Promise.resolve() }, language: "en-US" },
		localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
		__DW_TEST_EXPORTS__: true,
		__DW_DISABLE_BOOT__: true,
		GM_getValue: (_k, d) => d,
		GM_setValue: noop,
		GM_registerMenuCommand: noop,
		GM_deleteValue: noop,
		GM_xmlhttpRequest: () => ({ abort: noop }),
	};
	sandbox.window = sandbox;
	sandbox.globalThis = sandbox;

	vm.createContext(sandbox);
	vm.runInContext(raw, sandbox, { filename: "userscript-under-test.js" });
	if (!sandbox.__dw) throw new Error("helpers not exported from sandbox");
	for (const name of HELPERS) {
		if (!(name in sandbox.__dw)) throw new Error(`helper not exported: ${name}`);
	}
	return sandbox.__dw;
}
