---
"@getpharos/sdk": patch
---

Fix the published `exports` map: 0.1.0 shipped `exports` pointing at raw TypeScript source because the `publishConfig.exports` override is a pnpm-only feature and the package was published with the npm CLI (OIDC flow). `exports` now points at `dist/` directly and the pnpm-only override is removed. 0.1.0 on npm is unusable and 0.1.1 replaces it; the PyPI 0.1.1 release is a version-sync with no functional change.
