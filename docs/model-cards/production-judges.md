# Production judge model cards

Status: **restricted pre-production**. These cards identify the served artifacts and their
intended control role. They do not promote the models: representative/adversarial ONNX efficacy,
prevalence-adjusted operating points, OOD calibration, independent validation, and sustained
customer-topology latency evidence still require approval.

## Shared system context

- Architecture: DistilBERT-family multilingual text classifier, exported to ONNX and calibrated
  with the manifest temperature. The cascade evaluates raw and normalized variants and takes the
  more severe score.
- Inputs: text extracted from a proposed agent action. The model does not receive tenant identity,
  authorization roles, or evidence-chain contents.
- Output: calibrated probability, frozen threshold, flag, concern, and content-pinned model
  version. The deterministic policy layer—not the model—selects the final action decision.
- Intended use: one signal in a tiered preventive control. A score must not be represented as
  legal advice, a diagnosis, proof of misconduct, or proof that unflagged text is compliant.
- Human oversight: irreversible actions fail closed on serving faults; policy can block or route
  flagged actions to a designated reviewer.
- Monitoring: score distributions are retained only as bounded bins, never raw action text.
  Production startup requires an approved reference profile for every exact model version.
- Runtime qualification: `onnxruntime-node@1.20.1/linux-x64` only. Dynamic-int8 scores are not
  assumed portable across CPU architectures; `judgeRuntime` is sealed alongside `judgeVersion`.
- Known systemic limitations: production prevalence is not yet established; the committed
  balanced logistic-baseline evaluation is not evidence for these ONNX artifacts. Encoded/OOD
  text can be conservatively over-flagged. Native-speaker review and independent validation remain
  open.

## FINRA promissory-language judge

| Field | Value |
|---|---|
| Concern / pack | `finra-promissory` |
| Model version | `finra-promissory@4cef02698045` |
| Base model | `distilbert-base-multilingual-cased` |
| Served artifact | int8 ONNX, SHA-256 `c1bb669450e281515de5aaa78d347be4d6a0bc4fbbebf08ba58294a7f527934c` |
| Tokenizer SHA-256 | `672146ee6867dc02a01c474090e237789f8a066ee7247bb2cb6c8688a27536a8` |
| Maximum tokens | 128 |
| Temperature / threshold | `0.6109424233436584` / `0.5` |
| Intended control | Detect promissory or misleading certainty language for FINRA policy evaluation. |
| Default flagged action | Block under the shipped policy citation. |

## PHI-in-context judge

| Field | Value |
|---|---|
| Concern / pack | `phi-in-context` |
| Model version | `phi-in-context@f307c3117aad` |
| Base model | `distilbert-base-multilingual-cased` |
| Served artifact | ONNX, SHA-256 `c3c076da74f49f8f45679f8c3bd7a4c6744bf01916bf3b03f574a7753980c465` |
| Tokenizer SHA-256 | `672146ee6867dc02a01c474090e237789f8a066ee7247bb2cb6c8688a27536a8` |
| Maximum tokens | 128 |
| Temperature / threshold | `0.6132460832595825` / `0.5` |
| Intended control | Detect possible protected-health-information disclosure context. |
| Default flagged action | Escalate for privacy review. |

## Funds-movement-intent judge

| Field | Value |
|---|---|
| Concern / pack | `funds-movement-intent` |
| Model version | `funds-movement-intent@f3fc84a6dbbf` |
| Base model | `distilbert-base-multilingual-cased` |
| Served artifact | int8 ONNX, SHA-256 `fe4fa002c35db2193598253d834c6a20cd3808361ccfdf4ec70f3ba4c3c81b5e` |
| Tokenizer SHA-256 | `672146ee6867dc02a01c474090e237789f8a066ee7247bb2cb6c8688a27536a8` |
| Maximum tokens | 128 |
| Temperature / threshold | `0.6559091806411743` / `0.5` |
| Intended control | Detect proposed funds-movement intent when mandate controls are evaluated. |
| Default flagged action | Escalate when no mandate is present. |

Engineering qualification for the `speech-act-meta-frame-v2` recipe is recorded in
[`funds-meta-frame-v2.json`](../benchmarks/funds-meta-frame-v2.json). The recipe was frozen before
the replacement lockbox seed was drawn. On that lockbox, the served int8 model reached 98.8%
paraphrase recall versus 93.8% for the frozen logistic baseline, won all seven semantic suites,
retained 100% clean recall, and reduced hard-negative FPR from 84.2% to 8.9%. This resolves the
specific issue-#91 engineering regression; it does not replace independent representative-data,
threshold, OOD, or promotion approval.

## Promotion evidence required

For each exact model version, the approval record must link:

1. representative customer-topology corpus provenance, permitted use, labeling protocol, slice
   coverage, and leakage analysis;
2. blind independent efficacy and adversarial results with confidence intervals;
3. production-prevalence rationale and approved threshold/precision/recall tradeoff;
4. in-distribution and OOD calibration, including encoded-input false-positive treatment;
5. signed latency/load evidence at the production CPU/memory/replica topology;
6. reviewed drift profile, thresholds, alert route, rollback owner, and completed alert exercise.

Any artifact, tokenizer, calibration, threshold, or normalization change creates a new model-system
version and requires re-evaluation. A drift profile is never reused across model versions.
