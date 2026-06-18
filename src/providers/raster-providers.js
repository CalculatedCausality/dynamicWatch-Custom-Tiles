import { CFG } from "../config.js";
import {
	tileProvider,
	arcgisExportProvider,
	tokenTileProvider,
} from "../layers/provider-factories.js";

export const QldGlobeLayerProvider = tokenTileProvider(
	(tok) => CFG.QLD_TILE_TPL + (tok.token ? "?token=" + tok.token : ""),
	{ maxNativeZoom: 21, maxZoom: 25, overzoom: true,
	  attribution: "&copy; State of Queensland (Department of Resources)" },
);

export const GoogleHybridLayerProvider = tileProvider(
	CFG.GOOGLE_HYBRID_TILE,
	{ subdomains: ["0", "1", "2", "3"], maxNativeZoom: 21,
	  attribution: "&copy; Google" },
);

export function buildAppleTileUrl(accessKey, version) {
	return CFG.APPLE_TILE_BASE +
		"&v=" + encodeURIComponent(version || CFG.APPLE_DEFAULT_V) +
		(accessKey ? "&accessKey=" + encodeURIComponent(accessKey) : "");
}

export const AppleMapsLayerProvider = tokenTileProvider(
	(tok) => buildAppleTileUrl(tok.accessKey, tok.version),
	{ maxNativeZoom: 19, maxZoom: 25, attribution: "&copy; Apple" },
);

export const QldLabelsLayerProvider = tileProvider(CFG.QLD_LABELS_TILE, {
	maxNativeZoom: 19,
	maxZoom: 25,
	pane: "dwLabelsPane",
	attribution: "&copy; State of Queensland (Department of Resources)",
});

export const MobileCoverageLayerProvider = arcgisExportProvider({
	baseUrl: CFG.ACCC_MOBILE_COVERAGE_SERVICE,
	showLayers: "2",
	pane: "dwMobilePane",
	paneZIndex: 380,
	opacity: 0.5,
	minZoom: 5,
	maxNativeZoom: 18,
	maxZoom: 25,
	attribution: 'Mobile coverage &copy; <a href="https://data.gov.au" target="_blank" rel="noreferrer">ACCC / Dept. of Infrastructure</a>',
});

export const QldTopoLayerProvider = tileProvider(CFG.QLD_TOPO_TILE, {
	maxNativeZoom: 16,
	maxZoom: 25,
	attribution: "&copy; State of Queensland (Department of Resources)",
});

export const QldReliefLayerProvider = tileProvider(CFG.QLD_RELIEF_TILE, {
	maxNativeZoom: 16,
	maxZoom: 25,
	opacity: 0.45,
	attribution: "&copy; State of Queensland (Department of Resources)",
});

export const OpenSeaMapLayerProvider = tileProvider(
	CFG.OPENSEAMAP_TILE,
	{ maxNativeZoom: 18, maxZoom: 25,
	  attribution: '&copy; <a href="https://www.openseamap.org/" target="_blank" rel="noreferrer">OpenSeaMap</a> contributors' },
);
