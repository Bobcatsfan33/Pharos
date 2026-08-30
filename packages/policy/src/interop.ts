import {
  canonicalize,
  sha256Hex,
  type SignatureAlgorithm,
  type SigningProvider,
} from "@pharos/core";
import type { Comparator, Condition, PolicyArtifact, PolicyRule } from "./rules.js";

/** Portable JSON profile accepted from an OPA control plane. Rego authors can emit this
 * document with `opa eval --format=json`; Pharos never pretends to parse arbitrary Rego. */
export interface OpaPolicyDocument {
  package: string;
  revision: string;
  title?: string;
  rules: Array<{
    name: string;
    effect: "block" | "escalate" | "modify";
    description: string;
    clause?: string;
    when: PortableCondition;
  }>;
}

/** Cedar JSON interchange profile. Permit is the default and therefore has no rule; explicit
 * forbid/escalate/modify policies become Pharos rules with their source identity preserved. */
export interface CedarPolicyDocument {
  namespace: string;
  revision: string;
  title?: string;
  policies: Array<{
    id: string;
    effect: "permit" | "forbid" | "escalate" | "modify";
    actions?: string[];
    conditions?: PortableCondition[];
    description?: string;
    clause?: string;
  }>;
}

export type PortableCondition =
  | { path: string; operator: Comparator; value: unknown }
  | { all: PortableCondition[] }
  | { any: PortableCondition[] }
  | { not: PortableCondition };

export interface PolicyImportResult {
  source: "opa" | "cedar" | "pharos";
  artifact: PolicyArtifact;
  sourceDigest: string;
  warnings: string[];
}

function condition(input: PortableCondition): Condition {
  if ("all" in input) return { all: input.all.map(condition) };
  if ("any" in input) return { any: input.any.map(condition) };
  if ("not" in input) return { not: condition(input.not) };
  if (!input.path.startsWith("action.") && !input.path.startsWith("liability.")) {
    throw new Error(`policy condition path must start with action. or liability.: ${input.path}`);
  }
  return { field: input.path, op: input.operator, value: input.value };
}

function artifactRule(
  source: "opa" | "cedar",
  pack: string,
  input: {
    id: string;
    effect: "block" | "escalate" | "modify";
    description: string;
    clause?: string;
    when: Condition;
  },
): PolicyRule {
  return {
    ruleId: `${source}:${input.id}`,
    pack,
    clause: input.clause,
    description: input.description,
    when: input.when,
    decision: input.effect,
    confidence: 1,
  };
}

export function importOpaPolicy(document: OpaPolicyDocument): PolicyImportResult {
  if (!document.package || !document.revision || document.rules.length === 0) {
    throw new Error("OPA policy document requires package, revision, and at least one rule");
  }
  const artifact: PolicyArtifact = {
    packId: `opa:${document.package}`,
    version: document.revision,
    title: document.title ?? document.package,
    rules: document.rules.map((rule) =>
      artifactRule("opa", `opa:${document.package}`, {
        id: rule.name,
        effect: rule.effect,
        description: rule.description,
        clause: rule.clause,
        when: condition(rule.when),
      }),
    ),
    changelog: `Imported from OPA package ${document.package} revision ${document.revision}`,
  };
  return { source: "opa", artifact, sourceDigest: sha256Hex(document), warnings: [] };
}

export function importCedarPolicy(document: CedarPolicyDocument): PolicyImportResult {
  if (!document.namespace || !document.revision || document.policies.length === 0) {
    throw new Error("Cedar policy document requires namespace, revision, and policies");
  }
  const warnings: string[] = [];
  const rules: PolicyRule[] = [];
  for (const policy of document.policies) {
    if (policy.effect === "permit") {
      warnings.push(`Cedar permit ${policy.id} is represented by Pharos default allow`);
      continue;
    }
    const parts: Condition[] = [];
    if (policy.actions?.length) {
      parts.push({ field: "action.type", op: "in", value: [...policy.actions].sort() });
    }
    parts.push(...(policy.conditions ?? []).map(condition));
    rules.push(
      artifactRule("cedar", `cedar:${document.namespace}`, {
        id: policy.id,
        effect: policy.effect === "forbid" ? "block" : policy.effect,
        description: policy.description ?? `Imported Cedar ${policy.effect} policy ${policy.id}`,
        clause: policy.clause,
        when: parts.length === 0 ? { all: [] } : parts.length === 1 ? parts[0]! : { all: parts },
      }),
    );
  }
  const artifact: PolicyArtifact = {
    packId: `cedar:${document.namespace}`,
    version: document.revision,
    title: document.title ?? document.namespace,
    rules,
    changelog: `Imported from Cedar namespace ${document.namespace} revision ${document.revision}`,
  };
  return { source: "cedar", artifact, sourceDigest: sha256Hex(document), warnings };
}

export function importPharosPolicy(artifact: PolicyArtifact): PolicyImportResult {
  if (!artifact.packId || !artifact.version || !artifact.title || !Array.isArray(artifact.rules)) {
    throw new Error("invalid Pharos policy artifact");
  }
  return { source: "pharos", artifact, sourceDigest: sha256Hex(artifact), warnings: [] };
}

export type PolicySourceDocument =
  | { source: "opa"; document: OpaPolicyDocument }
  | { source: "cedar"; document: CedarPolicyDocument }
  | { source: "pharos"; document: PolicyArtifact };

export function importPolicy(document: PolicySourceDocument): PolicyImportResult {
  if (document.source === "opa") return importOpaPolicy(document.document);
  if (document.source === "cedar") return importCedarPolicy(document.document);
  return importPharosPolicy(document.document);
}

/** Canonical policy IR used for bundle identity and semantic comparisons. */
export function canonicalPolicyIr(artifact: PolicyArtifact): string {
  const rules = [...artifact.rules].sort((a, b) => a.ruleId.localeCompare(b.ruleId));
  return canonicalize({
    packId: artifact.packId,
    version: artifact.version,
    title: artifact.title,
    rules,
  });
}

export interface SignedPolicyBundle {
  schemaVersion: "pharos.policy-bundle.v1";
  revision: string;
  artifact: PolicyArtifact;
  source: PolicyImportResult["source"];
  sourceDigest: string;
  artifactDigest: string;
  createdAt: string;
  keyId: string;
  algorithm: SignatureAlgorithm;
  signature: string;
}

function bundleMessage(bundle: Omit<SignedPolicyBundle, "keyId" | "algorithm" | "signature">) {
  return Buffer.from(`pharos:policy-bundle:v1\n${sha256Hex(bundle)}`, "utf8");
}

export async function signPolicyBundle(
  imported: PolicyImportResult,
  signer: SigningProvider,
  keyName: string,
  createdAt = new Date().toISOString(),
): Promise<SignedPolicyBundle> {
  const unsigned = {
    schemaVersion: "pharos.policy-bundle.v1" as const,
    revision: imported.artifact.version,
    artifact: imported.artifact,
    source: imported.source,
    sourceDigest: imported.sourceDigest,
    artifactDigest: sha256Hex(JSON.parse(canonicalPolicyIr(imported.artifact))),
    createdAt,
  };
  const keyId = await signer.ensureKey(keyName);
  const key = await signer.getPublicKey(keyId);
  if (!key) throw new Error(`signer did not publish active policy key ${keyId}`);
  const signature = await signer.sign(keyId, bundleMessage(unsigned));
  return { ...unsigned, keyId, algorithm: key.algorithm, signature };
}

export async function verifyPolicyBundle(
  bundle: SignedPolicyBundle,
  signer: SigningProvider,
): Promise<boolean> {
  if (bundle.artifactDigest !== sha256Hex(JSON.parse(canonicalPolicyIr(bundle.artifact)))) {
    return false;
  }
  const { keyId, algorithm, signature, ...unsigned } = bundle;
  const key = await signer.getPublicKey(keyId);
  if (!key || key.algorithm !== algorithm) return false;
  return signer.verify(keyId, bundleMessage(unsigned), signature);
}
