import { CFG } from "../config.js";
import { arcgisExportProvider, LayerProvider } from "../layers/provider-factories.js";
import { _escHtml, esc } from "../utils/html.js";

export function makeArcgisQueryLayer(opts, gmJsonGet) {
	const debounceMs = opts.debounceMs || 400;
	const timeoutMs = opts.timeoutMs || 30000;
	const padBounds = opts.padBounds || 0;

	const Layer = L.Layer.extend({
		initialize() {
			this._group = null;
			this._debounce = null;
			this._lastBbox = null;
			this._gen = 0;
		},

		onAdd(map) {
			if (!map.getPane(opts.pane)) {
				map.createPane(opts.pane);
				map.getPane(opts.pane).style.zIndex = String(opts.paneZIndex);
			}
			this._group = L.layerGroup().addTo(map);
			this._fetch();
			map.on("moveend zoomend", this._onViewChange, this);
		},

		onRemove(map) {
			clearTimeout(this._debounce);
			this._debounce = null;
			this._gen++;
			map.off("moveend zoomend", this._onViewChange, this);
			if (this._group) { this._group.remove(); this._group = null; }
		},

		_onViewChange() {
			clearTimeout(this._debounce);
			this._debounce = setTimeout(() => this._fetch(), debounceMs);
		},

		_fetch() {
			const map = this._map;
			if (!map || !this._group) return;
			const z = map.getZoom();
			if (z < opts.minZoom) {
				this._group.clearLayers();
				this._lastBbox = null;
				return;
			}

			const b = padBounds ? map.getBounds().pad(padBounds) : map.getBounds();
			const bbox = `${b.getWest().toFixed(4)},${b.getSouth().toFixed(4)},` +
				`${b.getEast().toFixed(4)},${b.getNorth().toFixed(4)}`;
			if (bbox === this._lastBbox) return;
			this._lastBbox = bbox;

			const myGen = ++this._gen;
			const offset = (360 / (256 * Math.pow(2, z))) * 2;
			const url = opts.queryUrl + "?f=geojson&returnGeometry=true" +
				"&geometryType=esriGeometryEnvelope&inSR=4326&outSR=4326" +
				"&spatialRel=esriSpatialRelIntersects&geometryPrecision=5" +
				"&where=" + encodeURIComponent(opts.where) +
				"&outFields=" + encodeURIComponent(opts.outFields) +
				"&geometry=" + encodeURIComponent(bbox) +
				"&maxAllowableOffset=" + offset;

			gmJsonGet(url, { timeout: timeoutMs }, (err, geojson) => {
				if (myGen !== this._gen || !this._group) return;
				if (err || (geojson && geojson.error)) {
					console.warn(`[CustomTiles] ${opts.label} request error`,
						err ? err.message : JSON.stringify(geojson.error));
					return;
				}
				this._group.clearLayers();
				L.geoJSON(geojson, {
					pane: opts.pane,
					style: () => opts.style,
					onEachFeature: (f, lyr) => {
						const tip = opts.tooltip && opts.tooltip(f.properties || {});
						if (tip) lyr.bindTooltip(tip, {
							className: opts.tipClass || "dw-park-tip", sticky: true,
						});
					},
				}).addTo(this._group);
			});
		},

		getAttribution() { return opts.attribution; },
	});

	return new Layer();
}

export function createQldEnvironmentProviders({ makeHoverIdentify, gmJsonGet }) {
	const installQpwsHover = makeHoverIdentify({
		baseUrl:    CFG.QLD_QPWS_SERVICE,
		layers:     "all:10",
		tolerance:  5,
		minZoom:    CFG.QLD_QPWS_HOVER_MIN_ZOOM,
		tipClass:   "dw-qpws-tip",
		formatTooltip: (a) => {
			const name = a.NAME || a.name || a.PARK_NAME || a.park_name || "";
			const type = a.FEAT_TYPE || a.feat_type || a.MANAGE_TYPE || a.manage_type || "";
			const lines = [];
			if (name) lines.push(esc`<b>${name}</b>`);
			if (type) lines.push(_escHtml(type));
			return lines.join("<br>") || "Protected area";
		},
	});

	const QpwsLayerProvider = arcgisExportProvider({
		baseUrl: CFG.QLD_QPWS_SERVICE,
		showLayers: CFG.QLD_QPWS_LAYER_IDS,
		pane: "dwQpwsPane", paneZIndex: 396,
		opacity: 0.85, minZoom: 9, maxZoom: 25,
		attribution: 'QPWS &copy; <a href="https://parks.qld.gov.au/" target="_blank" rel="noreferrer">State of Queensland (DETSI)</a>',
		onAdd: (layer, map) => installQpwsHover(layer, map),
		onRemove: (layer) => {
			if (layer._dwHoverOff) { layer._dwHoverOff(); layer._dwHoverOff = null; }
		},
	});

	class NationalParksLayerProvider extends LayerProvider {
		create() {
			return makeArcgisQueryLayer({
				label: "National Parks",
				pane: "dwNationalParksPane",
				paneZIndex: 397,
				minZoom: 8,
				queryUrl: CFG.QLD_QPWS_SERVICE + "/10/query",
				where: "esttype IN ('NP','NS','NY','NA')",
				outFields: "estatename,esttype",
				style: {
					color: "#166534",
					weight: 1,
					opacity: 0.9,
					fillColor: "#22c55e",
					fillOpacity: 0.22,
				},
				tipClass: "dw-park-tip",
				tooltip: (p) => {
					const name = p.estatename || p.ESTATENAME || p.NAME || "National Park";
					const type = p.esttype || p.ESTTYPE || "";
					return esc`<b>${name}</b>` + (type ? `<br>${_escHtml(type)}` : "");
				},
				attribution: 'QPWS &copy; <a href="https://parks.qld.gov.au/" target="_blank" rel="noreferrer">State of Queensland (DETSI)</a>',
			}, gmJsonGet);
		}
	}

	return { QpwsLayerProvider, NationalParksLayerProvider };
}
