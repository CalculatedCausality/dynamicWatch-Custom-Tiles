import { dwMbGmFetchAB, dwRegisterMbLayer } from "../bridge/mapbox-tile-bridge.js";
import { CFG } from "../config.js";
import { LayerProvider } from "../layers/provider-factories.js";
import { gmGet, wireTileAbort } from "../utils/http.js";

export class StamenTerrainLayerProvider extends LayerProvider {
	create() {
		const TILE_PX = 256;
		const TILE_BASE = "https://tiles.stadiamaps.com/tiles/stamen_terrain/";
		const spoofOrigin = CFG.STADIA_SPOOF_ORIGIN;

		const TerrainGrid = L.GridLayer.extend({
			createTile(coords, done) {
				const img = document.createElement("img");
				img.setAttribute("role", "presentation");
				const url =
					TILE_BASE + coords.z + "/" + coords.x + "/" + coords.y + ".png";
				img._dwHandle = gmGet(url, {
					responseType: "arraybuffer",
					headers: {
						Origin:  spoofOrigin,
						Referer: spoofOrigin + "/",
						Accept:  "image/png,image/*,*/*;q=0.8",
					},
				}, (err, r) => {
					img._dwHandle = null;
					if (err) {
						done(new Error("Stamen " + err.message), img);
						return;
					}
					if (r.status !== 200) {
						done(new Error("Stamen HTTP " + r.status), img);
						return;
					}
					const blob   = new Blob([r.response], { type: "image/png" });
					const objUrl = URL.createObjectURL(blob);
					img.onload  = () => { URL.revokeObjectURL(objUrl); done(null, img); };
					img.onerror = () => {
						URL.revokeObjectURL(objUrl);
						done(new Error("Stamen decode failed"), img);
					};
					img.src = objUrl;
				});
				return img;
			},
		});

		const layer = new TerrainGrid({
			tileSize: TILE_PX,
			maxNativeZoom: 18,
			maxZoom: 25,
			attribution:
				'&copy; <a href="https://stadiamaps.com/" target="_blank" rel="noreferrer">Stadia Maps</a> ' +
				'&copy; <a href="https://stamen.com/" target="_blank" rel="noreferrer">Stamen Design</a> ' +
				'&copy; <a href="https://openmaptiles.org/" target="_blank" rel="noreferrer">OpenMapTiles</a> ' +
				'&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors',
		});
		wireTileAbort(layer);
		dwRegisterMbLayer(layer, (z, x, y) => dwMbGmFetchAB(
			TILE_BASE + z + "/" + x + "/" + y + ".png", {
				headers: {
					Origin:  spoofOrigin,
					Referer: spoofOrigin + "/",
					Accept:  "image/png,image/*,*/*;q=0.8",
				},
			}));
		return layer;
	}
}
