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
# Nothing here publishes, tags, or touches the network except to resolve dependencies.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/pharos-release-dryrun.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
cd "$ROOT"

# Publishable npm packages and the entry each one must expose once installed.
NPM_PACKAGES=(
  "packages/sdk-ts|@getpharos/sdk|PharosClient"
  "packages/middleware|@getpharos/middleware|governTool"
  "packages/pdp-spec|@getpharos/pdp-spec|PDP_SPEC_VERSION"
  "packages/cli|@getpharos/cli|"
)
PY_DISTS=("sdks/python|pharos_sdk" "runtime/python|pharos_runtime")

fail=0
note() { printf '\n== %s\n' "$1"; }

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

  app="$WORK/app-${name//[^a-zA-Z0-9]/-}"
  # Install with npm, from the tarball: that is what a consumer does, and it is the step that
  # catches a `files`/`exports` mistake or an unresolvable dependency range.
  mkdir -p "$app"
  log="$WORK/install-${name//[^a-zA-Z0-9]/-}.log"
  if ! (cd "$app" && npm init -y >/dev/null 2>&1 && npm install "$tarball" >"$log" 2>&1); then
    # Distinguish a malformed artifact from a sequencing problem: a sibling @getpharos
    # package that is simply not on the registry yet is a publish-ORDER fact, not a defect
    # in this tarball, and the operator needs to know which it is.
    missing="$(grep -oE "@getpharos/[a-z-]+" "$log" | sort -u | tr '\n' ' ' || true)"
    if grep -q "E404" "$log" && [ -n "$missing" ]; then
      echo "   BLOCKED: the tarball is well-formed, but its dependency is not published:$missing"
      echo "            publish that first — see docs/PUBLISHING.md for the order"
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
    else
      echo "   FAILED: installed but could not import $symbol from $name"; fail=1
    fi
  else
    # The CLI exposes a bin rather than an importable entry.
    if (cd "$app" && ./node_modules/.bin/pharos --version >/dev/null 2>&1); then
      echo "   installed from the tarball; bin runs ($(cd "$app" && ./node_modules/.bin/pharos --version))"
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
  python3 -m venv "$venv" >/dev/null
  wheel="$(ls "$out"/*.whl | head -1)"
  plog="$WORK/pip-$module.log"
  if "$venv/bin/pip" install "$wheel" >"$plog" 2>&1 && \
     "$venv/bin/python" -c "import $module" 2>/dev/null; then
    echo "   installed the wheel into a clean venv and imported $module"
  else
    unpub="$(grep -oE "No matching distribution found for [a-zA-Z0-9_.>=<-]+" "$plog" | head -1 || true)"
    if [ -n "$unpub" ]; then
      echo "   BLOCKED: the wheel is well-formed, but a dependency is not published — $unpub"
      echo "            publish that first — see docs/PUBLISHING.md for the order"
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
  echo "A BLOCKED line means the artifact is fine and a dependency needs publishing first;"
  echo "a FAILED line means the artifact itself is wrong."
  exit 1
fi
echo "release dry-run PASSED: every publishable artifact packs, installs from its artifact, and imports."
echo "Nothing was published. Next: docs/PUBLISHING.md."
