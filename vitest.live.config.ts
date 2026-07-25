import base from "./vitest.config.js";

// Config for LIVE (network) tests only — `pnpm test:live`. Reuses the base resolve/aliases but
// REPLACES the include so it collects `*.spec.ts` (live/network) instead of the hermetic
// `*.test.ts` suite. Live tests therefore never run in the default `pnpm test` and can't trip
// the CI skip-gate on a TSA/network outage.
export default {
  ...base,
  test: {
    ...base.test,
    include: ["test/**/*.spec.ts"],
  },
};
