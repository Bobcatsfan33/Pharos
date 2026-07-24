# @getpharos/sdk

## 0.1.1

### Patch Changes

- Fix the published `exports` map. 0.1.0 shipped `exports` pointing at raw TypeScript source
  because the `publishConfig.exports` override is a pnpm-only feature and 0.1.0 was published
  with the npm CLI (OIDC flow); `exports` now points at `dist/` directly and the pnpm-only
  override is removed. **0.1.0 is deprecated — use >= 0.1.1.** The PyPI `getpharos` 0.1.1
  release is a version-sync with no functional change.

## 0.1.0

### Patch Changes

- Initial npm release under the `@getpharos` scope (the `pharos` npm scope and PyPI name were
  taken; the Python module name `pharos_sdk` is unchanged). Superseded by 0.1.1 — its
  `exports` map was broken (see above).
