import { CustomTilesApp } from './app/custom-tiles-app.js';
import { isWazeTokenFrame, startWazeTokenBroker } from './providers/waze-token.js';
import { CFG, DW_LAYER_GROUPS, DW_OVERLAY_GROUPS } from './config.js';
import {
	LayerProvider,
	_overzoomPlacement,
	tileProvider,
	arcgisExportProvider,
	tokenTileProvider,
} from './layers/provider-factories.js';
import { pollingDataLayer } from './layers/polling-data-layer.js';
import {
	_cadVal,
	_formatAddressLine,
	_formatCadastreTooltip,
	_othCanonicalUrlFromLocation,
	_othStreetTypeSlug,
	_slugify,
} from './providers/qld-cadastre.js';
import { _parseAuStreetAddress, _pickJurisdiction } from './providers/cadastre-au.js';
import { _formatMineTooltip } from './providers/qld-mining.js';
import { oimIcon } from './providers/openinframap.js';
import {
	_vexcelIsCredString,
	_vexcelParseToken,
	_vexcelTokenExp,
	_vexcelTokenValid,
} from './providers/vexcel-auth.js';
import {
	_vexcelCollectionYear,
	_vexcelObliqueExtractUrl,
	_vexcelObliqueTileBase,
	_vexcelMaxDownsample,
	_vexcelBand,
	_vexcelFootprint,
	_vexcelBilinear,
	_vexcelClipPathToRect,
	_vexcelClipPathToQuad,
	_vexcelDensifyPath,
	_vexcelInvBilinear,
	_vexcelParseObliques,
	_vexcelTileTpl,
} from './providers/vexcel.js';
import {
	_decisionClass,
	_dedupeDeviFeatures,
	_deviAppByIdUrl,
	_deviAppUrl,
	_deviDetailUrl,
	_deviFilterBody,
	_deviKindFromCategory,
	_deviReportUrl,
	_fmtSccDate,
	_formatNotifTooltip,
	_formatSccPopup,
	_formatSccTooltip,
	_histFromFilterResults,
	_histRowHtml,
	_notifPopupProps,
	_parseSccDetailHtml,
	_parseSccDocs,
	_renderSccDetail,
	_renderSccPropertyHistory,
	_sccDefaultState,
	_sccDocDownloadUrl,
	_sccDocsSearchUrl,
	_sccFeatureKey,
	_sccLoadState,
} from './providers/scc-applications.js';
import { _escHtml, esc, _safeColor, _fmtPrice, _fmtDate } from './utils/html.js';
import { hexAlpha, pointInRing, intvlActivityTime, intvlAgo, intvlArea } from './utils/intvl.js';
import {
	mvtDecode,
	parseLayer,
	parseValue,
	parseFeature,
	decodeGeometry,
	zig,
	readVarint,
	skipField,
	utf8,
	prepareLayers,
} from './utils/mvt.js';
import { tileToBBox4326, tileToBBox3857, utfGridCellToLatLng } from './utils/tile-geometry.js';

export function bootUserscript() {
	// When this script instance is running inside the hidden
	// embed.waze.com iframe (see waze-token.js), it exists ONLY to mint
	// reCAPTCHA tokens in the waze.com origin — there is no dynamic.watch
	// map here. Run the broker and stop before touching any map/DOM/L.
	if (isWazeTokenFrame()) {
		startWazeTokenBroker();
		return;
	}

	// Visible version banner — answers "did Tampermonkey actually update?"
	// on every page load without grepping for symptoms.
	const SCRIPT_VERSION =
		(typeof GM_info !== "undefined" && GM_info.script?.version) || "?";
	console.info(
		`%c[CustomTiles] v${SCRIPT_VERSION} loaded`,
		"color:#fff;background:#0277bd;padding:2px 6px;border-radius:3px;",
	);

	if (globalThis.__DW_TEST_EXPORTS__) {
		globalThis.__dw = {
			CFG, DW_LAYER_GROUPS, DW_OVERLAY_GROUPS,
			tileToBBox4326, tileToBBox3857, utfGridCellToLatLng,
			_overzoomPlacement,
			mvtDecode, parseLayer, parseValue, parseFeature,
			decodeGeometry, zig, readVarint, skipField, utf8,
			hexAlpha, pointInRing, prepareLayers,
			intvlActivityTime, intvlAgo, intvlArea,
			_cadVal, _escHtml, esc, _safeColor, _fmtPrice, _fmtDate,
			_slugify, _othStreetTypeSlug, _othCanonicalUrlFromLocation,
			_formatCadastreTooltip, _formatAddressLine,
			_parseAuStreetAddress, _pickJurisdiction, _formatMineTooltip,
			_deviAppUrl, _fmtSccDate, _formatSccTooltip, _formatSccPopup,
			_sccDefaultState, _sccLoadState,
			_deviDetailUrl, _parseSccDetailHtml, _renderSccDetail,
			_deviAppByIdUrl, _deviFilterBody, _dedupeDeviFeatures,
			_formatNotifTooltip, _notifPopupProps,
			_deviKindFromCategory, _histFromFilterResults, _decisionClass,
			_histRowHtml, _renderSccPropertyHistory,
			_deviReportUrl, _sccDocsSearchUrl, _sccDocDownloadUrl, _parseSccDocs,
			_sccFeatureKey,
			_vexcelParseToken, _vexcelTokenExp, _vexcelTokenValid, _vexcelTileTpl,
			_vexcelCollectionYear, _vexcelParseObliques, _vexcelObliqueExtractUrl,
			_vexcelObliqueTileBase, _vexcelMaxDownsample, _vexcelBand,
			_vexcelFootprint, _vexcelBilinear, _vexcelInvBilinear,
			_vexcelClipPathToQuad, _vexcelClipPathToRect, _vexcelDensifyPath,
			_vexcelIsCredString,
			LayerProvider, tileProvider, tokenTileProvider,
			arcgisExportProvider, pollingDataLayer, oimIcon,
		};
	}

	if (!globalThis.__DW_DISABLE_BOOT__) new CustomTilesApp().boot();
}
