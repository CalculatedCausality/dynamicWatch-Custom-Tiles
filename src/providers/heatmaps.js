import { dwMbGmFetchAB, dwRegisterMbLayer } from "../bridge/mapbox-tile-bridge.js";
import { CFG } from "../config.js";
import { LayerProvider } from "../layers/provider-factories.js";
import { gmGet, wireTileAbort } from "../utils/http.js";

export class StravaHeatmapLayerProvider extends LayerProvider {
	create() {
		const layer = L.tileLayer(CFG.STRAVA_HEATMAP_TILE, {
			tileSize: 256,
			maxNativeZoom: CFG.STRAVA_HEATMAP_MAX_NATIVE_Z,
			maxZoom: 25,
			opacity: 0.8, crossOrigin: false,
			attribution: "© Strava",
		});
		dwRegisterMbLayer(layer, (z, x, y) => dwMbGmFetchAB(
			CFG.STRAVA_HEATMAP_TILE
				.replace("{z}", z).replace("{x}", x).replace("{y}", y)));
		return layer;
	}
}

export class GarminHeatmapLayerProvider extends LayerProvider {
	create() {
		const ACTIVITIES = [
			"RUNNING",
			"HIKING",
			"TRAIL_RUNNING",
			"ROAD_CYCLING",
			"MOUNTAIN_BIKING",
		];

		const garminMiss = new Set();
		const GARMIN_MISS_MAX = 4096;
		const garminMissKey = (a, z, x, y) => a + "/" + z + "/" + x + "/" + y;
		const garminNoteMiss = (key) => {
			if (garminMiss.size < GARMIN_MISS_MAX) garminMiss.add(key);
		};

		const GarminHeatGrid = L.GridLayer.extend({
			createTile(coords, done) {
				const canvas = document.createElement("canvas");
				canvas.width = 256;
				canvas.height = 256;
				const ctx = canvas.getContext("2d");

				let remaining = ACTIVITIES.length;
				let failed = 0;
				canvas._dwHandles = [];

				const finish = () => {
					remaining--;
					if (remaining === 0) {
						canvas._dwHandles = null;
						if (failed === ACTIVITIES.length) {
							done(new Error("All Garmin activity tiles failed"), canvas);
						} else {
							done(null, canvas);
						}
					}
				};

				for (const activity of ACTIVITIES) {
					const missKey =
						garminMissKey(activity, coords.z, coords.x, coords.y);
					if (garminMiss.has(missKey)) { failed++; finish(); continue; }
					const url =
						"https://connecttile.garmin.com/" + activity + "/" +
						coords.z + "/" + coords.x + "/" + coords.y + ".png";
					canvas._dwHandles.push(
						gmGet(url, { responseType: "arraybuffer" }, (err, r) => {
							if (err || r.status !== 200) {
								garminNoteMiss(missKey);
								failed++; finish(); return;
							}
							const blob   = new Blob([r.response], { type: "image/png" });
							const objUrl = URL.createObjectURL(blob);
							const img = new Image();
							img.onload = () => {
								ctx.globalCompositeOperation = "lighter";
								ctx.drawImage(img, 0, 0);
								URL.revokeObjectURL(objUrl);
								finish();
							};
							img.onerror = () => {
								URL.revokeObjectURL(objUrl);
								garminNoteMiss(missKey);
								failed++; finish();
							};
							img.src = objUrl;
						}),
					);
				}

				return canvas;
			},
		});

		const layer = new GarminHeatGrid({
			tileSize: 256,
			minZoom: 4,
			maxNativeZoom: 17,
			maxZoom: 25,
			opacity: 0.8,
			attribution: "© Garmin",
		});
		wireTileAbort(layer);
		dwRegisterMbLayer(layer, async (z, x, y) => {
			const urls = ACTIVITIES.map((a) =>
				"https://connecttile.garmin.com/" + a + "/" +
				z + "/" + x + "/" + y + ".png");
			const blobs = await Promise.all(urls.map((u) =>
				dwMbGmFetchAB(u)
					.then((ab) => new Blob([ab], { type: "image/png" }))
					.catch(() => null)));
			const bitmaps = await Promise.all(blobs.map((b) =>
				b ? createImageBitmap(b).catch(() => null) : null));
			const alive = bitmaps.filter(Boolean);
			if (!alive.length) throw new Error("All Garmin activity tiles failed");
			const canvas = new OffscreenCanvas(256, 256);
			const ctx = canvas.getContext("2d");
			ctx.globalCompositeOperation = "lighter";
			for (const bm of alive) ctx.drawImage(bm, 0, 0);
			const out = await canvas.convertToBlob({ type: "image/png" });
			return await out.arrayBuffer();
		});
		return layer;
	}
}
