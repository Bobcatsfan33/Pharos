import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { toJsonSchemaDocument, WIRE_SCHEMAS, PDP_SPEC_VERSION } from "@getpharos/pdp-spec";
import {
  ActionRecordSchema,
  OversightMode,
  Reversibility,
  RuleCitationSchema,
  VerdictDecision,
} from "@pharos/core";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// The wire contract has one source: packages/pdp-spec/src/schema.ts. Everything a reader can
// download or import is generated from it, and these tests fail when a generated copy drifts.

describe("pdp-spec is the single schema source", () => {
  it("the committed JSON Schema is exactly what the zod schemas render", () => {
    const committed = JSON.parse(
      readFileSync(join(repoRoot, "packages/pdp-spec/schema/pdp-v1.schema.json"), "utf8"),
    );
    expect(committed).toEqual(toJsonSchemaDocument());
    expect(committed.version).toBe(PDP_SPEC_VERSION);
    expect(Object.keys(committed.$defs)).toEqual(Object.keys(WIRE_SCHEMAS));
  });

  it("the Python SDK types are generated from that JSON Schema", () => {
    const committed = readFileSync(join(repoRoot, "sdks/python/pharos_sdk/types.py"), "utf8");
    // The generator records the digest of the schema it rendered; the Python test suite
    // regenerates and diffs the file, this side only pins the provenance line.
    expect(committed).toContain("Generated from packages/pdp-spec/schema/pdp-v1.schema.json");
    for (const name of ["Decision", "Reversibility", "OversightMode"]) {
      expect(committed).toContain(`${name} = Literal[`);
    }
    expect(committed).toContain("FailMode = Union[Literal[");
  });

  it("the sealed record composes the wire vocabulary rather than redeclaring it", () => {
    expect(VerdictDecision.options).toEqual(WIRE_SCHEMAS.Decision.options);
    expect(Reversibility.options).toEqual(WIRE_SCHEMAS.Reversibility.options);
    expect(OversightMode.options).toEqual(WIRE_SCHEMAS.OversightMode.options);
    expect(RuleCitationSchema).toBe(WIRE_SCHEMAS.RuleCitation);
    // And the frozen record shape still parses a v1 record exactly as before.
    const shape = ActionRecordSchema.shape.content.shape;
    expect(Object.keys(shape)).toEqual([
      "schemaVersion",
      "id",
      "tenantId",
      "sequence",
      "action",
      "verdict",
      "liability",
      "sealedAt",
    ]);
  });
});
