import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { awsKmsAliasName } from "@pharos/core";

// The KMS alias is the identifier an operator must pre-provision a customer-managed CMK at.
// It was previously derived in code and documented nowhere, so an operator following the install
// guide provisioned a key Pharos never read and Pharos silently minted its own under the AWS
// default key policy. That is a procurement-grade defect: the documented path and the real path
// disagreed. This suite pins the two together so they cannot drift again.

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const install = readFileSync(join(repoRoot, "deploy/INSTALL.md"), "utf8");

/** The opt-in flag name, referenced from config, the provider's refusal, and the docs. */
const CREATION_FLAG = "PHAROS_KMS_AWS_ALLOW_KEY_CREATION";

describe("KMS key identifier: docs and code agree", () => {
  it("documents the alias derivation the provider actually uses", () => {
    expect(install).toContain("alias/<aliasPrefix>/<base64url(keyName)>/v<version>");
  });

  it("the worked example resolves to the alias the code derives", () => {
    // INSTALL.md walks an operator through provisioning tenant `acme`. If the derivation
    // changes, this example silently becomes wrong instructions — fail instead.
    const derived = awsKmsAliasName("pharos", "tenant:acme", 1);
    expect(derived).toBe("alias/pharos/dGVuYW50OmFjbWU/v1");
    expect(install).toContain(derived);
    expect(install).toContain(`--alias-name ${derived}`);
  });

  it("documents both alias prefixes the platform constructs", () => {
    // platform.ts builds the signing keyset under `pharos` and the local-TSA keyset under
    // `pharos-tsa`; an operator provisioning only one would half-break a deployment.
    const platform = readFileSync(join(repoRoot, "services/api/src/platform.ts"), "utf8");
    for (const prefix of ["pharos", "pharos-tsa"]) {
      expect(platform).toContain(`aliasPrefix: "${prefix}"`);
      expect(install).toContain(prefix);
    }
  });

  it("names the opt-in flag consistently across config, provider refusal, and docs", () => {
    const config = readFileSync(join(repoRoot, "packages/config/src/index.ts"), "utf8");
    const provider = readFileSync(join(repoRoot, "packages/core/src/signing/awsKms.ts"), "utf8");
    // The env var the loader reads, the flag the refusal tells the operator to set, and the
    // flag the install guide documents must be one and the same string.
    expect(config).toContain(`env.${CREATION_FLAG}`);
    expect(provider).toContain(CREATION_FLAG);
    expect(install).toContain(CREATION_FLAG);
  });

  it("states that implicit creation uses the AWS default key policy", () => {
    // The operator harm is the key policy, not the existence of the key. If this claim is
    // dropped from the docs, the flag reads as a harmless convenience toggle.
    expect(install).toContain("AWS default key policy");
    expect(install).toMatch(/kms:Sign/);
    expect(install).toMatch(/kms:GetPublicKey/);
  });
});
