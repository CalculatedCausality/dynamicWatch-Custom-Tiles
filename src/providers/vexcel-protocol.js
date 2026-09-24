// Vexcel oriented imagery protocol data and request bodies. No browser, auth,
// transport, or Node dependencies: the CLI and provider can use the same shape.
export const VEXCEL_DIRECTIONS = [
	{ key: "oblique-north", label: "N" },
	{ key: "oblique-east",  label: "E" },
	{ key: "oblique-south", label: "S" },
	{ key: "oblique-west",  label: "W" },
	{ key: "nadir",         label: "Top" },
];

export function _vexcelCollectionYear(collection) {
	const m = String(collection || "").match(/(\d{4})(?!.*\d{4})/);
	return m ? m[1] : String(collection || "");
}

export function _vexcelBand(name) {
	return /_irg$/i.test(String(name || "")) ? "irg" : "rgb";
}

export function vexcelPointWkt(lng, lat) {
	return `POINT(${Number(lng)} ${Number(lat)})`;
}

// The unfiltered query returns every capture and direction at a point, in
// nearest-frame-first order so consumers can keep the first photo per cell.
export function vexcelOrientedQueryBody(lat, lng) {
	return {
		wkt: vexcelPointWkt(lng, lat),
		srid: "4326",
		layer: "wide-area,urban",
		"order-by": "image-center-distance-asc",
		include: "collection,capture-date,product-type,image-name," +
			"source-layer,raster-size-width,raster-size-height,geometry",
	};
}

export function vexcelFrameQueryBody(lng, lat, collection, dir, band) {
	const query = {
		wkt: vexcelPointWkt(lng, lat),
		srid: "4326", layer: "wide-area,urban",
		"product-type": dir, bands: band || "rgb",
		"order-by": "image-center-distance-asc", "total-records": 1,
		include: "image-name,source-layer,raster-size-width," +
			"raster-size-height,geometry",
	};
	if (collection) query.collection = collection;
	return query;
}
