import { CFG } from "../config.js";
import { LayerProvider } from "../layers/provider-factories.js";
import { arcgisIdentify, arcgisEnvelopeQuery } from "../layers/hover-identify.js";
import { tileToBBox4326 } from "../utils/tile-geometry.js";
import { _cadVal, _ensureSalesHook, fetchCadastreAddress } from "./qld-cadastre.js";

/* -- Unified Australia cadastre ---------------------------------------
 * One "Australia Cadastre" overlay + click-identify that spans every
 * state/territory. The visible boundary overlay is stitched per-tile
 * from each jurisdiction's ArcGIS /export service (they render at normal
 * zoom), falling back to the national Geoscape service for WA/ACT/NT
 * (which have no free /export). Clicking a parcel routes to that
 * jurisdiction's identify service and normalises its fields into the
 * QLD-shaped attrs object `_formatCadastreTooltip` already renders, plus
 * an addressInfo the OnTheHouse sales lookup can consume.
 *
 * Field mappings were verified against each live service (Jul 2026):
 *   NSW parcel  maps.six.nsw.gov.au .../NSW_Cadastre/MapServer/9   lotidstring, planlotarea
 *   NSW address portal.spatial.nsw.gov.au .../FeatureServer/12      address, housenumber
 *   VIC parcel  plan-gis.mapshare.vic.gov.au .../MapServer/4        PARCEL_SPI  (point-query fails → envelope)
 *   VIC address .../MapServer/3                                     ADD_HOUSE_NUMBER_1/ADD_ROAD_NAME/ADD_ROAD_TYPE/ADD_LOCALITY_NAME
 *   SA  parcel  lsa4.geohub.sa.gov.au .../MapServer/124             planparcel, st_area(shape)
 *   SA  suburb  .../MapServer/19                                    suburb, postcode
 *   TAS parcel  services.thelist.tas.gov.au .../CadastreParcels/0   LPI, COMP_AREA, PROP_ADD
 *   ACT block   services1.arcgis.com/.../ACTGOV_BLOCKS/0            BLOCK_NUMBER/SECTION_NUMBER, ADDRESSES, DIVISION_NAME
 *   WA/NT       national CADASTRE_AUS                               JURISDICTION_ID, LOCALITY_NAME, LGA_NAME (locality only)
 */

// Per-jurisdiction service endpoints (fully-qualified layer URLs for
// identify; MapServer roots for /export).
const SVC = {
	NSW_PARCEL: "https://maps.six.nsw.gov.au/arcgis/rest/services/public/NSW_Cadastre/MapServer",
	NSW_ADDR:   "https://portal.spatial.nsw.gov.au/server/rest/services/NSW_Land_Parcel_Property_Theme/FeatureServer/12",
	VIC:        "https://plan-gis.mapshare.vic.gov.au/arcgis/rest/services/Planning/VicPlan_PropertyAndParcel/MapServer",
	SA:         "https://lsa4.geohub.sa.gov.au/server/rest/services/LSA/LocationSAViewerV34/MapServer",
	TAS:        "https://services.thelist.tas.gov.au/arcgis/rest/services/Public/CadastreParcels/MapServer",
	ACT:        "https://services1.arcgis.com/E5n4f1VY84i0xSjy/arcgis/rest/services/ACTGOV_BLOCKS/FeatureServer/0",
	WA_SLIP:    "https://public-services.slip.wa.gov.au/public/rest/services/SLIP_Public_Services/Property_and_Planning/MapServer",
};
const NAT_LAYER = CFG.NATIONAL_CADASTRE_SERVICE + "/" + CFG.NATIONAL_CADASTRE_LAYER;

/* -- Small helpers ---------------------------------------------------- */

function _titleCase(s) {
	const v = _cadVal(s);
	return v ? v.toLowerCase().replace(/\b([a-z])/g, (_, c) => c.toUpperCase()) : "";
}
function _num(v) { const n = parseFloat(v); return isFinite(n) ? n : NaN; }

// Street-type tokens (long + abbreviated) used to split a flat address
// string like "2 CHURCHILL AV SANDY BAY" into name/type/locality.
const _ST_TYPES = new Set([
	"STREET", "ST", "ROAD", "RD", "AVENUE", "AVE", "AV", "DRIVE", "DR", "DRV",
	"LANE", "LA", "LN", "CRESCENT", "CRES", "CR", "PLACE", "PL", "TERRACE", "TCE",
	"COURT", "CT", "CRT", "BOULEVARD", "BOULEVARDE", "BVD", "BLVD", "CIRCUIT", "CCT",
	"HIGHWAY", "HWY", "PARADE", "PDE", "CLOSE", "CL", "WAY", "ESPLANADE", "ESP",
	"QUAY", "QY", "CIRCLE", "CIR", "CIRCUS", "LINK", "LNK", "MEWS", "SQUARE", "SQ",
	"WALK", "WLK", "ARCADE", "ARC", "ALLEY", "ROW", "VIEW", "VW", "RIDGE", "RDGE",
	"RISE", "BEND", "LOOP", "TRACK", "TRK", "TRAIL", "TRL", "GROVE", "GR", "GRV",
	"GARDENS", "GDNS", "PARKWAY", "PKWY", "PROMENADE", "PROM", "CROSS", "GATE",
	"GLEN", "GREEN", "GRANGE", "HEIGHTS", "HTS", "PARK", "PLAZA", "POCKET", "RESERVE",
]);

// Parse a flat AU address string into OnTheHouse-query parts. Handles a
// trailing "STATE POSTCODE" (TAS packs it in) and a unit form (5/12 → 12).
// `knownLocality` (e.g. ACT's DIVISION_NAME) wins over any parsed suburb.
export function _parseAuStreetAddress(full, knownLocality) {
	let s = String(full || "").toUpperCase().replace(/,/g, " ").trim();
	if (!s) return null;
	s = s.replace(/\s+(NSW|QLD|VIC|SA|WA|TAS|NT|ACT)\b/g, " ")
		.replace(/\s+\d{4}\b/g, " ")
		.replace(/\s+/g, " ").trim();
	const tokens = s.split(" ").filter(Boolean);
	if (!tokens.length) return null;
	let num = tokens.shift();
	if (num.includes("/")) num = num.split("/").pop(); // 5/12 → 12 (street no.)
	if (!/^\d+[A-Z]?$/.test(num)) return null; // no leading number → OTH can't resolve
	let typeIdx = -1;
	for (let i = 0; i < tokens.length; i++) {
		if (_ST_TYPES.has(tokens[i])) { typeIdx = i; break; }
	}
	const known = _cadVal(knownLocality).toUpperCase();
	let streetName, streetType, locality;
	if (typeIdx >= 0) {
		streetName = tokens.slice(0, typeIdx).join(" ");
		streetType = tokens[typeIdx];
		locality = known || tokens.slice(typeIdx + 1).join(" ");
	} else {
		streetName = tokens.join(" ");
		streetType = "";
		locality = known;
	}
	if (!streetName) return null;
	return { streetNumber: num, streetName, streetType, locality };
}

// Build the QLD-aliased attrs object `_formatCadastreTooltip` renders.
function _mkAttrs(o) {
	const a = {};
	const lotplan = _cadVal(o.lotplan);
	if (lotplan) a["Lot/plan"] = lotplan;
	const name = _cadVal(o.name);
	if (name) a.Name = name;
	const tenure = _cadVal(o.tenure);
	if (tenure) a.Tenure = tenure;
	const parcelType = _cadVal(o.parcelType);
	if (parcelType) a["Parcel type"] = parcelType;
	if (isFinite(o.areaM2) && o.areaM2 > 0) a["Lot area (m²)"] = o.areaM2;
	const locality = _cadVal(o.locality);
	if (locality) a.Locality = locality;
	const lga = _cadVal(o.lga);
	if (lga) a["Local authority"] = lga;
	return a;
}

function _mkAddressInfo(parsed, latlng, state, primary) {
	return {
		primary: _cadVal(primary) ||
			[parsed.streetNumber, _titleCase(parsed.streetName), _titleCase(parsed.streetType)]
				.filter(Boolean).join(" "),
		extra: "",
		state,
		lat: latlng.lat,
		lon: latlng.lng,
		streetNumber: parsed.streetNumber || "",
		streetName: parsed.streetName || "",
		streetType: parsed.streetType || "",
		locality: parsed.locality || "",
	};
}

/* -- Jurisdiction routing (bounding boxes) ----------------------------
 * Ordered so enclaves/islands resolve first: ACT sits inside NSW, TAS is
 * separate, and the western sliver (<141°E) is SA before NSW/VIC/QLD.
 */
const _BBOX = {
	ACT: [148.75, -35.95, 149.42, -35.10],
	TAS: [143.75, -43.75, 148.55, -39.15],
	NT:  [128.95, -26.01, 138.05, -10.90],
	WA:  [112.90, -35.20, 129.01, -13.50],
	SA:  [128.95, -38.10, 141.03, -25.95],
	QLD: [137.95, -29.20, 153.60, -9.10],
	VIC: [140.95, -39.25, 150.05, -33.95],
	NSW: [140.95, -37.55, 153.70, -28.10],
};
const _ORDER = ["ACT", "TAS", "NT", "WA", "SA", "QLD", "VIC", "NSW"];

export function _pickJurisdiction(lat, lng) {
	for (const code of _ORDER) {
		const b = _BBOX[code];
		if (lng >= b[0] && lng <= b[2] && lat >= b[1] && lat <= b[3]) return code;
	}
	return "";
}

/* -- Overlay: per-tile export routing --------------------------------- */

const _NAT_OVL = { url: CFG.NATIONAL_CADASTRE_SERVICE, layers: "show:" + CFG.NATIONAL_CADASTRE_LAYER };
const _OVL = {
	QLD: { url: CFG.QLD_CADASTRE_SERVICE, layers: "show:" + CFG.QLD_CADASTRE_LAYER_ID },
	NSW: { url: SVC.NSW_PARCEL, layers: "show:9" },
	VIC: { url: SVC.VIC, layers: "show:4" },
	SA:  { url: SVC.SA, layers: "show:124" },
	TAS: { url: SVC.TAS, layers: "show:0" },
	WA:  { url: SVC.WA_SLIP, layers: "show:2" },  // geometry-only, renders from ~z6
	ACT: _NAT_OVL,                                 // no free /export → national (z17)
	NT:  _NAT_OVL,                                 // WMS-only → national (z17)
};

export class AustraliaCadastreLayerProvider extends LayerProvider {
	create() { return _makeUnifiedCadastreLayer(); }
}

function _makeUnifiedCadastreLayer() {
	const pane = "dwCadastrePane", paneZ = 385;
	const Layer = L.TileLayer.extend({
		onAdd(map) {
			if (!map.getPane(pane)) {
				map.createPane(pane);
				const el = map.getPane(pane);
				el.style.zIndex = String(paneZ);
				el.style.pointerEvents = "none"; // clicks fall through to the map
			}
			L.TileLayer.prototype.onAdd.call(this, map);
			_ensureSalesHook(map);
		},
		getTileUrl(coords) {
			const bb = tileToBBox4326(coords.z, coords.x, coords.y);
			const cfg = _OVL[_pickJurisdiction(
				(bb.minLat + bb.maxLat) / 2, (bb.minLon + bb.maxLon) / 2,
			)] || _NAT_OVL;
			return (
				`${cfg.url}/export?` +
				`bbox=${bb.minLon},${bb.minLat},${bb.maxLon},${bb.maxLat}` +
				`&bboxSR=4326&imageSR=4326&layers=${cfg.layers}` +
				`&size=256,256&format=png32&transparent=true&f=image`
			);
		},
	});
	return new Layer("", {
		opacity: 0.75,
		minZoom: CFG.CADASTRE_MIN_ZOOM,
		maxZoom: 25,
		maxNativeZoom: 21,
		tileSize: 256,
		pane,
		attribution:
			'Cadastre &copy; State/Territory land agencies &amp; ' +
			'<a href="https://geoscape.com.au/legal/data-copyright-and-disclaimer/" ' +
			'target="_blank" rel="noreferrer">Geoscape Australia</a>',
	});
}

/* -- Identify adapters (raw service fields → {attrs, addressInfo}) -----
 * Each calls cb once with parcel attrs, and again (for the states whose
 * address lives on a separate query) with addressInfo attached. cb(null)
 * when nothing is found. All are best-effort: a missing address just
 * omits the sales lookup.
 */

function _adaptQLD(map, latlng, state, cb) {
	arcgisIdentify(map, latlng, {
		baseUrl: CFG.QLD_CADASTRE_SERVICE,
		layers: "all:" + CFG.QLD_CADASTRE_IDENTIFY_LAYER,
		tolerance: 3,
	}, (err, feat) => {
		if (err || !feat) { cb(null); return; }
		const attrs = feat.attributes || {}; // already QLD-aliased by the service
		cb({ attrs, state: "QLD" });
		const lotplan = _cadVal(attrs["Lot/plan"]);
		if (!lotplan) return;
		fetchCadastreAddress(lotplan, (info) => {
			if (info) cb({ attrs, addressInfo: info, state: "QLD" });
		});
	});
}

function _adaptNSW(map, latlng, state, cb) {
	arcgisEnvelopeQuery(SVC.NSW_PARCEL + "/9", latlng, {
		outFields: "lotidstring,planlotarea,planlotareaunits",
	}, (err, a) => {
		if (err || !a) { cb(null); return; }
		const areaM2 = /meter/i.test(a.planlotareaunits || "") ? _num(a.planlotarea) : NaN;
		const attrs = _mkAttrs({ lotplan: a.lotidstring, areaM2 });
		cb({ attrs, state: "NSW" });
		arcgisEnvelopeQuery(SVC.NSW_ADDR, latlng, { outFields: "address,housenumber" }, (e2, ad) => {
			if (e2 || !ad || !ad.address) return;
			const parsed = _parseAuStreetAddress(ad.address);
			if (!parsed) return;
			cb({
				attrs: Object.assign({}, attrs,
					parsed.locality ? { Locality: _titleCase(parsed.locality) } : {}),
				addressInfo: _mkAddressInfo(parsed, latlng, "NSW", ad.address),
				state: "NSW",
			});
		});
	});
}

function _adaptVIC(map, latlng, state, cb) {
	arcgisEnvelopeQuery(SVC.VIC + "/4", latlng, {
		outFields: "PARCEL_SPI,PARCEL_LOT_NUMBER,PARCEL_PLAN_NUMBER",
	}, (err, a) => {
		if (err || !a) { cb(null); return; }
		// VIC's Shape_Area is in square-degrees (geographic SR) — unusable,
		// so no area line for VIC.
		const attrs = _mkAttrs({ lotplan: _cadVal(a.PARCEL_SPI) });
		cb({ attrs, state: "VIC" });
		arcgisEnvelopeQuery(SVC.VIC + "/3", latlng, {
			outFields: "ADD_HOUSE_NUMBER_1,ADD_ROAD_NAME,ADD_ROAD_TYPE,ADD_LOCALITY_NAME,ADD_EZI_ADDRESS",
		}, (e2, p) => {
			if (e2 || !p) return;
			const parsed = {
				streetNumber: _cadVal(p.ADD_HOUSE_NUMBER_1),
				streetName: _cadVal(p.ADD_ROAD_NAME),
				streetType: _cadVal(p.ADD_ROAD_TYPE),
				locality: _cadVal(p.ADD_LOCALITY_NAME),
			};
			if (!parsed.streetNumber || !parsed.streetName) return;
			cb({
				attrs: Object.assign({}, attrs,
					parsed.locality ? { Locality: _titleCase(parsed.locality) } : {}),
				addressInfo: _mkAddressInfo(parsed, latlng, "VIC", p.ADD_EZI_ADDRESS),
				state: "VIC",
			});
		});
	});
}

function _adaptSA(map, latlng, state, cb) {
	arcgisEnvelopeQuery(SVC.SA + "/124", latlng, {
		outFields: "planparcel,st_area(shape)",
	}, (err, a) => {
		if (err || !a) { cb(null); return; }
		const attrs = _mkAttrs({ lotplan: a.planparcel, areaM2: _num(a["st_area(shape)"]) });
		cb({ attrs, state: "SA" });
		// SA parcels carry no street address (would need the address-point
		// layer group), so suburb-only — no OnTheHouse sales.
		arcgisEnvelopeQuery(SVC.SA + "/19", latlng, { outFields: "suburb,postcode" }, (e2, s) => {
			if (e2 || !s || !s.suburb) return;
			cb({ attrs: Object.assign({}, attrs, { Locality: _titleCase(s.suburb) }), state: "SA" });
		});
	});
}

function _adaptTAS(map, latlng, state, cb) {
	arcgisEnvelopeQuery(SVC.TAS + "/0", latlng, {
		outFields: "LPI,VOLUME,FOLIO,COMP_AREA,PROP_ADD",
	}, (err, a) => {
		if (err || !a) { cb(null); return; }
		const lotplan = _cadVal(a.LPI) ||
			(_cadVal(a.VOLUME) ? `Vol ${_cadVal(a.VOLUME)}/${_cadVal(a.FOLIO)}` : "");
		const parsed = a.PROP_ADD ? _parseAuStreetAddress(a.PROP_ADD) : null;
		const attrs = _mkAttrs({
			lotplan, areaM2: _num(a.COMP_AREA),
			locality: parsed ? _titleCase(parsed.locality) : "",
		});
		cb({
			attrs,
			addressInfo: parsed ? _mkAddressInfo(parsed, latlng, "TAS", a.PROP_ADD) : undefined,
			state: "TAS",
		});
	});
}

function _adaptACT(map, latlng, state, cb) {
	arcgisEnvelopeQuery(SVC.ACT, latlng, {
		outFields: "BLOCK_NUMBER,SECTION_NUMBER,BLOCK_DERIVED_AREA,Shape__Area,ADDRESSES,DIVISION_NAME,TYPE",
	}, (err, a) => {
		if (err || !a) { cb(null); return; }
		const lotplan = (a.BLOCK_NUMBER != null && a.SECTION_NUMBER != null)
			? `Block ${a.BLOCK_NUMBER} Section ${a.SECTION_NUMBER}` : "";
		const parsed = a.ADDRESSES
			? _parseAuStreetAddress(a.ADDRESSES, _cadVal(a.DIVISION_NAME)) : null;
		const attrs = _mkAttrs({
			lotplan,
			areaM2: _num(a.BLOCK_DERIVED_AREA) || _num(a.Shape__Area),
			locality: _titleCase(a.DIVISION_NAME),
			parcelType: _titleCase(a.TYPE),
		});
		cb({
			attrs,
			addressInfo: parsed ? _mkAddressInfo(parsed, latlng, "ACT", a.ADDRESSES) : undefined,
			state: "ACT",
		});
	});
}

// WA + NT: no free rich attribute source. The national Geoscape service
// gives locality/LGA/parcel-type and a jurisdiction parcel id (no street
// address → no sales). `JURISDICTION_ID` formats vary; strip padding and
// any "~" suffix VIC-style noise.
function _adaptNational(map, latlng, state, cb) {
	arcgisEnvelopeQuery(NAT_LAYER, latlng, {
		outFields: "STATE_ABBREVIATION,JURISDICTION_ID,LOCALITY_NAME,LGA_NAME,PARCEL_TYPE_NAME",
		halfDeg: 0.00003,
	}, (err, a) => {
		if (err || !a) { cb(null); return; }
		const attrs = _mkAttrs({
			lotplan: String(a.JURISDICTION_ID || "").replace(/~.*$/, "").replace(/\s+/g, " ").trim(),
			locality: _titleCase(a.LOCALITY_NAME),
			lga: _titleCase(a.LGA_NAME),
			parcelType: _titleCase(a.PARCEL_TYPE_NAME),
		});
		cb({ attrs, state: _cadVal(a.STATE_ABBREVIATION) || state });
	});
}

const _ADAPTERS = {
	QLD: _adaptQLD, NSW: _adaptNSW, VIC: _adaptVIC, SA: _adaptSA,
	TAS: _adaptTAS, ACT: _adaptACT, WA: _adaptNational, NT: _adaptNational,
};

// Resolve the parcel under a click across all jurisdictions. cb is called
// with { attrs, addressInfo?, state } — possibly twice (parcel first, then
// with addressInfo) — or cb(null) when the point isn't on a parcel.
export function fetchCadastreParcel(map, latlng, cb) {
	const state = _pickJurisdiction(latlng.lat, latlng.lng);
	const adapter = _ADAPTERS[state] || _adaptNational;
	adapter(map, latlng, state, cb);
}
