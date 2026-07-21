// ESLint 9 flat config for the Pharos monorepo.
//
// Scope (roadmap S1-T4): @eslint/js recommended + typescript-eslint *recommended*
// (NOT strict/stylistic — we do not want a mechanical reformatting diff), with
// eslint-config-prettier last so formatting is owned by Prettier, not ESLint.
//
// Any rule turned off below is a deliberate, scoped decision with a rationale, not a
// blanket silencing. Tightening these is tracked as a follow-up (see the notes inline).
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  {
    // Not source we lint: build output, deps, lockfiles, generated bundles.
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.next/**",
      "**/coverage/**",
      "**/*.d.ts",
      "pnpm-lock.yaml",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      // Allow intentionally-unused args/vars when prefixed with `_` (common in
      // interface implementations and provider seams throughout the codebase).
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  // Plain JS/MJS/CJS config files (next.config.mjs, this file, postcss, etc.) run in Node.
  {
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  // Tests and scripts: allow `any` and non-null assertions where fixture-building and
  // narrow-cast test scaffolding make strict typing pure noise. Follow-up: revisit if a
  // test-specific type-checked config is ever added (tracked in CONTRIBUTING backlog).
  {
    files: ["test/**/*.{ts,tsx}", "scripts/**/*.ts", "**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
  // Prettier config last: disables all ESLint rules that would conflict with Prettier
  // formatting. Formatting is checked separately via `pnpm format:check`.
  prettier,
);
