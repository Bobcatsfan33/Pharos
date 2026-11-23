#!/usr/bin/env bash
# One command to rehearse a release from a clean tree, before any tag or publish.
#
#   pnpm release:dry-run
#
# For every publishable npm package: build it, `npm pack` it, install the TARBALL into a throwaway
# project, and import it. For the Python distributions: build sdist + wheel, `twine check` them,
# install each wheel into a throwaway venv, and import it. Packing and installing is the point —
# a build that succeeds can still ship a package whose `files`/`exports` omit something, and only
# installing the artifact finds that.
#
# Each npm package is checked TWICE, and the two must never be conflated:
#   registry  — does the version already on npm still install? A failure here means users are
#               affected right now (reported as REGRESSION).
#   local     — does the artifact built from this tree pack, install and import? A failure here
#               is FAILED if the artifact is wrong, or BLOCKED if it merely needs a dependency
#               that has not been published yet. The repository is routinely ahead of the
#               registry, so BLOCKED is normal before a first publish and says nothing about
#               the published version.
#
# Nothing here publishes, tags, or touches the network except to resolve dependencies.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/pharos-release-dryrun.XXXXXX")"
cd "$ROOT"

# --local-registry rehearses the WHOLE set against a throwaway registry (verdaccio on a free
# port, storage under $WORK): each package is published to it in dependency order, so the
# packages that are BLOCKED against the public registry resolve their siblings and the run can
# reach green. That proves the ORDER in docs/PUBLISHING.md actually works before anything real
# is uploaded. Nothing touches npmjs.org: the registry URL is per-command, never written to a
# user .npmrc, and the whole thing is deleted on exit.
LOCAL_REGISTRY=""
# The Python counterpart of the throwaway registry: a directory of the wheels already proven in
# this run. Passed to pip as --find-links so the runtime can resolve the SDK it depends on
# without that SDK being on PyPI yet. Empty outside --local-registry mode.
# The venv interpreter is chosen per distribution, not fixed. Building runs under `python3`
# (the interpreter that has `build` and `twine`), but a distribution declaring
# requires-python >= 3.11 cannot be installed by a 3.9 interpreter, and that is a fact about
# this host, not about the artifact. Candidates are tried oldest-first so the install is
# exercised near the floor the project claims to support.
venv_python() {
  local proj="$1" req min cand
  req="$(sed -n 's/^requires-python *= *"\([^"]*\)".*/\1/p' "$proj/pyproject.toml" | head -1)"
  min="$(printf '%s' "$req" | sed -n 's/.*>=[[:space:]]*\([0-9][0-9.]*\).*/\1/p')"
  for cand in python3 python3.11 python3.12 python3.13 python3.14; do
    command -v "$cand" >/dev/null 2>&1 || continue
    if [ -z "$min" ] || "$cand" -c "import sys
want = tuple(int(x) for x in '$min'.split('.')[:2])
sys.exit(0 if sys.version_info[:2] >= want else 1)" 2>/dev/null; then
      printf '%s' "$cand"; return 0
    fi
  done
  return 1
}

WHEELHOUSE=""
find_links_args() { [ -n "$WHEELHOUSE" ] && printf -- "--find-links %s" "$WHEELHOUSE"; }

REGISTRY_PID=""
if [ "${1:-}" = "--local-registry" ]; then
  LOCAL_REGISTRY="http://localhost:4873"
fi
cleanup() {
  [ -n "$REGISTRY_PID" ] && kill "$REGISTRY_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

if [ -n "$LOCAL_REGISTRY" ]; then
  printf '\n== start a throwaway registry (%s)\n' "$LOCAL_REGISTRY"
  # htpasswd must exist before verdaccio will create accounts, and publish is $authenticated
  # because npm sends a token for a publish regardless and verdaccio rejects an unknown one.
  touch "$WORK/htpasswd"
  cat > "$WORK/verdaccio.yaml" <<YAML
storage: $WORK/registry-storage
auth:
  htpasswd:
    file: $WORK/htpasswd
    max_users: 1000
uplinks:
  npmjs:
    url: https://registry.npmjs.org/
packages:
  '@getpharos/*':
    access: \$all
    publish: \$authenticated
  '**':
    access: \$all
    proxy: npmjs
log: { type: stdout, format: pretty, level: error }
YAML
  npx --yes verdaccio@7 --config "$WORK/verdaccio.yaml" >"$WORK/registry.log" 2>&1 &
  REGISTRY_PID=$!
  for _ in $(seq 1 60); do
    curl -fsS "$LOCAL_REGISTRY/-/ping" >/dev/null 2>&1 && break
    sleep 1
  done
  if ! curl -fsS "$LOCAL_REGISTRY/-/ping" >/dev/null 2>&1; then
    echo "   could not start the local registry — see $WORK/registry.log"
    exit 1
  fi
  curl -fsS -XPUT "$LOCAL_REGISTRY/-/user/org.couchdb.user:dryrun" \
    -H 'content-type: application/json' \
    -d '{"name":"dryrun","password":"dry-run-local-only-password"}' >"$WORK/token.json" 2>&1 || true
  NPM_TOKEN="$(python3 -c "
import json
print(json.load(open('$WORK/token.json')).get('token',''))" 2>/dev/null || true)"
  if [ -z "$NPM_TOKEN" ]; then
    echo "   could not create a registry account — see $WORK/token.json and $WORK/registry.log"
    exit 1
  fi
  WHEELHOUSE="$WORK/wheelhouse"
  mkdir -p "$WHEELHOUSE"
  echo "   up, with a throwaway publishing account (wheelhouse at $WHEELHOUSE)"
fi

# Resolve a package name against whichever registry this run is rehearsing.
registry_args() {
  [ -n "$LOCAL_REGISTRY" ] && printf -- "--registry=%s" "$LOCAL_REGISTRY"
}

# The artifacts and their order. --local-registry publishes each package after it proves
# itself, so a wrong order here shows up as the next package failing to install.
# shellcheck source=scripts/release-order.sh
. "$(dirname "$0")/release-order.sh"

fail=0
note() { printf '\n== %s\n' "$1"; }

# In --local-registry mode, publish a package that just proved itself so the NEXT package in
# dependency order can resolve it. This is what makes the documented order testable.
# Publishes the PACKED TARBALL, never the source directory. `npm publish` from a workspace
# directory uploads package.json verbatim, `workspace:^` and all, and the next package in the
# order then fails to install it. The tarball is the artifact that was just proven to install,
# so it is the only thing worth putting in the registry.
publish_to_local() {
  [ -n "$LOCAL_REGISTRY" ] || return 0
  local tgz="$1" name="$2"
  if (npm publish "$tgz" --registry="$LOCAL_REGISTRY" \
        --//localhost:4873/:_authToken="$NPM_TOKEN" >>"$WORK/publish.log" 2>&1); then
    echo "   published to the throwaway registry (so the next package can resolve it)"
  else
    echo "   FAILED to publish to the throwaway registry — see $WORK/publish.log"
    fail=1
  fi
}

note "build the publishable packages"
pnpm build:publishable >/dev/null
pnpm --filter @getpharos/cli build >/dev/null
echo "   built"

for entry in "${NPM_PACKAGES[@]}"; do
  IFS='|' read -r dir name symbol <<< "$entry"
  note "npm: $name"
  version="$(node -p "require('$ROOT/$dir/package.json').version")"
  # pnpm pack, not npm pack: pnpm rewrites the `workspace:` protocol to the real version
  # range, which is what `pnpm publish` uploads. An `npm pack` tarball keeps `workspace:^`
  # literally and fails to install with EUNSUPPORTEDPROTOCOL — so packing with npm here would
  # report a defect that a real release does not have.
  (cd "$dir" && pnpm pack --pack-destination "$WORK" >/dev/null 2>&1)
  tarball="$(ls "$WORK"/*"${name#@getpharos/}"-"$version".tgz 2>/dev/null | head -1 || true)"
  if [ -z "$tarball" ]; then
    tarball="$(ls -t "$WORK"/*.tgz | head -1)"
  fi
  echo "   packed $(basename "$tarball") ($(du -h "$tarball" | cut -f1))"

  # The REGISTRY check, kept strictly separate from the local tarball. These answer two
  # different questions and conflating them produced a wrong bug report (#344): a local
  # tarball can need a dependency that does not exist yet while the published version is
  # perfectly installable, because the repository is ahead of the registry.
  published="$(npm view $(registry_args) "$name" version 2>/dev/null || true)"
  if [ -z "$published" ]; then
    echo "   registry: NOT PUBLISHED — nothing to regress; this will be a first publish"
  else
    reg="$WORK/reg-${name//[^a-zA-Z0-9]/-}"
    mkdir -p "$reg"
    rlog="$WORK/registry-${name//[^a-zA-Z0-9]/-}.log"
    if (cd "$reg" && npm init -y >/dev/null 2>&1 && npm install $(registry_args) "$name" >"$rlog" 2>&1); then
      echo "   registry: $published installs clean from npm (local tree is at $version)"
    else
      echo "   REGRESSION: the PUBLISHED $name@$published does not install — users are affected now"
      sed -n "s/^npm error //p" "$rlog" | grep -v "^code " | head -3 | sed "s/^/               /"
      fail=1
    fi
  fi

  app="$WORK/app-${name//[^a-zA-Z0-9]/-}"
  # Install with npm, from the tarball: that is what a consumer does, and it is the step that
  # catches a `files`/`exports` mistake or an unresolvable dependency range.
  mkdir -p "$app"
  log="$WORK/install-${name//[^a-zA-Z0-9]/-}.log"
  if ! (cd "$app" && npm init -y >/dev/null 2>&1 && npm install $(registry_args) "$tarball" >"$log" 2>&1); then
    # Distinguish a malformed artifact from a sequencing problem: a sibling @getpharos
    # package that is simply not on the registry yet is a publish-ORDER fact, not a defect
    # in this tarball, and the operator needs to know which it is.
    missing="$(grep -oE "@getpharos/[a-z-]+" "$log" | sort -u | tr '\n' ' ' || true)"
    if grep -q "E404" "$log" && [ -n "$missing" ]; then
      echo "   BLOCKED (local tarball, unpublished dependency):$missing"
      echo "            This says nothing about the published version above — it means THIS"
      echo "            build cannot be released until that dependency is published first."
      echo "            Order: docs/PUBLISHING.md"
    else
      echo "   FAILED: npm could not install the packed tarball"
      sed -n "s/^npm error //p" "$log" | grep -v "^code " | head -3 | sed "s/^/            /"
    fi
    fail=1; continue
  fi
  if [ -n "$symbol" ]; then
    if (cd "$app" && node --input-type=module -e "
      import * as m from '$name';
      if (typeof m.$symbol === 'undefined') { console.error('missing export: $symbol'); process.exit(1); }
    " 2>/dev/null); then
      echo "   installed from the tarball and imported ($symbol present)"
      publish_to_local "$tarball" "$name"
    else
      echo "   FAILED: installed but could not import $symbol from $name"; fail=1
    fi
  else
    # The CLI exposes a bin rather than an importable entry.
    if (cd "$app" && ./node_modules/.bin/pharos --version >/dev/null 2>&1); then
      echo "   installed from the tarball; bin runs ($(cd "$app" && ./node_modules/.bin/pharos --version))"
      publish_to_local "$tarball" "$name"
    else
      echo "   FAILED: installed but the pharos bin did not run"; fail=1
    fi
  fi
done

for entry in "${PY_DISTS[@]}"; do
  IFS='|' read -r dir module <<< "$entry"
  note "python: $dir ($module)"
  out="$WORK/dist-${module}"
  if ! python3 -m build --outdir "$out" "$dir" >"$WORK/build-$module.log" 2>&1; then
    echo "   FAILED to build — $(tail -3 "$WORK/build-$module.log" | tr '\n' ' ')"
    echo "   (needs: python3 -m pip install build twine)"; fail=1; continue
  fi
  echo "   built $(ls "$out" | tr '\n' ' ')"
  if python3 -m twine check "$out"/* >"$WORK/twine-$module.log" 2>&1; then
    echo "   twine check passed"
  else
    echo "   FAILED twine check — $(tail -3 "$WORK/twine-$module.log" | tr '\n' ' ')"; fail=1; continue
  fi
  venv="$WORK/venv-$module"
  if ! vpy="$(venv_python "$dir")"; then
    echo "   FAILED: no interpreter on this host satisfies the declared requires-python"
    echo "            (install a newer python3 — the artifact itself passed twine check)"
    fail=1; continue
  fi
  "$vpy" -m venv "$venv" >/dev/null
  echo "   venv on $("$vpy" -V 2>&1) (declared requires-python floor)"
  wheel="$(ls "$out"/*.whl | head -1)"
  plog="$WORK/pip-$module.log"
  if "$venv/bin/pip" install $(find_links_args) "$wheel" >"$plog" 2>&1 && \
     "$venv/bin/python" -c "import $module" 2>/dev/null; then
    echo "   installed the wheel into a clean venv and imported $module"
    if [ -n "$WHEELHOUSE" ]; then
      cp "$out"/*.whl "$WHEELHOUSE"/
      echo "   added to the wheelhouse (so the next distribution can resolve it)"
    fi
  else
    unpub="$(grep -oE "No matching distribution found for [a-zA-Z0-9_.>=<-]+" "$plog" | head -1 || true)"
    if [ -n "$unpub" ]; then
      echo "   BLOCKED (local wheel, unpublished dependency): $unpub"
      echo "            The wheel itself is well-formed; the dependency must be published first."
      echo "            Order: docs/PUBLISHING.md"
    else
      echo "   FAILED: wheel installed or imported badly"
      tail -3 "$plog" | sed "s/^/            /"
    fi
    fail=1
  fi
done

note "result"
if [ "$fail" -ne 0 ]; then
  echo "release dry-run did NOT pass — see above. Nothing was published."
  echo "Read the lines above by kind — they are NOT interchangeable:"
  echo "  REGRESSION  a version already on the registry does not install. Users are affected now."
  echo "  FAILED      the artifact built from this tree is itself wrong."
  echo "  BLOCKED     the artifact is fine; a dependency is not published yet. Publish in order."
  exit 1
fi
echo "release dry-run PASSED: every publishable artifact packs, installs from its artifact, and imports."
echo "Nothing was published. Next: docs/PUBLISHING.md."
