export type ComplianceFramework =
  "NIST-AI-RMF" | "ISO-42001" | "EU-AI-ACT" | "SOC-2" | "HIPAA" | "PCI-DSS" | "FINRA";

export type EvidencePosture = "enforced" | "evidenced" | "human" | "external" | "unsupported";

export interface ControlMapping {
  id: string;
  framework: ComplianceFramework;
  reference: string;
  title: string;
  requiredFacts: string[];
  posture: EvidencePosture;
  guidance?: string;
}

export interface ControlPack {
  id: string;
  version: string;
  controls: ControlMapping[];
  disclaimer: string;
}

export interface ControlResult extends ControlMapping {
  status: "satisfied" | "partial" | "not_satisfied" | "external_validation_required";
  observedFacts: string[];
  missingFacts: string[];
}

export interface ComplianceEvaluation {
  packId: string;
  packVersion: string;
  coverage: number;
  controls: ControlResult[];
  certificationClaimed: false;
}

export const PHAROS_CONTROL_PACK: ControlPack = {
  id: "pharos-core-controls",
  version: "1.0.0",
  disclaimer:
    "Control mappings describe technical evidence and enforcement only; they do not constitute certification or legal advice.",
  controls: [
    {
      id: "nist-govern-1",
      framework: "NIST-AI-RMF",
      reference: "GOVERN 1",
      title: "AI risk policies and accountability",
      requiredFacts: ["policy.versioned", "approval.separation_of_duties"],
      posture: "evidenced",
    },
    {
      id: "nist-measure-2",
      framework: "NIST-AI-RMF",
      reference: "MEASURE 2",
      title: "Measured and monitored AI risk",
      requiredFacts: ["eval.sliced_metrics", "drift.monitored"],
      posture: "enforced",
    },
    {
      id: "iso-a8-4",
      framework: "ISO-42001",
      reference: "A.8.4",
      title: "AI system impact assessment",
      requiredFacts: ["risk.assessment", "evidence.chain_verified"],
      posture: "evidenced",
    },
    {
      id: "eu-12",
      framework: "EU-AI-ACT",
      reference: "Article 12",
      title: "Record keeping",
      requiredFacts: ["evidence.chain_verified", "records.retained"],
      posture: "enforced",
    },
    {
      id: "soc2-cc6",
      framework: "SOC-2",
      reference: "CC6",
      title: "Logical access controls",
      requiredFacts: ["identity.sso", "authorization.rbac", "audit.admin_events"],
      posture: "external",
    },
    {
      id: "hipaa-164-312",
      framework: "HIPAA",
      reference: "164.312(b)",
      title: "Audit controls",
      requiredFacts: ["audit.immutable", "data.phi_redacted"],
      posture: "external",
    },
    {
      id: "pci-10",
      framework: "PCI-DSS",
      reference: "10",
      title: "Log and monitor access",
      requiredFacts: ["audit.immutable", "records.retained"],
      posture: "external",
    },
    {
      id: "finra-4511",
      framework: "FINRA",
      reference: "4511",
      title: "Books and records",
      requiredFacts: ["records.retained", "evidence.exportable"],
      posture: "external",
      guidance:
        "Retention configuration must be reviewed against the firm's applicable record class.",
    },
  ],
};

export function evaluateControlPack(
  pack: ControlPack,
  facts: Record<string, boolean>,
  frameworks?: ComplianceFramework[],
): ComplianceEvaluation {
  const selected = frameworks?.length
    ? pack.controls.filter((control) => frameworks.includes(control.framework))
    : pack.controls;
  const controls = selected.map<ControlResult>((control) => {
    const observedFacts = control.requiredFacts.filter((fact) => facts[fact] === true);
    const missingFacts = control.requiredFacts.filter((fact) => facts[fact] !== true);
    const status =
      control.posture === "external"
        ? "external_validation_required"
        : missingFacts.length === 0
          ? "satisfied"
          : observedFacts.length > 0
            ? "partial"
            : "not_satisfied";
    return { ...control, observedFacts, missingFacts, status };
  });
  const satisfied = controls.filter((control) => control.status === "satisfied").length;
  return {
    packId: pack.id,
    packVersion: pack.version,
    coverage: controls.length === 0 ? 0 : satisfied / controls.length,
    controls,
    certificationClaimed: false,
  };
}

export function complianceRegressions(
  previous: ComplianceEvaluation,
  current: ComplianceEvaluation,
): ControlResult[] {
  const prior = new Map(previous.controls.map((control) => [control.id, control.status]));
  return current.controls.filter(
    (control) => prior.get(control.id) === "satisfied" && control.status !== "satisfied",
  );
}
