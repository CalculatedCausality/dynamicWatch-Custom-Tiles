import { CFG } from "../config.js";
import { LayerProvider } from "../layers/provider-factories.js";
import { tileToBBox3857 } from "../utils/tile-geometry.js";

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
					bb.north
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
		layer._dwMb3DUrl =
			CFG.LIGHTPOL_WMS_BASE + wmsParams + "&BBOX={bbox-epsg-3857}";
		return layer;
	}
}
