import { gmJsonGet } from "../utils/http.js";

// One-shot ArcGIS point identify. Used by hover identify and popup enrichment.
export function arcgisIdentify(map, latlng, opts, cb) {
	const size  = map.getSize();
	const b     = map.getBounds();
	const mapExtent    = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].join(",");
	const imageDisplay = `${size.x},${size.y},96`;
	const geometry = encodeURIComponent(JSON.stringify({
		x: latlng.lng, y: latlng.lat, spatialReference: { wkid: 4326 },
	}));
	const url =
		`${opts.baseUrl}/identify` +
		`?geometry=${geometry}` +
		`&geometryType=esriGeometryPoint&sr=4326` +
		`&layers=${opts.layers}` +
		`&tolerance=${opts.tolerance || 3}` +
		`&mapExtent=${mapExtent}` +
		`&imageDisplay=${imageDisplay}` +
		`&returnGeometry=false&f=json`;
	gmJsonGet(url, (err, data) => {
		if (err) { cb(err, null); return; }
		cb(null, (data.results || [])[0] || null);
	});
}

export function makeHoverIdentify(opts) {
	const debounceMs = opts.debounceMs || 200;
	return function install(layer, map) {
		const tooltip = L.tooltip({
			sticky:    true,
			opacity:   0.95,
			className: opts.tipClass,
			direction: "right",
			offset:    [12, 0],
		});
		let lastOid = null;
		let lastAttrs = null;
		let debounce = null;
		let gen = 0;

		const clearTip = () => {
			if (tooltip._map) tooltip.remove();
			lastOid = null;
			lastAttrs = null;
		};

		const identify = (latlng) => {
			const myGen = ++gen;
			arcgisIdentify(map, latlng, opts, (err, feat) => {
				if (err) return;
				if (myGen !== gen) return;
				if (!feat) { clearTip(); return; }
				const attrs = feat.attributes || {};
				const oid =
					attrs["Object ID"] || attrs.OBJECTID || JSON.stringify(attrs);
				if (oid === lastOid && tooltip._map) {
					tooltip.setLatLng(latlng);
					return;
				}
				lastOid = oid;
				lastAttrs = attrs;
				tooltip.setLatLng(latlng).setContent(opts.formatTooltip(attrs));
				if (!tooltip._map) tooltip.addTo(map);

				if (opts.afterRender) {
					opts.afterRender(attrs, {
						isCurrent: () =>
							myGen === gen && !!tooltip._map && lastAttrs === attrs,
						setContent: (html) => tooltip.setContent(html),
					});
				}
			});
		};

		const onMove = (e) => {
			if (map.getZoom() < opts.minZoom) { clearTip(); return; }
			clearTimeout(debounce);
			const latlng = e.latlng;
			debounce = setTimeout(() => identify(latlng), debounceMs);
		};
		const onLeave = () => {
			clearTimeout(debounce);
			gen++;
			clearTip();
		};

		map.on("mousemove", onMove);
		map.on("mouseout",  onLeave);

		layer._dwHoverOff = () => {
			clearTimeout(debounce);
			gen++;
			map.off("mousemove", onMove);
			map.off("mouseout",  onLeave);
			clearTip();
		};
	};
}
