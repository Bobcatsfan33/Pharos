/**
 * Reference agent: an OpenAI Agents SDK tool governed by Pharos.
 *
 * The OpenAI Agents SDK calls a tool's `execute(args)`. `openaiAgentTool` returns a tool whose
 * `execute` is wrapped, so Pharos decides BEFORE the side effect runs and the decision is
 * sealed either way. The tool object is the shape the SDK expects (`name`, `parameters`,
 * `execute`), so it can be handed to an `Agent` unchanged — the example calls `execute`
 * directly so it runs without an OpenAI API key or network access.
 *
 *   1. pnpm infra:up && pnpm api:dev
 *   2. provision a tenant + key:
 *        curl -XPOST localhost:4000/v1/admin/tenants -H 'x-pharos-admin: <token>' \
 *             -H 'content-type: application/json' -d '{"tenantId":"acme","displayName":"Acme"}'
 *   3. PHAROS_API_KEY=<key> pnpm tsx examples/openai-agents.ts
 */
import { PharosClient } from "../packages/sdk-ts/src/index.js";
import { openaiAgentTool, PharosBlockedError } from "../packages/middleware/src/index.js";

const TENANT = process.env.PHAROS_TENANT ?? "acme";
const client = new PharosClient({
  baseUrl: process.env.PHAROS_API_BASE ?? "http://localhost:4000",
  apiKey: process.env.PHAROS_API_KEY ?? "",
  deadlineMs: 2000,
});

interface TransferArgs extends Record<string, unknown> {
  amount: number;
  to: string;
}

/**
 * The governed tool. `parameters` is the JSON schema the Agents SDK advertises to the model;
 * `mapAction` is what Pharos judges — note that the declared blast radius is derived from the
 * arguments rather than hardcoded, so a bigger transfer really is a bigger declared risk.
 */
const transferFunds = openaiAgentTool<TransferArgs, { transferred: number }>(
  client,
  {
    tenantId: TENANT,
    agentId: "reference-openai-agent",
    toolName: "payment.transfer",
    parameters: {
      type: "object",
      properties: {
        amount: { type: "number", description: "amount in USD" },
        to: { type: "string", description: "payee account" },
      },
      required: ["amount", "to"],
    },
    mapAction: (args) => ({
      action: { type: "payment.transfer", payload: { amount: args.amount, to: args.to } },
      liability: {
        mandate: null,
        oversightMode: "human_in_loop",
        blastRadius: {
          financialAmount: args.amount,
          currency: "USD",
          // Derived from the arguments, not hardcoded: a small transfer this agent can undo
          // is reversible; a large one is not. Tier 1 escalates an irreversible action under
          // non-autonomous oversight, which is why the second attempt below is held.
          reversibility: args.amount > 10_000 ? "irreversible" : "reversible",
        },
        modelMetadata: { provider: "openai", model: "gpt-5" },
      },
    }),
    // Short on purpose so the example finishes: a real agent waits for the human verdict
    // (or parks the run, as Pharos Runtime does) rather than timing out in three seconds.
    awaitOpts: { pollIntervalMs: 500, timeoutMs: 3_000 },
  },
  async (args) => {
    // The real side effect would move the money here. It only runs if Pharos allowed it.
    return { transferred: args.amount };
  },
);

/**
 * A second governed tool, to show the other side of the decision. A CRM read is reversible,
 * moves no money, and no shipped pack binds a judge to `crm.read`, so it is allowed — and the
 * record is sealed anyway, which is the point: the evidence does not only cover refusals.
 */
const lookupCustomer = openaiAgentTool<{ id: string }, { name: string }>(
  client,
  {
    tenantId: TENANT,
    agentId: "reference-openai-agent",
    toolName: "crm.read",
    parameters: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    mapAction: (args) => ({
      action: { type: "crm.read", payload: { record: args.id } },
      liability: {
        mandate: null,
        oversightMode: "autonomous",
        blastRadius: { financialAmount: 0, currency: "USD", reversibility: "reversible" },
        modelMetadata: { provider: "openai", model: "gpt-5" },
      },
    }),
  },
  async (args) => ({ name: `Customer ${args.id}` }),
);

async function attempt(args: TransferArgs): Promise<void> {
  const label = `${args.amount} USD -> ${args.to}`;
  try {
    const result = await transferFunds.execute(args);
    console.log(`  ${label}: EXECUTED (${result.transferred})`);
  } catch (err) {
    if (err instanceof PharosBlockedError) {
      console.log(`  ${label}: BLOCKED — ${err.reason}`);
      for (const c of err.citations) console.log(`      cited ${c.ruleId} (${c.pack})`);
      return;
    }
    if ((err as { code?: string }).code === "resolution_timeout") {
      console.log(`  ${label}: HELD for human review — the side effect did not run`);
      return;
    }
    throw err;
  }
}

async function main(): Promise<void> {
  if (!process.env.PHAROS_API_KEY) {
    console.error("set PHAROS_API_KEY to a key with actions:write and liability:assert");
    process.exit(1);
  }
  console.log(`tools advertised to the model: "${lookupCustomer.name}", "${transferFunds.name}"\n`);

  // Allowed: reversible, no money, no pack binds a judge to this action type.
  const customer = await lookupCustomer.execute({ id: "4471" });
  console.log(`  crm.read 4471: EXECUTED (${customer.name})`);

  // Held: a funds transfer with no mandate. The shipped `core` pack binds the
  // funds-movement judge with requireNoMandate, so unmandated movement goes to a human —
  // pass `mandateId` in mapAction once a mandate is provisioned and this is allowed instead.
  await attempt({ amount: 25, to: "vendor-a" });
  // Held too, and for a second independent reason: irreversible under non-autonomous oversight.
  await attempt({ amount: 250_000, to: "vendor-b" });

  console.log("\nEvery attempt above is a sealed record, whichever way it was decided.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
