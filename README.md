# Reshape patches — delivery branch

This orphan branch carries only the seven patches of the repository reshape, re-based on
`main` at `788d12f` (the merge of #301). It exists so a session with push access can fetch
the patches from the repository itself. Apply and push from a clean clone of `main`:

```bash
git fetch origin reshape-patches
git checkout main && git pull
git show origin/reshape-patches:patches/0001-docs-move-planning-artifacts-to-docs-internal-and-re.patch > /dev/null  # sanity
mkdir -p /tmp/reshape && for f in $(git ls-tree --name-only origin/reshape-patches patches/); do git show "origin/reshape-patches:$f" > "/tmp/reshape/$(basename "$f")"; done
git am --3way /tmp/reshape/*.patch
# verify (see PHAROS_PUSH_HANDOFF.md step 3), then:
git push origin main
git push origin --delete reshape-patches repo-reshape
```

Verification before pushing, from the handoff: `pnpm install && pnpm build:publishable &&
pnpm -r typecheck && pnpm lint && pnpm format:check && pnpm test`, `pnpm runtime:install &&
pnpm runtime:check`, `python3 sdks/python/scripts/gen_types.py --check`,
`node scripts/internal/verify-enterprise-readiness.mjs`.

Known CI state on `main` before these patches (not addressed here): `pnpm audit` fails on
zod < 4.6.6 (Dependabot #279 fixes it), the training lock has filelock/setuptools advisories,
and gitleaks flags the Ed25519 **public** keys in
`packages/core/test/mandate-token/vectors.json` as secrets. The last needs a reviewed
allowlist entry for that path in `.gitleaks.toml`; it is a maintainer decision and is not in
these patches.
