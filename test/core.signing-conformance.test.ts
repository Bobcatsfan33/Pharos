import { beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileKeystore, LocalKms } from "@pharos/core";
import { runSigningConformance } from "./signingConformance.js";

// The local KMS runs the full SigningProvider conformance contract hermetically (no infra).
// AwsKms runs the same contract against a KMS emulator in test/integration.aws-kms.test.ts.
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pharos-conformance-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

runSigningConformance({
  name: "LocalKms (Ed25519)",
  expectedAlgorithm: "ed25519",
  makeProvider: () => new LocalKms(new FileKeystore(dir)),
});
