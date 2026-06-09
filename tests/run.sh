#!/usr/bin/env bash
# Run the full test suite:
#   1. unit  — pure helpers from the userscript (no network)
#   2. smoke — quick HTTP + content-type + size probe of every endpoint
#   3. shape — deep structural validation: PBF decode, JSON field walk,
#              PNG magic-byte sniff
#
# Exits with the sum of failures. Pass --ci / -c for plain output.

set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
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
echo "# overall: unit=${UNIT_RC} smoke=${SMOKE_RC} shape=${SHAPE_RC}"
echo "############################################################"
exit $(( UNIT_RC + SMOKE_RC + SHAPE_RC ))
