#!/usr/bin/env bash
# Run the full test suite:
#   1. unit   — pure helpers from the userscript (no network)
#   2. smoke  — quick HTTP + content-type + size probe of every endpoint
#   3. shape  — deep structural validation: PBF decode, JSON field walk,
#               PNG magic-byte sniff
#   4. e2e    — Playwright behavioral asserts (3D Mode marker
#               reprojection, waypoint drag). Skipped if Playwright
#               or auth state aren't available.
#
# Exits with the sum of failures. Pass --ci / -c for plain output.

set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
CI_ARG=""
if [ "${1:-}" = "--ci" ] || [ "${1:-}" = "-c" ]; then CI_ARG="-c"; fi

echo "############################################################"
echo "# 1. unit tests (pure helpers, no network)"
echo "############################################################"
node "$HERE/unit.mjs"
UNIT_RC=$?

echo ""
echo "############################################################"
echo "# 2. smoke tests (public endpoints — HTTP + type + size)"
echo "############################################################"
bash "$HERE/smoke.sh" $CI_ARG
SMOKE_RC=$?

echo ""
echo "############################################################"
echo "# 3. shape tests (deep structural validation)"
echo "############################################################"
node "$HERE/shape.mjs" $CI_ARG
SHAPE_RC=$?

echo ""
echo "############################################################"
echo "# 4. e2e tests (Playwright 3D Mode asserts)"
echo "############################################################"
if [ ! -d "$REPO/node_modules/playwright" ]; then
	echo "SKIP — Playwright not installed (\`npm install && npm run e2e:install\`)"
	E2E_RC=0
elif [ ! -f "$REPO/.auth/storage.json" ]; then
	echo "SKIP — no auth state at .auth/storage.json (\`npm run e2e:auth\`)"
	E2E_RC=0
else
	# cd into the repo so node sees a clean relative path — bash on
	# Windows otherwise mangles MSYS-style absolute paths.
	( cd "$REPO" && MSYS_NO_PATHCONV=1 PLAN="/plan/2344645" node tests/e2e/run-3d-asserts.mjs )
	E2E_RC=$?
fi

echo ""
echo "############################################################"
echo "# overall: unit=${UNIT_RC} smoke=${SMOKE_RC} shape=${SHAPE_RC} e2e=${E2E_RC}"
echo "############################################################"
exit $(( UNIT_RC + SMOKE_RC + SHAPE_RC + E2E_RC ))
