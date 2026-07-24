import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { verifyChain, type ActionRecord, type PublicKeyEntry } from "@pharos/core";

/**
 * Committed offline-verification fixtures for BOTH signature algorithms. Each bundle is a
 * self-contained evidence export (records + published keyset) that a third party verifies with
 * @pharos/core alone — no Pharos infra, no KMS. The ecdsa-p256 bundle was sealed by AwsKms; the
 * baked-in public keys make its verification hermetic here (KMS is not consulted at verify
 * time). This is the proof that offline verification handles Ed25519 and ECDSA P-256.
 *
 * Regenerate after a deliberate seal/format change by re-sealing chains under LocalKms and
 * AwsKms (emulator) and re-running verifyChain — see the S3-T1 PR for the generator.
 */
type Bundle = {
  tenantId: string;
  algorithm: string;
  records: ActionRecord[];
  keyset: PublicKeyEntry[];
};

function load(name: string): Bundle {
  const path = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as Bundle;
}

describe("offline evidence-bundle fixtures (both algorithms)", () => {
  for (const { name, algorithm } of [
    { name: "bundle-ed25519.json", algorithm: "ed25519" },
    { name: "bundle-ecdsa-p256.json", algorithm: "ecdsa-p256" },
  ]) {
    it(`${algorithm}: verifies genesis-to-head from the bundle alone`, () => {
      const b = load(name);
      expect(b.algorithm).toBe(algorithm);
      expect(b.keyset.every((k) => k.algorithm === algorithm)).toBe(true);

      const report = verifyChain(b.records, b.keyset);
      expect(report.ok).toBe(true);
      expect(report.recordsChecked).toBe(b.records.length);
      expect(report.firstBrokenSequence).toBeNull();
    });

    it(`${algorithm}: tampering is detected`, () => {
      const b = load(name);
      (b.records[1]!.content.action.payload as Record<string, unknown>).n = 999;
      const report = verifyChain(b.records, b.keyset);
      expect(report.ok).toBe(false);
      expect(report.firstBrokenSequence).toBe(1);
    });
  }
});
