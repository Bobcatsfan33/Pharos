#!/usr/bin/env bash
# Publish the npm artifacts to npmjs.org in dependency order. IRREVERSIBLE: a name and version
# on npm can be deprecated but never reused. Run scripts/release-dryrun.sh first.
#
# Two rules are enforced here rather than trusted to a human:
#
#  1. The TARBALL is published, never the workspace directory. `npm publish` from a pnpm
#     workspace uploads package.json verbatim, `workspace:^` and all, and the result installs
#     for nobody. `pnpm pack` rewrites those ranges to real semver; that tarball is what goes
#     up. OIDC trusted publishing and provenance are unaffected -- npm builds provenance from
#     the CI environment and the tarball digest, not from the working directory.
#
#  2. Every @getpharos/* dependency of a package must already resolve on the registry before
#     that package is published. This is what makes the order load-bearing instead of
#     advisory: publishing @getpharos/sdk before @getpharos/pdp-spec would succeed at the
#     registry and still leave every consumer with an uninstallable package.
#
# A package whose first publish has not happened yet cannot be published by CI at all: npm
# attaches a trusted publisher to an existing package, so there is nowhere to configure one
# for a name that does not exist (npm/cli#8544). Those first publishes are maintainer actions
# from a 2FA-authenticated machine; see docs/PUBLISHING.md. Each package is therefore gated on
# its own repository variable, and a gated package is skipped loudly, not silently.
set -euo pipefail

cd "$(dirname "$0")/.."
# shellcheck source=scripts/release-order.sh
. "scripts/release-order.sh"

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

WORK="$(mktemp -d -t pharos-release)"
trap 'rm -rf "$WORK"' EXIT

# Repository variable that must be "true" before CI may publish each package. Set after the
# package's first manual publish and its trusted-publisher configuration exist.
gate_var_for() {
  case "$1" in
    "@getpharos/pdp-spec")   echo "PHAROS_NPM_PDP_SPEC_ENABLED" ;;
    "@getpharos/sdk")        echo "PHAROS_NPM_SDK_ENABLED" ;;
    "@getpharos/middleware") echo "PHAROS_NPM_MIDDLEWARE_ENABLED" ;;
    "@getpharos/cli")        echo "PHAROS_NPM_CLI_ENABLED" ;;
    *) echo "" ;;
  esac
}

# Fails if any @getpharos/* dependency of this tarball cannot be resolved on npm right now.
assert_dependencies_published() {
  local tgz="$1" name="$2" missing=""
  local deps
  deps="$(tar -xzOf "$tgz" package/package.json | node -e '
    let raw = ""
    process.stdin.on("data", (c) => (raw += c))
    process.stdin.on("end", () => {
      const pkg = JSON.parse(raw)
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.peerDependencies ?? {}) }
      for (const [dep, range] of Object.entries(deps)) {
        if (dep.startsWith("@getpharos/")) console.log(`${dep}@${range}`)
      }
    })')"
  for dep in $deps; do
    if [ -z "$(npm view "$dep" version 2>/dev/null | tail -1)" ]; then
      missing="$missing $dep"
    fi
  done
  if [ -n "$missing" ]; then
    echo "REFUSING to publish $name: unresolvable dependencies on npm:$missing" >&2
    echo "Publish them first. The order is in scripts/release-order.sh." >&2
    return 1
  fi
}

for entry in "${NPM_PACKAGES[@]}"; do
  IFS='|' read -r dir name _symbol <<< "$entry"
  version="$(node -p "require('./$dir/package.json').version")"
  printf '\n== %s@%s\n' "$name" "$version"

  gate="$(gate_var_for "$name")"
  enabled="$(eval "echo \${$gate:-}")"
  if [ "$enabled" != "true" ]; then
    echo "   SKIPPED: $gate is not \"true\" (first publish and trusted publisher not yet in place)"
    continue
  fi

  if [ -n "$(npm view "$name@$version" version 2>/dev/null | tail -1)" ]; then
    echo "   already on npm at $version — nothing to do"
    continue
  fi

  (cd "$dir" && pnpm pack --pack-destination "$WORK" >/dev/null)
  tgz="$(ls -t "$WORK"/*.tgz | head -1)"
  echo "   packed $(basename "$tgz")"
  assert_dependencies_published "$tgz" "$name"

  if [ "$DRY_RUN" -eq 1 ]; then
    echo "   --dry-run: would publish $(basename "$tgz")"
    continue
  fi
  npm publish "$tgz" --access public
  echo "   published $name@$version"
done

printf '\nnpm publication complete. Python distributions are published by release.yml.\n'
