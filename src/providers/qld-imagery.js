import { dwMbFetchAB, dwRegisterMbLayer } from "../bridge/mapbox-tile-bridge.js";
import { CFG } from "../config.js";
import { LayerProvider } from "../layers/provider-factories.js";
import { gmJsonGet } from "../utils/http.js";
import { tileToBBox3857 } from "../utils/tile-geometry.js";

export class QldRoadsLayerProvider extends LayerProvider {
	constructor(qldToken) {
		super();
		this._token = qldToken;
	}

	create() {
		const TILE_PX = 256;
		const token = this._token;
		const DYN_LAYERS = encodeURIComponent(JSON.stringify(
			[21, 22, 23, 10].map(id => ({
				id, source: { type: "mapLayer", mapLayerId: id },
				drawingInfo: { showLabels: true },
			})),
		));

		const QldRoadsGrid = L.GridLayer.extend({
			createTile(coords, done) {
				const img = document.createElement("img");
				img.setAttribute("role", "presentation");
				const b = tileToBBox3857(coords.z, coords.x, coords.y);
				const bbox = encodeURIComponent(
					`${b.west},${b.south},${b.east},${b.north}`);
				const tok = token.token
					? "&token=" + encodeURIComponent(token.token)
					: "";
				img.onload = () => done(null, img);
				img.onerror = () => done(new Error("Roads tile failed"), img);
				img.src =
					CFG.QLD_ROADS_EXPORT +
					`?bbox=${bbox}&bboxSR=102100&imageSR=102100` +
					`&size=${TILE_PX}%2C${TILE_PX}` +
					`&dpi=192&format=png32&transparent=true` +
					`&dynamicLayers=${DYN_LAYERS}&f=image${tok}`;
				return img;
			},
		});

		const layer = new QldRoadsGrid({
			tileSize: TILE_PX,
			maxNativeZoom: 19,
			maxZoom: 25,
			pane: "dwRoadsPane",
			attribution: "&copy; State of Queensland (Department of Resources)",
		});
		layer._dwMb3DGetUrl = () => {
			if (!token.token) return null;
			const tok = "&token=" + encodeURIComponent(token.token);
			return CFG.QLD_ROADS_EXPORT +
				`?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857` +
				`&size=${TILE_PX},${TILE_PX}` +
				`&dpi=192&format=png32&transparent=true` +
				`&dynamicLayers=${DYN_LAYERS}&f=image${tok}`;
		};
		return layer;
	}
}

export class QldHistoricalLayerProvider extends LayerProvider {
	constructor(qldToken) {
		super();
		this._qldToken = qldToken || null;
		this._captures = [];
		this._captureIdx = 0;
		this._currentOid = null;
		this._captureGeneration = 0;
		this._redrawTimer = null;
		this._fetching = false;
		this._fetchPending = [];
		this._lastCenter = null;
		this._gridLayerRef = null;
	}

	_queryCatalog(map, cb) {
		if (this._currentOid !== null) {
			cb(this._currentOid);
			return;
		}
		this._fetchPending.push(cb);
		if (this._fetching) return;
		this._fetching = true;

		const c = map.getCenter();
		this._lastCenter = c;

		const geomParam =
			"?geometry=" +
			encodeURIComponent(
				JSON.stringify({
					x: c.lng,
					y: c.lat,
					spatialReference: { wkid: 4326 },
				}),
			) +
			"&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects" +
			"&outFields=objectid,name,year,title,capturestart" +
			"&returnGeometry=false&orderByFields=capturestart+DESC&f=json";

		const parseCaptures = (data, service, needsToken, mosaicWhere) =>
			(data && data.features || [])
				.map((f) => ({
					objectid: f.attributes.objectid,
					title:
						f.attributes.title ||
						f.attributes.name ||
						String(f.attributes.year || ""),
					captureDate: f.attributes.capturestart
						? new Date(f.attributes.capturestart).toISOString().slice(0, 10)
						: f.attributes.year
							? String(f.attributes.year)
							: null,
					service,
					needsToken,
					mosaicWhere,
				}))
				.filter((f) => f.objectid);

		let orthoCaptures = null;
		let photosCaptures = null;

		const finish = () => {
			this._fetching = false;
			const all = [...(orthoCaptures || []), ...(photosCaptures || [])];
			all.sort((a, b) => {
				const da = a.captureDate || "";
				const db = b.captureDate || "";
				return db < da ? -1 : db > da ? 1 : 0;
			});
			this._captures = all;
			if (this._captures.length) {
				console.info(
					"[CustomTiles] QLD Historical:",
					this._captures.length,
					"captures, latest:",
					this._captures[0].captureDate || this._captures[0].title,
				);
			} else {
				console.warn(
					"[CustomTiles] QLD Historical: no coverage at",
					c.lng.toFixed(4),
					c.lat.toFixed(4),
				);
			}
			this._captureIdx = 0;
			this._currentOid =
				(this._captures[0] && this._captures[0].objectid) || null;
			this._fetchPending.splice(0).forEach((fn) => fn(this._currentOid));
			if (this._gridLayerRef) this._gridLayerRef.fire("capturechange");
		};

		const tryFinish = () => {
			if (orthoCaptures !== null && photosCaptures !== null) finish();
		};

		gmJsonGet(
			CFG.QLD_HIST_SERVICE + "/query" + geomParam + "&where=category%3D1",
			{ headers: { Origin: "https://qldglobe.information.qld.gov.au" } },
			(err, data) => {
				if (err) {
					console.error("[CustomTiles] QLD Historical ortho query:",
						err.message);
					orthoCaptures = [];
				} else {
					orthoCaptures = parseCaptures(
						data, CFG.QLD_HIST_SERVICE, false, "category=1");
				}
				tryFinish();
			},
		);

		const doPhotosQuery = (tok) => {
			const tokenParam = tok ? "&token=" + encodeURIComponent(tok) : "";
			const url =
				CFG.QLD_HIST_PHOTOS_SERVICE + "/query" + geomParam +
				"&where=1%3D1" + tokenParam;
			gmJsonGet(url, {
				headers: {
					Origin:  "https://qldglobe.information.qld.gov.au",
					Referer: "https://qldglobe.information.qld.gov.au/",
				},
			}, (err, data, raw) => {
				if (err) {
					const body = raw && raw.responseText
						? ` ${raw.responseText.slice(0, 200)}` : "";
					console.warn("[CustomTiles] QLD Historical photos",
						err.message,
						tok ? "(token sent)" : "(no token)", body);
					photosCaptures = [];
				} else if (!data || data.error) {
					const e = (data && data.error) || {};
					console.warn(
						"[CustomTiles] QLD Historical photos service error:",
						e.code, e.message || (data ? "" : "null response body"),
						tok ? "(token sent — may be expired or wrong scope)"
						    : "(no token)");
					photosCaptures = [];
				} else {
					photosCaptures = parseCaptures(
						data, CFG.QLD_HIST_PHOTOS_SERVICE, !!tok, null);
					const total = (data.features || []).length;
					const limited = !!data.exceededTransferLimit;
					console.info("[CustomTiles] QLD Historical photos:",
						total, "features",
						limited
							? "(LIMITED — older captures cut off, see maxRecordCount)"
							: "");
				}
				tryFinish();
			});
		};

		if (this._qldToken) {
			this._qldToken.get((err, tok) => doPhotosQuery(err ? null : tok));
		} else {
			doPhotosQuery(null);
		}
	}

	create() {
		const provider = this;
		const TILE_PX = 256;

		const QldHistGrid = L.GridLayer.extend({
			createTile(coords, done) {
				const img = document.createElement("img");
				img.setAttribute("role", "presentation");
				const map = this._map;
				const b = tileToBBox3857(coords.z, coords.x, coords.y);
				const bbox = encodeURIComponent(
					`${b.west},${b.south},${b.east},${b.north}`);

				const myGen = provider._captureGeneration;
				provider._queryCatalog(map, (oid) => {
					if (!oid || provider._captureGeneration !== myGen) {
						done(null, img);
						return;
					}
					const cap = provider._captures[provider._captureIdx];
					const svc = cap ? cap.service : CFG.QLD_HIST_SERVICE;
					const mosaicWhere = cap ? cap.mosaicWhere : "category=1";
					const needsToken = cap && cap.needsToken;
					const tokenStr =
						needsToken && provider._qldToken && provider._qldToken.token
							? "&token=" + encodeURIComponent(provider._qldToken.token)
							: "";
					const mosaicRuleObj = {
						mosaicMethod: "esriMosaicLockRaster",
						lockRasterIds: [oid],
						ascending: true,
					};
					if (mosaicWhere) mosaicRuleObj.where = mosaicWhere;
					const mosaicRule = encodeURIComponent(
						JSON.stringify(mosaicRuleObj),
					);
					img.onload = () => done(null, img);
					img.onerror = () => done(new Error("QLD Hist tile failed"), img);
					img.src =
						svc +
						"/exportImage?bbox=" +
						bbox +
						"&bboxSR=102100&imageSR=102100" +
						"&size=" +
						TILE_PX +
						"%2C" +
						TILE_PX +
						"&format=jpg&mosaicRule=" +
						mosaicRule +
						"&f=image" +
						tokenStr;
				});
				return img;
			},
		});

		const gridLayer = new QldHistGrid({
			maxNativeZoom: 21,
			maxZoom: 25,
			tileSize: TILE_PX,
			keepBuffer: 2,
			attribution:
				"&copy; State of Queensland (Department of Resources) " +
				new Date().getFullYear(),
		});
		this._gridLayerRef = gridLayer;

		gridLayer.getCaptureCount = function () {
			return provider._captures.length;
		};
		gridLayer.getCaptureIdx = function () {
			return provider._captureIdx;
		};
		gridLayer.getCaptureDate = function (idx) {
			const c =
				provider._captures[idx !== undefined ? idx : provider._captureIdx];
			return c ? c.captureDate || null : null;
		};
		gridLayer.setCapture = function (idx) {
			if (
				idx < 0 ||
				idx >= provider._captures.length ||
				idx === provider._captureIdx
			)
				return;
			provider._captureIdx = idx;
			provider._currentOid = provider._captures[idx].objectid;
			provider._captureGeneration++;
			this.fire("capturechange");
			if (provider._redrawTimer) clearTimeout(provider._redrawTimer);
			const self = this;
			provider._redrawTimer = setTimeout(() => {
				provider._redrawTimer = null;
				self.redraw();
			}, 300);
		};

		gridLayer._dwMb3DGetUrl = () => {
			if (provider._currentOid == null) {
				const map = gridLayer._map;
				if (map && !provider._fetching) {
					provider._queryCatalog(map, () => {});
				}
				return null;
			}
			const cap = provider._captures[provider._captureIdx];
			const svc = cap ? cap.service : CFG.QLD_HIST_SERVICE;
			const mosaicWhere = cap ? cap.mosaicWhere : "category=1";
			const needsToken = cap && cap.needsToken;
			const tokStr =
				needsToken && provider._qldToken && provider._qldToken.token
					? "&token=" + encodeURIComponent(provider._qldToken.token)
					: "";
			const mosaicRuleObj = {
				mosaicMethod: "esriMosaicLockRaster",
				lockRasterIds: [provider._currentOid],
				ascending: true,
			};
			if (mosaicWhere) mosaicRuleObj.where = mosaicWhere;
			const mosaicRule = encodeURIComponent(
				JSON.stringify(mosaicRuleObj));
			return svc + "/exportImage?bbox={bbox-epsg-3857}" +
				"&bboxSR=3857&imageSR=3857" +
				"&size=" + TILE_PX + "," + TILE_PX +
				"&format=jpg&mosaicRule=" + mosaicRule +
				"&f=image" + tokStr;
		};
		gridLayer._dwMb3DReloadOn = ["capturechange"];

		const EMPTY_PNG_AB = (() => {
			const b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
			const bin = atob(b64);
			const ab  = new ArrayBuffer(bin.length);
			const u8  = new Uint8Array(ab);
			for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
			return ab;
		})();
		dwRegisterMbLayer(gridLayer, (z, x, y) => new Promise((resolve, reject) => {
			const map = gridLayer._map;
			if (!map) return resolve(EMPTY_PNG_AB);
			const myGen = provider._captureGeneration;
			provider._queryCatalog(map, (oid) => {
				if (!oid || provider._captureGeneration !== myGen) {
					return resolve(EMPTY_PNG_AB);
				}
				const b = tileToBBox3857(z, x, y);
				const bbox = encodeURIComponent(
					`${b.west},${b.south},${b.east},${b.north}`);
				const cap = provider._captures[provider._captureIdx];
				const svc = cap ? cap.service : CFG.QLD_HIST_SERVICE;
				const mosaicWhere = cap ? cap.mosaicWhere : "category=1";
				const needsToken = cap && cap.needsToken;
				const tokenStr =
					needsToken && provider._qldToken && provider._qldToken.token
						? "&token=" + encodeURIComponent(provider._qldToken.token)
						: "";
				const mosaicRuleObj = {
					mosaicMethod: "esriMosaicLockRaster",
					lockRasterIds: [oid],
					ascending: true,
				};
				if (mosaicWhere) mosaicRuleObj.where = mosaicWhere;
				const mosaicRule = encodeURIComponent(
					JSON.stringify(mosaicRuleObj));
				const url =
					svc +
					"/exportImage?bbox=" + bbox +
					"&bboxSR=102100&imageSR=102100" +
					"&size=" + TILE_PX + "%2C" + TILE_PX +
					"&format=jpg&mosaicRule=" + mosaicRule +
					"&f=image" + tokenStr;
				dwMbFetchAB(url).then(resolve, reject);
			});
		}));

		gridLayer.on("add", function () {
			const m = this._map;
			const onMoveEnd = () => {
				if (!provider._lastCenter) return;
				const c = m.getCenter();
				const dist =
					Math.abs(c.lng - provider._lastCenter.lng) +
					Math.abs(c.lat - provider._lastCenter.lat);
				if (dist > 0.1) {
					provider._currentOid = null;
					provider._captures = [];
					provider._captureIdx = 0;
					provider._fetching = false;
					provider._fetchPending = [];
					provider._lastCenter = null;
					if (provider._gridLayerRef) {
						provider._gridLayerRef.fire("capturechange");
						provider._gridLayerRef.redraw();
					}
				}
			};
			m.on("moveend", onMoveEnd);
			this.once("remove", () => m.off("moveend", onMoveEnd));
		});

		return gridLayer;
	}
}
