import base from "./vitest.config.js";

/**
 * The zero-Docker suite: everything that runs with nothing but Node installed. Used by
 * `pnpm test:embedded` (the ten-minute contributor path). Spread, not mergeConfig — merging
 * would APPEND to the base include and run the Postgres suites too. The full `pnpm test`
 * still includes these files, so CI's zero-skip gate covers them.
 */
export default {
  ...base,
  test: {
    ...base.test,
    include: ["test/**/*.embedded.test.ts"],
  },
};
