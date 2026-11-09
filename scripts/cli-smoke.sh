#!/usr/bin/env bash
# The install-surface proof for @getpharos/cli (roadmap amendment 7b): pack the tarball, install
# it into an EMPTY project with npm (not pnpm, not the workspace), and run every command the
# README promises, timed. This is what `npx @getpharos/cli` will do for a stranger.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG="$ROOT/packages/cli"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/pharos-cli-smoke.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

echo "== build + pack"
(cd "$PKG" && pnpm run build >/dev/null && pnpm pack --pack-destination "$WORK" >/dev/null)
TARBALL="$(ls "$WORK"/getpharos-cli-*.tgz)"
echo "   $(basename "$TARBALL") ($(du -h "$TARBALL" | cut -f1))"

echo "== install into an empty project with npm"
mkdir -p "$WORK/app" && cd "$WORK/app"
npm init -y >/dev/null
START=$(date +%s)
npm install --no-audit --no-fund --loglevel=error "$TARBALL" >/dev/null
echo "   installed in $(( $(date +%s) - START ))s; deps: $(ls node_modules | grep -v '^\.' | wc -l | tr -d ' ') packages"
test -x node_modules/.bin/pharos

echo "== pharos init && pharos demo (timed)"
START=$(date +%s%N)
npx --no-install pharos init
npx --no-install pharos demo | tee demo.out
ELAPSED_MS=$(( ($(date +%s%N) - START) / 1000000 ))
echo "   init+demo: ${ELAPSED_MS} ms"
grep -q "BLOCK" demo.out
grep -q "ESCALATE" demo.out
grep -q "chain verified" demo.out
test -f evidence-bundle.json

echo "== pharos log / verify / export"
npx --no-install pharos log | tee log.out
grep -q "#2" log.out
npx --no-install pharos verify evidence-bundle.json
npx --no-install pharos export --out exported.json
npx --no-install pharos verify exported.json >/dev/null

echo "== a tampered bundle must FAIL (exit 1)"
sed -i.bak 's/"amount": 30000/"amount": 99999/' evidence-bundle.json
if npx --no-install pharos verify evidence-bundle.json; then
  echo "tampered bundle verified — this is a bug"; exit 1
fi

echo "== the embedded path must not need pg/ioredis/aws-sdk/onnxruntime"
for m in pg ioredis @aws-sdk/client-s3 @aws-sdk/client-kms onnxruntime-node; do
  if [ -e "node_modules/$m" ]; then echo "unexpected dependency installed: $m"; exit 1; fi
done

echo "PASS: @getpharos/cli tarball installs with npm and reaches a verified chain in ${ELAPSED_MS} ms"
