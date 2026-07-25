import type { Concern } from "../schema.js";
import type { ConcernSpec } from "./types.js";
import { FINRA_PROMISSORY } from "./finra.js";
import { PHI_IN_CONTEXT } from "./phi.js";
import { FUNDS_MOVEMENT_INTENT } from "./funds.js";

export type { ConcernSpec, Template } from "./types.js";

export const CONCERN_SPECS: Record<Concern, ConcernSpec> = {
  "finra-promissory": FINRA_PROMISSORY,
  "phi-in-context": PHI_IN_CONTEXT,
  "funds-movement-intent": FUNDS_MOVEMENT_INTENT,
};
