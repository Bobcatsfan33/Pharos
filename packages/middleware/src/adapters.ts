import { type Governor, type GovernOptions, governTool } from "./govern.js";

/**
 * Framework adapters. Each is a thin structural wrapper that produces the shape the target
 * framework expects, with the tool body governed by Pharos via the shared governTool().
 * They are dependency-free (structural typing) so they install and test without pulling in
 * every framework, and they all share one conformance contract.
 */

// --- LangChain / LangGraph ---
export interface LangChainTool<Args, R> {
  name: string;
  description: string;
  invoke: (args: Args) => Promise<R>;
}

export function langchainTool<Args, R>(
  governor: Governor,
  opts: GovernOptions<Args> & { description?: string },
  tool: (args: Args) => Promise<R> | R,
): LangChainTool<Args, R> {
  return {
    name: opts.toolName,
    description: opts.description ?? `Governed tool ${opts.toolName}`,
    invoke: governTool(governor, opts, tool),
  };
}

/** A LangGraph node wrapping a governed tool (node = (state) => partial state). */
export function langgraphNode<State extends Record<string, unknown>, R>(
  governor: Governor,
  opts: GovernOptions<State>,
  tool: (state: State) => Promise<R> | R,
  apply: (state: State, result: R) => Partial<State>,
): (state: State) => Promise<Partial<State>> {
  const governed = governTool(governor, opts, tool);
  return async (state: State) => apply(state, await governed(state));
}

// --- OpenAI Agents SDK ---
export interface OpenAIAgentTool<Args, R> {
  name: string;
  parameters: Record<string, unknown>;
  execute: (args: Args) => Promise<R>;
}

export function openaiAgentTool<Args, R>(
  governor: Governor,
  opts: GovernOptions<Args> & { parameters?: Record<string, unknown> },
  tool: (args: Args) => Promise<R> | R,
): OpenAIAgentTool<Args, R> {
  return {
    name: opts.toolName,
    parameters: opts.parameters ?? { type: "object", properties: {} },
    execute: governTool(governor, opts, tool),
  };
}

// --- Anthropic SDK (tool_use interception) ---
/** Wrap a map of Anthropic tool handlers so each tool_use is governed before execution. */
export function anthropicToolHandlers<R>(
  governor: Governor,
  base: { tenantId: string; agentId: string },
  handlers: Record<string, (input: Record<string, unknown>) => Promise<R> | R>,
): Record<string, (input: Record<string, unknown>) => Promise<R>> {
  const out: Record<string, (input: Record<string, unknown>) => Promise<R>> = {};
  for (const [toolName, handler] of Object.entries(handlers)) {
    out[toolName] = governTool(governor, { tenantId: base.tenantId, agentId: base.agentId, toolName }, handler);
  }
  return out;
}
