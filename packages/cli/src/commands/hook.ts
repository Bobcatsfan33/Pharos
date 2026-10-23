import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { ActionIntent, VerdictContext } from "@pharos/core";
import type { Platform } from "@pharos/api";
import type { PolicyArtifact } from "@pharos/policy";
import { findProject, projectPolicies, type Project } from "../project.js";
import { openPlatform } from "../platform.js";
import { COMMAND_LIABILITY } from "./run.js";

export const hookHelp = `pharos hook claude-code [--agent <id>] [--on-allow defer|allow]

  A Claude Code PreToolUse hook. Reads the hook JSON on stdin, submits the tool call as a
  Pharos action, seals the verdict to the project's embedded chain, and answers:
    block     -> permissionDecision "deny"  (holds even under --dangerously-skip-permissions)
    escalate  -> permissionDecision "ask"   (Claude Code prompts the human, with the cited rule)
    modify    -> updatedInput              (the rewritten tool input)
    allow     -> no decision: Claude Code's own permission rules still apply (--on-allow allow
                 auto-approves instead)
  Wire it with: pharos init --claude-code`;

/** What Claude Code sends a PreToolUse hook (the fields this hook reads). */
export interface ClaudeCodeHookInput {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name: string;
  tool_input?: Record<string, unknown>;
  tool_use_id?: string;
}

export interface ClaudeCodeHookOutput {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision?: "allow" | "deny" | "ask";
    permissionDecisionReason?: string;
    updatedInput?: Record<string, unknown>;
  };
}

/**
 * Map a Claude Code tool call onto the action shapes the coding-agent-safety pack governs.
 * The mapping is the contract between the hook and the policy packs; it is pinned by tests.
 */
/** Canonicalisation refuses `undefined`; optional fields are omitted, never set to undefined. */
function compact<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

export function actionForToolCall(input: ClaudeCodeHookInput, agentId: string): ActionIntent {
  const emittedAt = new Date().toISOString();
  const args = input.tool_input ?? {};
  const base = compact({ agentId, emittedAt, sessionId: input.session_id });
  const mcp = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(input.tool_name);
  if (mcp) {
    return {
      ...base,
      type: `mcp.${mcp[1]}.${mcp[2]}`,
      payload: compact({
        server: mcp[1],
        tool: mcp[2],
        arguments: args,
        toolUseId: input.tool_use_id,
      }),
    };
  }
  switch (input.tool_name) {
    case "Bash":
      return {
        ...base,
        type: "shell.exec",
        payload: compact({
          command: String(args.command ?? ""),
          description: args.description,
          cwd: input.cwd,
        }),
      };
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return {
        ...base,
        type: "file.write",
        payload: compact({
          path: String(args.file_path ?? args.notebook_path ?? ""),
          tool: input.tool_name,
          cwd: input.cwd,
        }),
      };
    case "Read":
      return {
        ...base,
        type: "file.read",
        payload: compact({ path: String(args.file_path ?? ""), cwd: input.cwd }),
      };
    default:
      return {
        ...base,
        type: `tool.${input.tool_name}`,
        payload: compact({ arguments: args, cwd: input.cwd }),
      };
  }
}

function reason(verdict: VerdictContext, prefix: string): string {
  const c = verdict.ruleCitations[0];
  const cite = c
    ? `${c.ruleId}${c.clause ? ` (${c.clause})` : ""}${c.description ? `: ${c.description}` : ""}`
    : "no rule cited";
  return `Pharos ${prefix} — ${cite}`;
}

/** Translate a sealed verdict into the hook's answer. Pure; pinned by the conformance test. */
export function hookOutput(
  verdict: VerdictContext,
  input: ClaudeCodeHookInput,
  onAllow: "defer" | "allow",
  sealed: { sequence: number; hash: string },
): ClaudeCodeHookOutput {
  const where = `sealed #${sealed.sequence} ${sealed.hash.slice(0, 12)}…`;
  const out: ClaudeCodeHookOutput["hookSpecificOutput"] = { hookEventName: "PreToolUse" };
  switch (verdict.decision) {
    case "block":
      out.permissionDecision = "deny";
      out.permissionDecisionReason = `${reason(verdict, "blocked this tool call")} [${where}]`;
      break;
    case "escalate":
      out.permissionDecision = "ask";
      out.permissionDecisionReason = `${reason(verdict, "needs a human to confirm this tool call")} [${where}]`;
      break;
    case "modify": {
      // The packs do not produce modify today; when one does, the rewritten input rides here.
      out.permissionDecision = "allow";
      out.permissionDecisionReason = `${reason(verdict, "modified this tool call")} [${where}]`;
      out.updatedInput = input.tool_input ?? {};
      break;
    }
    case "allow":
      if (onAllow === "allow") out.permissionDecision = "allow";
      out.permissionDecisionReason = `Pharos allowed and sealed this tool call [${where}]`;
      break;
  }
  return { hookSpecificOutput: out };
}

export async function decideToolCall(
  platform: Platform,
  project: Project,
  input: ClaudeCodeHookInput,
  policies: PolicyArtifact[],
  agentId: string,
  onAllow: "defer" | "allow",
): Promise<{ output: ClaudeCodeHookOutput; verdict: VerdictContext }> {
  const tenantId = project.config.tenant;
  const action = actionForToolCall(input, agentId);
  const verdict = await platform.cascade.evaluate(
    { tenantId, action, liability: COMMAND_LIABILITY },
    new Date(),
    policies,
  );
  // Sealed BEFORE Claude Code learns the answer: a denied call is evidence too.
  const record = await platform.store.append({
    tenantId,
    action,
    verdict,
    liability: COMMAND_LIABILITY,
  });
  return {
    output: hookOutput(verdict, input, onAllow, {
      sequence: record.content.sequence,
      hash: record.seal.contentHash,
    }),
    verdict,
  };
}

export async function hook(argv: string[]): Promise<number> {
  const [kind, ...rest] = argv;
  if (kind !== "claude-code") {
    process.stderr.write(
      "usage: pharos hook claude-code [--agent <id>] [--on-allow defer|allow]\n",
    );
    return 2;
  }
  const { values } = parseArgs({
    args: rest,
    options: {
      agent: { type: "string", default: "claude-code" },
      "on-allow": { type: "string", default: "defer" },
    },
  });
  const onAllow = values["on-allow"] === "allow" ? "allow" : "defer";

  let input: ClaudeCodeHookInput;
  try {
    input = JSON.parse(readFileSync(0, "utf8")) as ClaudeCodeHookInput;
    if (!input || typeof input.tool_name !== "string") throw new Error("missing tool_name");
  } catch (err) {
    // Malformed input is not a verdict. Fail closed with a readable reason (exit 2 = block).
    process.stderr.write(
      `pharos hook: could not read PreToolUse JSON on stdin (${(err as Error).message})\n`,
    );
    return 2;
  }

  const project = findProject(input.cwd ?? process.cwd());
  if (!project) {
    process.stderr.write(
      "pharos hook: no pharos.yaml found from the working directory up — run `pharos init --claude-code` in the project. Blocking the call rather than governing nothing.\n",
    );
    return 2;
  }
  const platform = await openPlatform(project);
  try {
    const { output } = await decideToolCall(
      platform,
      project,
      input,
      projectPolicies(project),
      values.agent!,
      onAllow,
    );
    process.stdout.write(`${JSON.stringify(output)}\n`);
    return 0;
  } catch (err) {
    // Could not seal => could not govern. Exit 2 blocks the call and shows Claude the reason.
    process.stderr.write(
      `pharos hook: ${(err as Error).message} — blocking the call because no record could be sealed\n`,
    );
    return 2;
  } finally {
    await platform.close();
  }
}

/** The settings.json fragment `pharos init --claude-code` installs. */
export const CLAUDE_CODE_HOOK_MATCHER = "Bash|Write|Edit|MultiEdit|NotebookEdit|Read|mcp__.*";
export function claudeCodeHookSettings(command = "npx -y @getpharos/cli hook claude-code"): {
  matcher: string;
  hooks: Array<{ type: "command"; command: string; timeout: number }>;
} {
  return { matcher: CLAUDE_CODE_HOOK_MATCHER, hooks: [{ type: "command", command, timeout: 30 }] };
}
