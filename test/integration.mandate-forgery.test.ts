import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";

/**
 * Server-bound mandate authority (threat-model issue #81).
 *
 * `liability` is caller-supplied by design — the caller declares blast radius and
 * oversight mode, and Pharos seals that declaration as evidence of what was asserted.
 * `liability.mandate` is different in kind. It is not a declaration about the action;
 * it is a claim to *authority*, and the cascade treats it as one:
 *
 *     if (binding.requireNoMandate && req.liability.mandate !== null) continue;
 *
 * Mandate-gated controls — `funds-movement-unmandated` among them — stand down when a
 * mandate is present. So a caller who can put an arbitrary object at
 * `liability.mandate` can switch off the control that exists precisely to catch
 * unmandated funds movement, and the forged grant is then sealed into the evidence
 * record as if a grantor had issued it.
 *
 * The server already resolves real mandates itself from `mandateId`
 * (`platform.mandates.getActive`). The gap was that it also accepted one inline.
 * Authority must be derived server-side, never asserted by the caller.
 */
const keystoreDir = mkdtempSync(join(tmpdir(), "pharos-mandate-keystore-"));
process.env.PHAROS_ENV = "local";
process.env.PHAROS_PG_URL ??= "postgres://pharos:pharos_local_dev@localhost:5433/pharos";
process.env.PHAROS_REDIS_URL ??= "redis://localhost:6380";
process.env.PHAROS_S3_ENDPOINT ??= "http://localhost:9010";
process.env.PHAROS_S3_REGION ??= "us-east-1";
process.env.PHAROS_S3_BUCKET ??= "pharos-evidence";
process.env.PHAROS_S3_ACCESS_KEY ??= "pharos";
process.env.PHAROS_S3_SECRET_KEY ??= "pharos_local_dev";
process.env.PHAROS_S3_FORCE_PATH_STYLE ??= "true";
process.env.PHAROS_KMS_PROVIDER = "local-kms";
process.env.PHAROS_KMS_KEYSTORE_DIR = keystoreDir;
process.env.PHAROS_ADMIN_TOKEN = "mandate-admin";

type Platform = import("../services/api/src/platform.js").Platform;
const TENANT = `mand-${randomUUID().slice(0, 8)}`;
let available = true;
let platform: Platform | null = null;
let app: FastifyInstance | null = null;
const auth = { "x-api-key": "" };

beforeAll(async () => {
  try {
    const { buildPlatform } = await import("../services/api/src/platform.js");
    const { buildApp } = await import("../services/api/src/app.js");
    platform = await buildPlatform();
    app = await buildApp(platform);
    await platform.tenants.createTenant({ tenantId: TENANT, displayName: "Mandate" });
    auth["x-api-key"] = (
      await platform.apiKeys.create(TENANT, "m", [
        "actions:write",
        "liability:assert",
        "records:read",
      ])
    ).plaintext;
  } catch (err) {
    console.warn("[mandate] infrastructure unavailable, skipping:", (err as Error).message);
    available = false;
  }
});

afterAll(async () => {
  await app?.close();
  await platform?.close();
});

/**
 * An unmandated funds movement, deliberately sized so the *mandate gate* is what decides.
 *
 * A large irreversible transfer short-circuits at Tier 2 on `risk-extreme` before Tier 3
 * runs, which would mask the bug: both mandated and unmandated variants escalate for an
 * unrelated reason. At this size Tier 2 does not short-circuit, so the Tier-3
 * funds-movement binding is the deciding control — measured on main:
 *
 *   mandate: null   -> escalate  [finra-3110-funds-movement]
 *   forged mandate  -> allow     [] (no citations at all)
 */
function fundsMovement(mandate: unknown) {
  return {
    tenantId: TENANT,
    action: {
      type: "payment.transfer",
      agentId: "agent-1",
      payload: { to: "payee", amount: 1_000, memo: "please wire the funds to this account" },
    },
    liability: {
      mandate,
      oversightMode: "autonomous" as const,
      blastRadius: {
        financialAmount: 1_000,
        currency: "USD",
        reversibility: "reversible" as const,
      },
      modelMetadata: null,
    },
  };
}

/** A grant the caller simply invented. No grantor ever issued it. */
const FORGED_MANDATE = {
  id: "forged-mandate-1",
  scope: "unlimited wire transfers",
  limits: { maxAmount: 100_000_000, currency: "USD" },
  grantor: "definitely-the-cfo",
  expiresAt: null,
  version: "1",
};

async function submit(body: unknown) {
  return app!.inject({
    method: "POST",
    url: "/v1/actions",
    headers: auth,
    payload: body as object,
  });
}

describe("mandate authority is server-derived, never caller-asserted", () => {
  it("refuses an inline caller-supplied mandate", async (ctx) => {
    if (!available) return ctx.skip();
    const res = await submit(fundsMovement(FORGED_MANDATE));

    // Refused, not silently stripped: silently dropping it would let the caller believe
    // the action was mandated, and would hide the attempt from the operator.
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("mandate_not_assertable");
  });

  it("also refuses caller-supplied mandate authority on the open PDP endpoint", async (ctx) => {
    if (!available) return ctx.skip();
    const body = fundsMovement(FORGED_MANDATE);
    const res = await app!.inject({
      method: "POST",
      url: "/v1/pdp",
      headers: auth,
      payload: { action: body.action, liability: body.liability },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("mandate_not_assertable");
  });

  it("names mandateId as the only way to bind authority", async (ctx) => {
    if (!available) return ctx.skip();
    const res = await submit(fundsMovement(FORGED_MANDATE));
    expect(JSON.stringify(res.json().error)).toMatch(/mandateId/);
  });

  it("writes no record when a forged mandate is refused", async (ctx) => {
    if (!available) return ctx.skip();
    const before = await app!.inject({
      method: "GET",
      url: `/v1/chain/${TENANT}`,
      headers: auth,
    });
    await submit(fundsMovement(FORGED_MANDATE));
    const after = await app!.inject({ method: "GET", url: `/v1/chain/${TENANT}`, headers: auth });

    // A forged grant must never be sealed into evidence, not even attached to a
    // blocked verdict.
    expect(after.json().data.count).toBe(before.json().data.count);
  });

  it("still escalates unmandated funds movement when mandate is null", async (ctx) => {
    if (!available) return ctx.skip();
    // The control the forgery was switching off. Asserted on the citation, not just the
    // decision, so this cannot pass for an unrelated reason (e.g. a Tier-2 short-circuit).
    const res = await submit(fundsMovement(null));
    expect(res.statusCode).toBe(201);
    expect(res.json().data.verdict.decision).toBe("escalate");
    expect(
      res.json().data.verdict.ruleCitations.map((c: { ruleId: string }) => c.ruleId),
    ).toContain("finra-3110-funds-movement");
  });

  it("a forged mandate cannot turn that escalation into an allow", async (ctx) => {
    if (!available) return ctx.skip();
    // This is the privilege escalation, measured on main before the fix:
    //   mandate: null  -> escalate [finra-3110-funds-movement]
    //   forged mandate -> allow    [] (control stood down, no citations)
    // The forged grant was also sealed into evidence with grantor "definitely-the-cfo".
    const res = await submit(fundsMovement(FORGED_MANDATE));
    expect(res.statusCode).toBe(400);
    // Whatever else is true, an invented grant must never yield a clean allow.
    expect(res.json().data).toBeNull();
  });

  it("accepts a real, server-resolved mandate via mandateId", async (ctx) => {
    if (!available) return ctx.skip();
    const mandateId = `m-${randomUUID().slice(0, 8)}`;
    await platform!.mandates.create({
      tenantId: TENANT,
      mandateId,
      scope: "wire transfers up to 500k",
      limits: { maxAmount: 500_000, currency: "USD" },
      grantor: "treasury-controller",
      expiresAt: null,
    });

    const body = { ...fundsMovement(null), mandateId };
    const res = await submit(body);

    expect(res.statusCode).toBe(201);
    // The sealed record carries the mandate the SERVER resolved, with the real grantor.
    const sealed = res.json().data.record.content.liability.mandate;
    expect(sealed).not.toBeNull();
    expect(sealed.id).toBe(mandateId);
    expect(sealed.grantor).toBe("treasury-controller");
    expect(sealed.grantor).not.toBe(FORGED_MANDATE.grantor);
  });

  it("refuses an inline mandate even when a real mandateId is also supplied", async (ctx) => {
    if (!available) return ctx.skip();
    const mandateId = `m-${randomUUID().slice(0, 8)}`;
    await platform!.mandates.create({
      tenantId: TENANT,
      mandateId,
      scope: "small transfers",
      limits: { maxAmount: 100, currency: "USD" },
      grantor: "treasury-controller",
      expiresAt: null,
    });

    // Ambiguity resolves to refusal rather than to "server wins silently": the caller
    // asked for something the server will not honour, so say so.
    const res = await submit({ ...fundsMovement(FORGED_MANDATE), mandateId });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("mandate_not_assertable");
  });

  it("accepts liability with mandate omitted entirely", async (ctx) => {
    if (!available) return ctx.skip();
    // `mandate` is optional in the schema; omitting it must behave as "no mandate",
    // not as a validation failure, so existing callers are unaffected.
    const body = fundsMovement(null) as Record<string, unknown>;
    const liability = { ...(body.liability as Record<string, unknown>) };
    delete liability.mandate;
    const res = await submit({ ...body, liability });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.record.content.liability.mandate).toBeNull();
  });
});
