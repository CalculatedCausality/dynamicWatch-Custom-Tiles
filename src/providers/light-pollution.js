import { CFG } from "../config.js";
import { LayerProvider } from "../layers/provider-factories.js";
import { tileToBBox3857 } from "../utils/tile-geometry.js";
import { lightPollutionToken } from "../utils/lightpoll-token.js";

export class LightPollutionLayerProvider extends LayerProvider {
	create() {
		const TILE_PX = 256;
		const wmsParams =
			"?REQUEST=GetMap&SERVICE=WMS&VERSION=1.3.0&FORMAT=image%2Fpng" +
			"&STYLES=" +
			encodeURIComponent(CFG.LIGHTPOL_WMS_STYLE) +
			"&TRANSPARENT=TRUE" +
			"&LAYERS=" +
			encodeURIComponent(CFG.LIGHTPOL_WMS_LAYER) +
			"&TILED=true&SRS=EPSG%3A3857&CRS=EPSG%3A3857" +
			"&WIDTH=" +
			TILE_PX +
			"&HEIGHT=" +
			TILE_PX;

		const LightPolWmsLayer = L.TileLayer.extend({
			getTileUrl(coords) {
				const bb = tileToBBox3857(coords.z, coords.x, coords.y);
				return (
					CFG.LIGHTPOL_WMS_BASE +
					wmsParams +
					"&BBOX=" +
					bb.west +
					"," +
					bb.south +
					"," +
					bb.east +
					"," +
					bb.north +
					"&token=" + encodeURIComponent(lightPollutionToken())
				);
			},
		});

		const layer = new LightPolWmsLayer("", {
			tileSize: TILE_PX,
			minZoom: 0,
			maxNativeZoom: 12,
			maxZoom: 25,
			opacity: 0.65,
			attribution:
				'Light pollution © <a href="https://www.lightpollutionmap.info/" target="_blank" rel="noreferrer">lightpollutionmap.info</a>',
		});
		Object.defineProperty(layer, "_dwMb3DUrl", {
			get: () => CFG.LIGHTPOL_WMS_BASE + wmsParams +
				"&BBOX={bbox-epsg-3857}&token=" + encodeURIComponent(lightPollutionToken()),
		});
		// Mapbox stores a source's URL when it is registered. Refresh its 3D
		// mirror before the public viewer's five-minute token rotation while
		// this overlay remains active; 2D requests mint tokens per tile.
		layer._dwMb3DReloadOn = ["lightpolltokenrefresh"];
		let refreshTimer;
		layer.on("add", () => {
			clearInterval(refreshTimer);
			refreshTimer = setInterval(() => layer.fire("lightpolltokenrefresh"), 4 * 60 * 1000);
		});
		layer.on("remove", () => {
			clearInterval(refreshTimer);
			refreshTimer = null;
		});
		return layer;
	}
}
