#!/usr/bin/env bash
# Offline unit/source regressions and synthetic report browser check by default.
# --live runs endpoint smoke/shape and auth-dependent 3D/raster checks instead;
# --all runs both. --ci / -c keeps output plain for CI logs.
# Exits with the sum of suite exit codes (subject to the shell's 0–255 limit).

set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
MODE=offline
CI_ARG=""
CI_ARGS=()
for arg in "$@"; do
	case "$arg" in
		--live) MODE=live ;;
		--all) MODE=all ;;
		--ci|-c) CI_ARG=-c; CI_ARGS=(-c) ;;
		*) echo "Usage: bash tests/run.sh [--live|--all] [--ci|-c]" >&2; exit 2 ;;
	esac
done

TOTAL_RC=0
RUN_RC=0
section() {
	echo ""
	echo "############################################################"
	echo "# $1"
	echo "############################################################"
}
run_suite() {
	section "$1"
	shift
	"$@"
	RUN_RC=$?
	TOTAL_RC=$(( TOTAL_RC + RUN_RC ))
}
run_browser() {
	# Playwright errors can contain ANSI even in CI; preserve Node's exit code.
	if [ -n "$CI_ARG" ]; then
		( cd "$REPO" && MSYS_NO_PATHCONV=1 PLAN="/plan/2344645" node "$1" ) 2>&1 | sed -E $'s/\033\\[[0-9;]*m//g'
		RUN_RC=${PIPESTATUS[0]}
	else
		( cd "$REPO" && MSYS_NO_PATHCONV=1 PLAN="/plan/2344645" node "$1" )
		RUN_RC=$?
	fi
	TOTAL_RC=$(( TOTAL_RC + RUN_RC ))
}
playwright_available() {
	( cd "$REPO" && node --input-type=module -e '
		import { existsSync } from "node:fs";
		try {
			const { chromium } = await import("playwright");
			if (!existsSync(chromium.executablePath())) process.exit(1);
		} catch { process.exit(1); }
	' )
}

if [ "$MODE" != live ]; then
	section "unit tests (pure helpers, no network)"
	if [ -n "$CI_ARG" ]; then
		# unit.mjs always prints ANSI colours; strip them without masking its exit code.
		node "$HERE/unit.mjs" | sed -E $'s/\033\\[[0-9;]*m//g'
		RUN_RC=${PIPESTATUS[0]}
		TOTAL_RC=$(( TOTAL_RC + RUN_RC ))
	else
		node "$HERE/unit.mjs"
		RUN_RC=$?
		TOTAL_RC=$(( TOTAL_RC + RUN_RC ))
	fi
	UNIT_RC=$RUN_RC

	run_suite "source regressions (no network)" node --test \
		"$HERE/polling-data-layer.mjs" "$HERE/viewport-layers.mjs" \
		"$HERE/vexcel-capture.mjs" "$HERE/vexcel-tile-batch.mjs" \
		"$HERE/vexcel-http.mjs" "$HERE/vexcel-protocol-report.mjs" \
		"$HERE/vexcel-cache.mjs" "$HERE/vexcel-csv.mjs" "$HERE/lightpoll-token.mjs"
	REGRESSION_RC=$RUN_RC

	run_suite "secret and repository hygiene checks (no network)" node "$HERE/check-secrets.mjs"
	SECRETS_RC=$RUN_RC

	section "synthetic Vexcel report in Chromium (local files only)"
	# A missing package or browser binary is an unavailable Playwright installation.
	# Any failure once available is a real E2E failure, not an optional skip.
	if playwright_available; then
		run_browser tests/e2e/verify-vexcel-report.mjs
		REPORT_RC=$RUN_RC
	else
		echo 'SKIP — Playwright or Chromium unavailable (`npm install && npm run e2e:install`)'
		REPORT_RC=0
	fi
	section "offline: unit=${UNIT_RC} regressions=${REGRESSION_RC} secrets=${SECRETS_RC} report=${REPORT_RC}"
fi

if [ "$MODE" != offline ]; then
	run_suite "smoke tests (public endpoints — HTTP + type + size)" bash "$HERE/smoke.sh" "${CI_ARGS[@]}"
	SMOKE_RC=$RUN_RC

	run_suite "shape tests (live structural validation)" node "$HERE/shape.mjs" "${CI_ARGS[@]}"
	SHAPE_RC=$RUN_RC

	section "auth-dependent 3D and normal-CORS raster browser checks"
	if [ ! -f "$REPO/.auth/storage.json" ]; then
		echo 'SKIP — no auth state at .auth/storage.json (`npm run e2e:auth`)'
		THREED_RC=0
		RASTER_RC=0
	elif ! playwright_available; then
		echo 'SKIP — Playwright or Chromium unavailable (`npm install && npm run e2e:install`)'
		THREED_RC=0
		RASTER_RC=0
	else
		# The repo-relative paths avoid MSYS conversion of Windows-native Node paths.
		run_browser tests/e2e/run-3d-asserts.mjs
		THREED_RC=$RUN_RC
		run_browser tests/e2e/verify-raster-security.mjs
		RASTER_RC=$RUN_RC
	fi
	section "live: smoke=${SMOKE_RC} shape=${SHAPE_RC} 3d=${THREED_RC} raster=${RASTER_RC}"
fi

echo "# overall exit-code sum: ${TOTAL_RC}"
exit "$TOTAL_RC"
