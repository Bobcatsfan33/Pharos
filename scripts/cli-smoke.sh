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

echo "== pharos run: block / escalate / allow, each sealed before anything executes"
set +e
npx --no-install pharos run -- git push --force origin main; code=$?
set -e
test "$code" -eq 2 || { echo "expected exit 2 (blocked), got $code"; exit 1; }
set +e
npx --no-install pharos run -- rm -rf build; code=$?
set -e
test "$code" -eq 3 || { echo "expected exit 3 (escalated), got $code"; exit 1; }
npx --no-install pharos run -- echo "governed hello" | tee run.out
grep -q "governed hello" run.out
npx --no-install pharos log | grep -q "cas-git-force-push-protected"

echo "== pharos serve: boots the API over embedded storage"
npx --no-install pharos serve --port 4321 > serve.out 2>&1 &
SERVE_PID=$!
for i in $(seq 1 50); do curl -sf http://127.0.0.1:4321/healthz >/dev/null 2>&1 && break; sleep 0.2; done
curl -sf http://127.0.0.1:4321/healthz | tee healthz.json
grep -q '"backend":"embedded"' healthz.json
grep -q '"worm":false' healthz.json
KEY=$(cat .pharos/api-key)
curl -sf -X POST http://127.0.0.1:4321/v1/actions -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"tenantId":"local","action":{"type":"shell.exec","agentId":"smoke","payload":{"command":"cat ~/.ssh/id_rsa"}},"liability":{"mandate":null,"oversightMode":"human_in_loop","blastRadius":{"financialAmount":0,"currency":"USD","reversibility":"irreversible"},"modelMetadata":null}}' \
  | tee submit.json
grep -q '"decision":"block"' submit.json
grep -q 'cas-secret-read' submit.json
kill "$SERVE_PID"; wait "$SERVE_PID" 2>/dev/null || true

echo "== pharos hook claude-code: the PreToolUse protocol over stdin"
npx --no-install pharos init --claude-code | grep -q "Claude Code hook"
grep -q '"PreToolUse"' .claude/settings.json
echo '{"session_id":"s","cwd":"'"$PWD"'","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git push --force origin main"}}' \
  | npx --no-install pharos hook claude-code | tee hook.out
grep -q '"permissionDecision":"deny"' hook.out
grep -q 'cas-git-force-push-protected' hook.out
echo '{"cwd":"'"$PWD"'","tool_name":"Read","tool_input":{"file_path":"'"$PWD"'/.env"}}' | npx --no-install pharos hook claude-code | grep -q '"deny"'
echo '{"cwd":"'"$PWD"'","tool_name":"Bash","tool_input":{"command":"rm -rf build"}}' | npx --no-install pharos hook claude-code | grep -q '"ask"'
set +e
echo 'not json' | npx --no-install pharos hook claude-code; code=$?
set -e
test "$code" -eq 2 || { echo "expected exit 2 for malformed hook input, got $code"; exit 1; }

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
