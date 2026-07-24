/**
 * Reference agent: a LangGraph-style workflow whose tools are governed by Pharos.
 *
 * Demonstrates the full round trip — act, get blocked, get escalated, receive a human
 * verdict, and resume exactly once — using the @getpharos/sdk client and @getpharos/middleware
 * langgraphNode adapter. The "tool" here is a stand-in for any side-effecting step.
 *
 *   1. pnpm infra:up && pnpm api:dev
 *   2. provision a tenant + key:
 *        curl -XPOST localhost:4000/v1/admin/tenants -H 'x-pharos-admin: <token>' \
 *             -H 'content-type: application/json' -d '{"tenantId":"acme","displayName":"Acme"}'
 *   3. PHAROS_API_KEY=<key> pnpm tsx examples/langgraph-agent.ts
 */
import { PharosClient } from "../packages/sdk-ts/src/index.js";
import { langgraphNode, PharosBlockedError } from "../packages/middleware/src/index.js";

const TENANT = process.env.PHAROS_TENANT ?? "acme";
const client = new PharosClient({
  baseUrl: process.env.PHAROS_API_BASE ?? "http://localhost:4000",
  apiKey: process.env.PHAROS_API_KEY ?? "",
  deadlineMs: 2000,
});

interface State extends Record<string, unknown> {
  message: string;
  sent?: boolean;
}

// A governed LangGraph node: the "send email" step. Pharos decides before it runs.
const sendEmailNode = langgraphNode<State, { sent: true }>(
  client,
  {
    tenantId: TENANT,
    agentId: "reference-langgraph-agent",
    toolName: "email.send",
    mapAction: (state) => ({
      action: { type: "email.send", payload: { body: state.message } },
      liability: {
        mandate: null,
        oversightMode: "human_on_loop",
        blastRadius: { financialAmount: 0, currency: "USD", reversibility: "reversible" },
        modelMetadata: null,
      },
    }),
    awaitOpts: { pollIntervalMs: 500, timeoutMs: 60_000 },
  },
  async () => {
    // The real side effect would send the email here.
    return { sent: true };
  },
  (_state, result) => ({ sent: result.sent }),
);

async function runOnce(message: string): Promise<void> {
  try {
    const next = await sendEmailNode({ message });
    console.log(`  message="${message.slice(0, 40)}…" -> sent=${next.sent}`);
  } catch (err) {
    if (err instanceof PharosBlockedError)
      console.log(`  message="${message.slice(0, 40)}…" -> BLOCKED (${err.reason})`);
    else throw err;
  }
}

async function main(): Promise<void> {
  console.log("Reference LangGraph agent — governed by Pharos\n");
  await runOnce("Thanks for reaching out, your statement is attached."); // allowed
  await runOnce("We guarantee a 20% return with no risk — guaranteed profits!"); // blocked (FINRA)
  await runOnce("Patient John Smith was diagnosed with HIV and started therapy."); // escalates — approve it in the console to resume
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
