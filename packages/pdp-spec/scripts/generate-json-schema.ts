import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
writeFileSync(out, JSON.stringify(toJsonSchemaDocument(), null, 2) + "\n");
console.log(`wrote ${out}`);
