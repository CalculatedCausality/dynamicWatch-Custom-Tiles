import { BLANK_TILE, CFG } from "../config.js";
import { LayerProvider, wireOverzoomFallback } from "../layers/provider-factories.js";
import { cachedFetch, gmJsonGet } from "../utils/http.js";

export class WaybackLayerProvider extends LayerProvider {
	constructor() {
		super();
		this._releases = null;
		this._idx = 0;
		this._fetching = false;
		this._layerRef = null;
	}

	_tileUrl(releaseNum) {
		return (
			"https://wayback.maptiles.arcgis.com/arcgis/rest/services/" +
			"World_Imagery/WMTS/1.0.0/default028mm/MapServer/tile/" +
			releaseNum +
			"/{z}/{y}/{x}"
		);
	}

	_fetchCatalog() {
		if (this._fetching || this._releases) return;
		this._fetching = true;
		cachedFetch(
			"wayback_catalog",
			24 * 3600 * 1000,
			(done) => gmJsonGet(CFG.WAYBACK_CONFIG_URL, (err, data) => {
				if (err) { done(err, null); return; }
				const releases = Object.entries(data)
					.filter(([, item]) => item.itemTitle)
					.map(([key, item]) => ({
						releaseNum: parseInt(key, 10),
						label: item.itemTitle
							.replace(/^World Imagery \(Wayback /, "")
							.replace(/\)$/, ""),
					}));
				releases.sort((a, b) =>
					a.label < b.label ? 1 : a.label > b.label ? -1 : 0);
				done(null, releases);
			}),
			(err, releases) => {
				this._fetching = false;
				if (err || !releases) {
					console.error("[CustomTiles] Wayback catalog:", err && err.message);
					return;
				}
				this._releases = releases.map(r => ({
					...r, url: this._tileUrl(r.releaseNum),
				}));
				console.info("[CustomTiles] Wayback:",
					this._releases.length, "releases loaded");
				this._idx = 0;
				if (this._layerRef) {
					this._layerRef.setUrl(this._releases[0].url);
					this._layerRef.fire("histchange");
				}
			},
		);
	}

	create() {
		const provider = this;
		const layer = L.tileLayer(BLANK_TILE, {
			maxNativeZoom: 19,
			maxZoom: 25,
			tileSize: 256,
			attribution: "&copy; Esri, Maxar, Earthstar Geographics",
		});
		wireOverzoomFallback(layer);
		this._layerRef = layer;

		layer.getHistCount = () =>
			provider._releases ? provider._releases.length : 0;
		layer.getHistIdx = () => provider._idx;
		layer.getHistLabel = (i) => {
			if (!provider._releases) return null;
			return (provider._releases[i ?? provider._idx] || {}).label || null;
		};
		layer.setHistIdx = (i) => {
			if (!provider._releases) return;
			if (i < 0 || i >= provider._releases.length || i === provider._idx)
				return;
			provider._idx = i;
			layer.setUrl(provider._releases[i].url);
			layer.fire("histchange");
		};

		layer.on("add", () => provider._fetchCatalog());
		return layer;
	}
}
