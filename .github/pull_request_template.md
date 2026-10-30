<!--
Thanks for contributing to Pharos. One concern per PR. See CONTRIBUTING.md for where a
change goes and the ground rules.
-->

## Summary

<!-- What changed and why. Link the issue it closes, if any. -->

## How it was verified

<!-- The commands you ran and what they showed. A claim that something works is a claim
     that it was run. -->
- [ ] `pnpm -r typecheck && pnpm lint && pnpm test` green (integration tests ran, **0 skips**)
- [ ] `pnpm runtime:check` green, if `runtime/python` or `sdks/python` changed

## Checklist

- [ ] Docs updated for anything this change makes false; `docs/LIMITATIONS.md` adjusted if a limitation was resolved or introduced
- [ ] A changeset is included if a publishable npm package changed (or the `no-changeset` label applies); Python package versions bumped in `pyproject.toml` if they changed
- [ ] All commits are `Signed-off-by` (DCO) and use Conventional Commits
- [ ] No secrets added to the repo
