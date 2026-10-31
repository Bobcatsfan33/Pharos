import type { LiabilityContext, MandateBinding } from "../schema/actionRecord.js";
import type { PublicKeyEntry } from "../signing/provider.js";
import { tokenBlockHashes, verifyMandateToken } from "./codec.js";
import type { EffectiveAuthority, MandateToken, SealedMandateToken } from "./types.js";

/**
 * Render the effective authority as the `MandateBinding` the cascade already understands:
 * `limits.maxAmount` drives the Tier-1 ceiling rule, `expiresAt` the expiry rule. The scope is
 * carried in `liability.mandateToken.effective` and enforced by the Tier-1 token-scope rule;
 * it is deliberately NOT written into `limits.actionTypes` (the structural judge keeps reading
 * server-side mandates only until Workstream D3).
 */
export function mandateBindingFromAuthority(eff: EffectiveAuthority): MandateBinding {
  const limits: Record<string, unknown> = {};
  if (eff.limits.financialAmount !== undefined) limits.maxAmount = eff.limits.financialAmount;
  if (eff.limits.currency !== undefined) limits.currency = eff.limits.currency;
  if (eff.limits.reversibility !== undefined) limits.reversibility = eff.limits.reversibility;
  return {
    id: eff.mandateId,
    scope: `token: actionTypes=[${eff.scope.actionTypes.join(", ")}] resources=[${eff.scope.resources.join(", ")}]`,
    limits,
    grantor: eff.grantor,
    expiresAt: eff.expiresAt,
    version: "token",
  };
}

export interface ApplyMandateTokenOptions {
  /** Refuse a token minted for another tenant / agent. */
  expect?: { tenantId?: string; agentId?: string };
  /** Server-side knowledge an offline verifier lacks: the stored mandate was revoked. */
  revoked?: boolean;
}

/**
 * The liability the cascade sees when a token is presented. A verified token SUPERSEDES any
 * server-side mandate: `mandate` becomes the effective authority. A refused token leaves
 * `mandate: null` and records the structural reason so the Tier-1 rule blocks, and so replay
 * reaches the same block from the sealed record alone.
 */
export function applyMandateToken(
  liability: LiabilityContext,
  token: MandateToken,
  rootKey: PublicKeyEntry | null,
  now: Date,
  opts: ApplyMandateTokenOptions = {},
): LiabilityContext {
  const rootKeyId = token?.authority?.keyId ?? "";
  if (!rootKey) {
    const sealed: SealedMandateToken = {
      rootKeyId,
      blockHashes: safeHashes(token),
      headHash: "",
      verification: "root-key-unknown",
    };
    return { ...liability, mandate: null, mandateToken: sealed };
  }
  const result = verifyMandateToken(token, rootKey, now, { expect: opts.expect });
  if (!result.ok || !result.effective) {
    const sealed: SealedMandateToken = {
      rootKeyId,
      blockHashes: result.blockHashes,
      headHash: result.headHash,
      verification: result.code ?? "malformed",
    };
    return { ...liability, mandate: null, mandateToken: sealed };
  }
  if (opts.revoked) {
    const sealed: SealedMandateToken = {
      rootKeyId,
      blockHashes: result.blockHashes,
      headHash: result.headHash,
      verification: "mandate-revoked",
    };
    return { ...liability, mandate: null, mandateToken: sealed };
  }
  const sealed: SealedMandateToken = {
    rootKeyId,
    blockHashes: result.blockHashes,
    headHash: result.headHash,
    verification: "verified",
    effective: result.effective,
  };
  return {
    ...liability,
    mandate: mandateBindingFromAuthority(result.effective),
    mandateToken: sealed,
  };
}

function safeHashes(token: MandateToken): string[] {
  try {
    return tokenBlockHashes(token);
  } catch {
    return [];
  }
}
