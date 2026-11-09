/**
 * Open Policy Decision Point (PDP) contract v1.0 for AI agents.
 *
 * This is the public, vendor-neutral wire contract: an agent action goes in, a verdict comes
 * out, optionally bound to a signed evidence record. The shapes are defined once, as zod
 * schemas in `schema.ts`, and published as JSON Schema (`schema/pdp-v1.schema.json`) so any
 * vendor can implement the contract without this package. Pharos is the reference commercial
 * implementation; this package also ships an independent reference implementation and a
 * conformance suite so non-Pharos PDPs can self-certify.
 */
export { PDP_SPEC_VERSION } from "./schema.js";
export type {
  PdpRequest,
  PdpResponse,
  PdpEvidenceBinding,
  Decision as PdpDecision,
  Reversibility as PdpReversibility,
  OversightMode as PdpOversight,
  RuleCitation as PdpCitation,
} from "./schema.js";

import type { PdpRequest, PdpResponse } from "./schema.js";

/** A PDP implementation under the open contract. */
export type Pdp = (request: PdpRequest) => Promise<PdpResponse> | PdpResponse;
