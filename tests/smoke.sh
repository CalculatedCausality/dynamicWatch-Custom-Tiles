#!/usr/bin/env bash
# Smoke-test every public layer endpoint the userscript depends on.
# Each test fetches one representative tile/response and asserts:
#   1. HTTP 200
#   2. Content-type matches what the script expects
#   3. Response is at least N bytes (catches empty/error JSON masquerading
#      as success)
#
# Auth-gated layers (QLD imagery, Apple Maps) are listed but
# skipped — they need credentials this script doesn't have. If a public
# endpoint regresses upstream, this is the test that fires.
#
# Tile coords are chosen so each layer's representative point sits over
# Brisbane CBD (-27.4698, 153.0251) — that gives non-empty content for
# every Australian-only layer (QLD imagery, INTVL, Marine, Flights). The
# tile (x,y) values come from `tests/compute-tile.mjs` for these zooms:
#   z=8  Brisbane  → 236, 148   (INTVL native max, very low-zoom layers)
#   z=10 Brisbane  → 947, 593   (Strava native max, vector tiles)
#   z=12 Brisbane  → 3789, 2373 (ArcGIS export bbox math)

set -u

# CI mode (-c): no colour, single-column output for log scraping.
CI_MODE=0
if [ "${1:-}" = "-c" ] || [ "${1:-}" = "--ci" ]; then CI_MODE=1; fi
if [ "$CI_MODE" = "1" ]; then
	C_RED=""; C_GREEN=""; C_YELLOW=""; C_DIM=""; C_OFF=""
else
	C_RED=$'\e[31m'; C_GREEN=$'\e[32m'; C_YELLOW=$'\e[33m'; C_DIM=$'\e[2m'; C_OFF=$'\e[0m'
fi

PASS=0; FAIL=0; SKIP=0
# Use a relative path so both cygwin/MSYS curl and Windows-native node
# resolve it the same way (cygwin paths like /tmp/... aren't visible to
# Windows-native node, which led to "missing JSON key" false negatives).
TMP="./.smoke-tmp"
trap 'rm -f "$TMP"' EXIT

log_pass() { printf "  ${C_GREEN}PASS${C_OFF}  %-32s  ${C_DIM}%s${C_OFF}\n" "$1" "$2"; PASS=$((PASS+1)); }
log_fail() { printf "  ${C_RED}FAIL${C_OFF}  %-32s  %s\n" "$1" "$2"; FAIL=$((FAIL+1)); }
log_skip() { printf "  ${C_YELLOW}SKIP${C_OFF}  %-32s  ${C_DIM}%s${C_OFF}\n" "$1" "$2"; SKIP=$((SKIP+1)); }

# probe NAME EXPECT_TYPE MIN_BYTES URL [extra curl args...]
#   EXPECT_TYPE: substring of Content-Type that must match (case-insensitive).
#                Use "" to skip content-type check (some PBF servers omit it
#                or return application/octet-stream).
probe() {
	local name="$1"; local expect="$2"; local min="$3"; local url="$4"; shift 4
	local rsp code ctype size
	rsp=$(curl -sS -o "$TMP" -w "%{http_code}|%{content_type}|%{size_download}" \
		--max-time 20 "$@" "$url" 2>&1) || {
			log_fail "$name" "curl error: $rsp"
			return
		}
	code=$(echo "$rsp" | cut -d'|' -f1)
	ctype=$(echo "$rsp" | cut -d'|' -f2)
	size=$(echo "$rsp" | cut -d'|' -f3)
	local detail="HTTP $code, $ctype, ${size}B"

	if [ "$code" != "200" ]; then
		log_fail "$name" "$detail"; return
	fi
	if [ -n "$expect" ] && ! echo "$ctype" | grep -qi "$expect"; then
		log_fail "$name" "$detail (want type: $expect)"; return
	fi
	if [ "$size" -lt "$min" ]; then
		log_fail "$name" "$detail (want size >= ${min}B)"; return
	fi
	log_pass "$name" "$detail"
}

# JSON body assertion: probe + parse JSON + (optionally) check for an
# expected top-level key. Empty key just validates the body parses.
probe_json() {
	local name="$1"; local key="$2"; local url="$3"; shift 3
	local rsp code ctype size
	rsp=$(curl -sS -o "$TMP" -w "%{http_code}|%{content_type}|%{size_download}" \
		--max-time 20 "$@" "$url" 2>&1) || {
			log_fail "$name" "curl error: $rsp"; return
		}
	code=$(echo "$rsp" | cut -d'|' -f1)
	ctype=$(echo "$rsp" | cut -d'|' -f2)
	size=$(echo "$rsp" | cut -d'|' -f3)
	local detail="HTTP $code, $ctype, ${size}B"
	if [ "$code" != "200" ]; then log_fail "$name" "$detail"; return; fi

	# Validate JSON + optional key path with node. Reading $TMP relative
	# so Windows-native node and cygwin curl agree on the path.
	local err
	err=$(node -e "
		const d = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
		const want = process.argv[2];
		if (!want) {
			// Just a parse check — accept any non-empty object/array.
			if (d == null) { process.stderr.write('null body'); process.exit(1); }
			process.exit(0);
		}
		let cur = d;
		for (const k of want.split('.')) {
			if (cur == null || cur[k] === undefined) {
				process.stderr.write('missing: ' + want);
				process.exit(1);
			}
			cur = cur[k];
		}
	" "$TMP" "$key" 2>&1)
	if [ $? -ne 0 ]; then
		log_fail "$name" "$detail ($err)"; return
	fi
	log_pass "$name" "$detail"
}

echo ""
echo "smoke tests"
echo "==========="
echo ""
echo "${C_DIM}Test point: Brisbane CBD (-27.4698, 153.0251)${C_OFF}"
echo ""
echo "--- Public raster tiles (XYZ) ---"

probe "Google Hybrid"        "image/"     1000 \
	"https://mt0.google.com/vt/lyrs=y&x=947&y=593&z=10"

probe "OpenSeaMap seamarks"  "image/png"   60  \
	"https://tiles.openseamap.org/seamark/10/947/593.png"

probe "Strava heatmap (anon)" "image/png"  60  \
	"https://content-a.strava.com/anon/globalheat/all/blue/11/1894/1186.png?v=19"

# Garmin fans 5 requests per tile (one per activity). All must work
# or the heatmap composite is wrong. Test each activity.
for activity in RUNNING HIKING TRAIL_RUNNING ROAD_CYCLING MOUNTAIN_BIKING; do
	probe "Garmin $activity"      "image/png"  40 \
		"https://connecttile.garmin.com/${activity}/10/947/593.png"
done

probe "QLD Topo (no token)"   "image/"    500  \
	"https://spatial-gis.information.qld.gov.au/arcgis/rest/services/Basemaps/QldMap_Topo/MapServer/tile/10/593/947"

probe "QLD Relief (no token)" "image/"    500  \
	"https://spatial-gis.information.qld.gov.au/arcgis/rest/services/Basemaps/QldMap_Relief/MapServer/tile/10/593/947"

probe "QLD Labels (no token)" "image/"     50  \
	"https://spatial-gis.information.qld.gov.au/arcgis/rest/services/Basemaps/QldImageryLabel/MapServer/tile/12/2373/3789"

probe "Stamen Terrain (Stadia spoof)" "image/png" 50 \
	"https://tiles.stadiamaps.com/tiles/stamen_terrain/10/947/593.png" \
	-H "Origin: http://localhost" -H "Referer: http://localhost/"

# 3D Mode: Mapbox Terrain-DEM v1 — Mapbox GL JS fetches the TileJSON
# first to discover the tile URL pattern. Keep the token out of git;
# run with MAPBOX_TOKEN=pk... to probe this endpoint locally.
if [ -n "${MAPBOX_TOKEN:-}" ]; then
	probe "Mapbox Terrain-DEM v1 TileJSON" "application/json" 500 \
		"https://api.mapbox.com/v4/mapbox.mapbox-terrain-dem-v1.json?access_token=${MAPBOX_TOKEN}" \
		-H "Origin: https://dynamic.watch" -H "Referer: https://dynamic.watch/"
else
	log_skip "Mapbox Terrain-DEM v1 TileJSON" "set MAPBOX_TOKEN to probe terrain TileJSON"
fi
probe "Mapbox GL JS CDN (v3.7.0)"     "javascript" 100000 \
	"https://api.mapbox.com/mapbox-gl-js/v3.7.0/mapbox-gl.js"

echo ""
echo "--- Vector tiles (PBF) ---"

# Vector tile endpoints often ship octet-stream rather than a true MIME —
# accept anything and validate by size only. PBFs over Brisbane at z=10
# are nontrivial because OIM has dense AU power data; even sparse ones
# return >100B header.
probe "INTVL global territories" "" 0  \
	"https://d1yalngj9nsyl4.cloudfront.net/single-player/run/8/236/148.pbf"

probe "OpenInfraMap power"        "" 100 \
	"https://openinframap.org/map/power/10/947/593.pbf"

probe "OpenInfraMap telecoms"     "" 0   \
	"https://openinframap.org/map/telecoms/10/947/593.pbf"

probe "OpenInfraMap water"        "" 0   \
	"https://openinframap.org/map/water/10/947/593.pbf"

echo ""
echo "--- ArcGIS exportImage tiles ---"

# These endpoints accept a 4326 bbox and return a PNG. Bbox covers
# ~Brisbane CBD: 153.00..153.05, -27.50..-27.45.
probe "ACCC Mobile Coverage"  "image/png" 100 \
	"https://spatial.infrastructure.gov.au/server/rest/services/ACCC_Mobile_Sites_and_Coverages/MapServer/export?bbox=153.00,-27.50,153.05,-27.45&bboxSR=4326&imageSR=4326&layers=show:2&size=256,256&format=png32&transparent=true&f=image"

probe "QLD QPWS Estate"       "image/png" 100 \
	"https://spatial-gis.information.qld.gov.au/arcgis/rest/services/Environment/ParksTerrestrialProtectedAreas/MapServer/export?bbox=153.00,-27.50,153.05,-27.45&bboxSR=4326&imageSR=4326&layers=show:10,5,6,7,8,9&size=256,256&format=png32&transparent=true&f=image"

probe "QLD Cadastre"          "image/png" 100 \
	"https://spatial-gis.information.qld.gov.au/arcgis/rest/services/PlanningCadastre/LandParcelPropertyFramework/MapServer/export?bbox=153.00,-27.50,153.05,-27.45&bboxSR=4326&imageSR=4326&layers=show:1&size=256,256&format=png32&transparent=true&f=image"

echo ""
echo "--- WMS ---"

# BBOX must be exactly grid-aligned to the GWC tile cache or it 400s
# with "No SRS specified" (a misleading error). This bbox = z=10 tile
# (947, 593) which is Brisbane. The script computes equivalent bboxes
# via tileToBBox3857, so any URL the script generates lines up.
probe "Light Pollution WMS"   "image/png" 100 \
	"https://www2.lightpollutionmap.info/geoserver/gwc/service/wms?REQUEST=GetMap&SERVICE=WMS&VERSION=1.3.0&FORMAT=image%2Fpng&STYLES=WA&TRANSPARENT=TRUE&LAYERS=PostGIS%3ASB_2025&TILED=true&SRS=EPSG%3A3857&CRS=EPSG%3A3857&WIDTH=256&HEIGHT=256&BBOX=17024054.939683594,-3209132.195526562,17063190.698165625,-3169996.437044531"

echo ""
echo "--- JSON APIs ---"

probe_json "OpenSky flights"  "states" \
	"https://opensky-network.org/api/states/all?lamin=-27.5&lomin=153.0&lamax=-27.4&lomax=153.1"

probe_json "QPWS national-park query" "features" \
	"https://spatial-gis.information.qld.gov.au/arcgis/rest/services/Environment/ParksTerrestrialProtectedAreas/MapServer/10/query?f=geojson&where=esttype+IN+(%27NP%27)&outFields=estatename&geometry=152.9,-27.6,153.1,-27.4&geometryType=esriGeometryEnvelope&inSR=4326&outSR=4326"

probe_json "Esri Wayback catalog" "" \
	"https://s3-us-west-2.amazonaws.com/config.maptiles.arcgis.com/waybackconfig.json"

# Cadastre identify (the hover-identify endpoint behind QLD Cadastre).
# Geometry JSON is URL-encoded so curl doesn't trip on the nested braces.
probe_json "QLD Cadastre /identify" "results" \
	"https://spatial-gis.information.qld.gov.au/arcgis/rest/services/PlanningCadastre/LandParcelPropertyFramework/MapServer/identify?geometry=%7B%22x%22%3A153.025%2C%22y%22%3A-27.47%2C%22spatialReference%22%3A%7B%22wkid%22%3A4326%7D%7D&geometryType=esriGeometryPoint&sr=4326&layers=all%3A8&tolerance=3&mapExtent=152.99%2C-27.5%2C153.05%2C-27.45&imageDisplay=512%2C512%2C96&returnGeometry=false&f=json"

# Cadastre attribute query (used by fetchCadastreAddress) — verify shape.
probe_json "QLD Cadastre attr query" "features" \
	"https://spatial-gis.information.qld.gov.au/arcgis/rest/services/PlanningCadastre/LandParcelPropertyFramework/MapServer/0/query?where=1%3D1&outFields=lotplan&returnGeometry=false&resultRecordCount=1&f=json"

# QLD Historical query — AerialOrtho (no token). Returns capture metadata
# the userscript turns into the timeline scrubber. Public endpoint.
probe_json "QLD AerialOrtho query" "features" \
	"https://spatial-img.information.qld.gov.au/arcgis/rest/services/TimeSeries/AerialOrtho_AllUsers/ImageServer/query?geometry=%7B%22x%22%3A153.0251%2C%22y%22%3A-27.4698%2C%22spatialReference%22%3A%7B%22wkid%22%3A4326%7D%7D&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=objectid%2Cname%2Cyear%2Ctitle%2Ccapturestart&returnGeometry=false&orderByFields=capturestart+DESC&f=json&where=category%3D1&resultRecordCount=5"

# OnTheHouse Sales lookup pipeline — used by cadastre tooltip "Sales ↗"
# link. All three legs are public.
probe_json "OTH locations search"  "content" \
	"https://www.onthehouse.com.au/odin/api/locations?query=161+Queen+St+Brisbane+QLD"
probe_json "OTH property details"  "address" \
	"https://www.onthehouse.com.au/odin/api/properties/4071799"
probe_json "OTH property events"   "content" \
	"https://www.onthehouse.com.au/odin/api/properties/4071799/events"

echo ""
echo "--- Endpoint liveness (auth-gated, but verify they're alive) ---"

# Apple's DuckDuckGo-mediated JWT — public, no auth required.
# Response is a raw JWT string; body matches /^[\w-]+\.[\w-]+\.[\w-]+$/.
probe "Apple DDG JWT"               "javascript"   100 \
	"https://duckduckgo.com/local.js?get_mk_token=1" \
	-H "Referer: https://duckduckgo.com/"

# QLD token endpoint — POST without args returns HTTP 500 + structured
# error JSON. Confirms the endpoint is alive without needing CSRF.
qld_token_rsp=$(curl -sS -o "$TMP" -w "%{http_code}|%{content_type}|%{size_download}" \
	-H "Content-Type: application/json" -X POST -d '{}' --max-time 15 \
	"https://qldglobe.information.qld.gov.au/api/qldglobe/public/token")
qld_token_code=$(echo "$qld_token_rsp" | cut -d'|' -f1)
qld_token_size=$(echo "$qld_token_rsp" | cut -d'|' -f3)
if [ "$qld_token_code" = "500" ] && grep -q '"error"' "$TMP"; then
	log_pass "QLD token endpoint alive" "HTTP 500 + structured error (no CSRF sent)"
else
	log_fail "QLD token endpoint alive" "HTTP $qld_token_code, ${qld_token_size}B (want 500 + error)"
fi

# Geocaching.com — confirm the PUBLIC tile-info UTFGrid endpoint is
# alive without auth. map.info can return HTTP 204 on cold tiles until
# the visible map.png request warms the backend, which is also the order
# the production layer uses.
curl -sS -o /dev/null --max-time 15 \
	-H "Referer: https://www.geocaching.com/play/map" \
	"https://tiles01.geocaching.com/map.png?x=3789&y=2373&z=12" || true
gc_rsp=$(curl -sS -o "$TMP" -w "%{http_code}|%{size_download}" --max-time 15 \
	-H "Referer: https://www.geocaching.com/play/map" \
	"https://tiles01.geocaching.com/map.info?x=3789&y=2373&z=12")
gc_code=$(echo "$gc_rsp" | cut -d'|' -f1)
gc_size=$(echo "$gc_rsp" | cut -d'|' -f2)
if [ "$gc_code" = "200" ] && [ "$gc_size" -gt 1000 ]; then
	log_pass "Geocaching.com UTFGrid"   "HTTP 200, ${gc_size}B (Brisbane z=12 cell-coded cache list)"
else
	log_fail "Geocaching.com UTFGrid"   "HTTP $gc_code, ${gc_size}B (expected 200 with non-trivial body)"
fi
# And map.details — proves the per-cache enrichment path also still works.
gc_det_rsp=$(curl -sS -o "$TMP" -w "%{http_code}|%{size_download}" --max-time 10 \
	-H "Referer: https://www.geocaching.com/play/map" \
	"https://tiles01.geocaching.com/map.details?i=GC60ZN7")
gc_det_code=$(echo "$gc_det_rsp" | cut -d'|' -f1)
gc_det_size=$(echo "$gc_det_rsp" | cut -d'|' -f2)
if [ "$gc_det_code" = "200" ] && [ "$gc_det_size" -gt 100 ]; then
	log_pass "Geocaching.com map.details" "HTTP 200, ${gc_det_size}B (success JSON for GC60ZN7)"
else
	log_fail "Geocaching.com map.details" "HTTP $gc_det_code, ${gc_det_size}B (expected 200)"
fi

echo ""
echo "--- Auth-gated (skipped — need credentials) ---"

log_skip "QLD Globe imagery"       "CSRF+POST token bootstrap required"
log_skip "QLD Roads"               "needs QLD token"
log_skip "QLD Historical photos"   "needs QLD photos token (separate scope)"
log_skip "Apple Maps tiles"        "needs DuckDuckGo JWT → Apple bootstrap (DDG JWT tested above)"
log_skip "Esri Wayback tile"       "needs release num from catalog (catalog tested above)"
log_skip "MarineTraffic vessels"   "Cloudflare-blocked anon, needs browser-realistic session"

echo ""
echo "==========="
printf "  ${C_GREEN}%d passed${C_OFF}, ${C_RED}%d failed${C_OFF}, ${C_YELLOW}%d skipped${C_OFF}\n" \
	"$PASS" "$FAIL" "$SKIP"
exit "$FAIL"
