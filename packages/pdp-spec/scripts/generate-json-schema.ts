import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import prettier from "prettier";
import { toJsonSchemaDocument, PDP_SPEC_VERSION } from "../src/schema.js";

// Renders packages/pdp-spec/schema/pdp-v1.schema.json from src/schema.ts.
// test/pdp-spec.schema-drift.test.ts fails if the committed file differs.
const out = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "schema",
  `pdp-v${PDP_SPEC_VERSION.split(".")[0]}.schema.json`,
);
mkdirSync(dirname(out), { recursive: true });
// Formatted the way the repo's prettier gate expects, so generate and format:check agree and
// the digest the Python generator records is the digest of the committed bytes.
const formatted = await prettier.format(JSON.stringify(toJsonSchemaDocument()), {
  parser: "json",
  ...(await prettier.resolveConfig(out)),
});
writeFileSync(out, formatted);
console.log(`wrote ${out}`);
