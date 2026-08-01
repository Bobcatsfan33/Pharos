import { PharosError, type SubmitInput } from "./types.js";

/**
 * Runtime validation at the SDK trust boundary (#80).
 *
 * The SDK is a thin client and the server does validate, so for a *reachable* platform
 * this is only faster feedback. The reason it is a safety control rather than a
 * convenience is the unreachable case: `submit()` then applies a local fail-mode chosen
 * by reading `liability.blastRadius.reversibility` out of this same object. A caller who
 * misspells or mistypes that field gets a silent fall-through to the configured default,
 * so an irreversible action can be locally ALLOWED under `localFailMode: "fail_open"` —
 * and the server never sees it, because the server is by definition not reachable. The
 * server cannot defend that path. Only the client can.
 *
 * Design choices, both deliberate:
 *
 *   - **Required/typed/enum checks only; unknown keys are permitted.** Rejecting unknown
 *     keys would break forward compatibility the first time the server grows a field.
 *     A misspelled key is still caught, because the correctly-spelled required field is
 *     then missing.
 *   - **No coercion.** A numeric `tenantId` is an error, not something to stringify.
 *     Silently repairing input means the record sealed as evidence is not the thing the
 *     caller actually asked to govern.
 *
 * Kept dependency-free on purpose: `@getpharos/sdk` ships with zero runtime deps.
 */

const OVERSIGHT_MODES = ["autonomous", "human_in_loop", "human_on_loop"] as const;
const REVERSIBILITY = ["reversible", "irreversible"] as const;

function invalid(path: string, expected: string): never {
  throw new PharosError(`invalid submit input: ${path} ${expected}`, "invalid_input");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function requireNonEmptyString(value: unknown, path: string): void {
  if (typeof value !== "string") invalid(path, "must be a string");
  if (value.trim() === "") invalid(path, "must not be empty");
}

function optionalString(value: unknown, path: string): void {
  if (value === undefined) return;
  requireNonEmptyString(value, path);
}

/**
 * Validate a submission before it is transmitted. Throws `PharosError` with
 * `code === "invalid_input"` naming the offending field.
 */
export function validateSubmitInput(input: SubmitInput): void {
  if (!isPlainObject(input)) invalid("input", "must be an object");

  requireNonEmptyString(input.tenantId, "tenantId");
  optionalString(input.mandateId, "mandateId");
  optionalString(input.idempotencyKey, "idempotencyKey");

  // --- action ---
  const action = input.action;
  if (!isPlainObject(action)) invalid("action", "must be an object");
  requireNonEmptyString(action.type, "action.type");
  requireNonEmptyString(action.agentId, "action.agentId");
  optionalString(action.sessionId, "action.sessionId");
  if (action.payload !== undefined && !isPlainObject(action.payload)) {
    invalid("action.payload", "must be an object when present");
  }

  // --- liability ---
  // This is the sub-object the local fail-mode reads, so it is validated strictly even
  // though the server would also check it.
  const liability = input.liability;
  if (!isPlainObject(liability)) invalid("liability", "must be an object");

  if (!OVERSIGHT_MODES.includes(liability.oversightMode as (typeof OVERSIGHT_MODES)[number])) {
    invalid("liability.oversightMode", `must be one of ${OVERSIGHT_MODES.join(", ")}`);
  }

  const blastRadius = liability.blastRadius;
  if (!isPlainObject(blastRadius)) invalid("liability.blastRadius", "must be an object");

  if (!REVERSIBILITY.includes(blastRadius.reversibility as (typeof REVERSIBILITY)[number])) {
    // The field the local fail-mode depends on. Naming it explicitly matters: this is
    // the error that stops an irreversible action being allowed by a typo.
    invalid("liability.blastRadius.reversibility", `must be one of ${REVERSIBILITY.join(", ")}`);
  }

  const amount = blastRadius.financialAmount;
  if (amount !== undefined) {
    if (typeof amount !== "number" || !Number.isFinite(amount)) {
      invalid("liability.blastRadius.financialAmount", "must be a finite number");
    }
    if (amount < 0) invalid("liability.blastRadius.financialAmount", "must not be negative");
  }
  optionalString(blastRadius.currency, "liability.blastRadius.currency");
  optionalString(blastRadius.notes, "liability.blastRadius.notes");

  // --- optional nested objects ---
  if (liability.mandate !== undefined && liability.mandate !== null) {
    const mandate = liability.mandate;
    if (!isPlainObject(mandate)) invalid("liability.mandate", "must be an object or null");
    requireNonEmptyString(mandate.id, "liability.mandate.id");
    requireNonEmptyString(mandate.grantor, "liability.mandate.grantor");
    if (typeof mandate.scope !== "string") invalid("liability.mandate.scope", "must be a string");
  }

  if (liability.modelMetadata !== undefined && liability.modelMetadata !== null) {
    const model = liability.modelMetadata;
    if (!isPlainObject(model)) invalid("liability.modelMetadata", "must be an object or null");
    requireNonEmptyString(model.provider, "liability.modelMetadata.provider");
    requireNonEmptyString(model.model, "liability.modelMetadata.model");
  }
}
