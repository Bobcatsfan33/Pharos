# Publish order for the Pharos release artifacts. This file is the single source of truth:
# scripts/release-dryrun.sh rehearses it, scripts/release-publish.sh executes it, and
# test/release.publish-order.test.ts asserts docs/PUBLISHING.md still describes it.
#
# The order is a dependency order, not a preference. Each artifact depends only on artifacts
# above it, so publishing top to bottom never puts a package on a registry whose dependency
# cannot be resolved. Publishing out of order produces a package that installs for nobody and
# cannot be unpublished.
#
# npm entries:    workspace directory | package name | a named export that proves the install
#                 (empty for @getpharos/cli, whose `bin` is executed instead)
# Python entries: source directory | import name
#
# shellcheck shell=bash

NPM_PACKAGES=(
  "packages/pdp-spec|@getpharos/pdp-spec|PDP_SPEC_VERSION"
  "packages/sdk-ts|@getpharos/sdk|PharosClient"
  "packages/middleware|@getpharos/middleware|governTool"
  "packages/cli|@getpharos/cli|"
)

PY_DISTS=(
  "sdks/python|pharos_sdk"
  "runtime/python|pharos_runtime"
)
