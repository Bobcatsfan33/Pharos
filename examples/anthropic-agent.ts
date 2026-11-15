/**
 * Reference agent: Anthropic SDK `tool_use` handlers governed by Pharos.
 *
 * `anthropicToolHandlers` wraps a map of tool handlers, so each `tool_use` block the model
 * emits is governed before its handler runs. The wrapped map has the same shape as the one you
 * already dispatch on, so adoption is one call at the boundary. Note the trade: this adapter
 * governs every tool under one default liability. For per-tool risk, use `governTool` with a
 * `mapAction` — see examples/openai-agents.ts, which does exactly that. This example dispatches the
 * handlers directly against a recorded `tool_use` block, so it runs with no Anthropic API key
 * and no network access.
 *
 *   1. pnpm infra:up && pnpm api:dev
 *   2. provision a tenant + key:
 *        curl -XPOST localhost:4000/v1/admin/tenants -H 'x-pharos-admin: <token>' \
 *             -H 'content-type: application/json' -d '{"tenantId":"acme","displayName":"Acme"}'
 *   3. PHAROS_API_KEY=<key> pnpm tsx examples/anthropic-agent.ts
 */
import { PharosClient } from "../packages/sdk-ts/src/index.js";
import { anthropicToolHandlers, PharosBlockedError } from "../packages/middleware/src/index.js";

const TENANT = process.env.PHAROS_TENANT ?? "acme";
const client = new PharosClient({
  baseUrl: process.env.PHAROS_API_BASE ?? "http://localhost:4000",
  apiKey: process.env.PHAROS_API_KEY ?? "",
  deadlineMs: 2000,
});

/** What a `tool_use` content block looks like coming back from the Messages API. */
interface ToolUse {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * The unwrapped handlers — ordinary functions, no Pharos in sight. The tool NAME is what
 * Pharos governs the call as,
 * so the map is keyed with the action types directly (`crm.read`, `record.delete`).
 */
// One result type across the map: `anthropicToolHandlers` is generic in a single R, which is
// what lets it return a map with the same shape you already dispatch on.
type ToolResult = { ok: true; detail: string };

const rawHandlers: Record<string, (input: Record<string, unknown>) => Promise<ToolResult>> = {
  "crm.read": async (input) => {
    return { ok: true, detail: `read ${String(input.id ?? "")}` };
  },
  "record.delete": async (input) => {
    // The real side effect would delete the row here.
    return { ok: true, detail: `deleted ${String(input.id ?? "")}` };
  },
};

/** One call at the boundary governs every handler in the map. */
const handlers = anthropicToolHandlers(
  client,
  { tenantId: TENANT, agentId: "reference-anthropic-agent" },
  rawHandlers,
);

/**
 * How long to wait on an escalation. Short on purpose so the example finishes; a real agent
 * waits for the human verdict, or parks the run as Pharos Runtime does.
 */
const HELD_NOTE = "HELD for human review — the handler did not run";

async function dispatch(block: ToolUse): Promise<void> {
  const handler = handlers[block.name];
  if (!handler) {
    console.log(`  ${block.name}: no handler registered`);
    return;
  }
  try {
    const result = await handler(block.input);
    console.log(`  ${block.name}: EXECUTED ${JSON.stringify(result)}`);
  } catch (err) {
    if (err instanceof PharosBlockedError) {
      console.log(`  ${block.name}: BLOCKED — ${err.reason}`);
      for (const c of err.citations) console.log(`      cited ${c.ruleId} (${c.pack})`);
      return;
    }
    if ((err as { code?: string }).code === "resolution_timeout") {
      console.log(`  ${block.name}: ${HELD_NOTE}`);
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
  console.log(`governed tools: ${Object.keys(handlers).join(", ")}\n`);
  // Two recorded tool_use blocks, as the Messages API would return them.
  // Allowed: a reversible read that moves no money.
  await dispatch({ type: "tool_use", id: "toolu_01", name: "crm.read", input: { id: "4471" } });
  // Also allowed, and worth understanding why. `anthropicToolHandlers` takes only a tenant and
  // an agent — it has no per-tool `mapAction` — so every tool is governed under governTool's
  // default liability: human_in_loop, irreversible, blast radius ZERO. Tier 1's
  // irreversible-oversight rule requires a non-zero amount, so a delete under that default is
  // allowed and sealed rather than held. If a tool needs its own declared risk, wrap it with
  // `governTool` directly and pass `mapAction` (which is what this adapter calls internally).
  await dispatch({
    type: "tool_use",
    id: "toolu_02",
    name: "record.delete",
    input: { id: "customer-4471" },
  });
  console.log(
    "\nBoth dispatches are sealed records. Neither was refused here — see the note above on\n" +
      "the single default liability, and examples/openai-agents.ts for per-tool risk mapping.",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
