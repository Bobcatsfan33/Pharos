import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Platform } from "@pharos/api";
import { CODING_AGENT_SAFETY_PACK } from "@pharos/policy";
import {
  actionForToolCall,
  claudeCodeHookSettings,
  decideToolCall,
  hookOutput,
  type ClaudeCodeHookInput,
} from "../packages/cli/src/commands/hook.js";
import { installClaudeCodeHook } from "../packages/cli/src/commands/init.js";
import { openPlatform } from "../packages/cli/src/platform.js";
import { findProject, renderProjectFile } from "../packages/cli/src/project.js";

/**
 * Conformance for the Claude Code PreToolUse hook protocol: the exact JSON Claude Code sends
 * (tool_name + tool_input shapes) in, the exact `hookSpecificOutput` it expects out, and a
 * sealed record for every decision — including denials. No Docker; never skips.
 */
let root: string;
let platform: Platform;
const project = () => findProject(root)!;
const call = (tool_name: string, tool_input: Record<string, unknown>): ClaudeCodeHookInput => ({
  session_id: "s-1",
  cwd: root,
  hook_event_name: "PreToolUse",
  tool_name,
  tool_input,
  tool_use_id: "tu-1",
});
const decide = (input: ClaudeCodeHookInput, onAllow: "defer" | "allow" = "defer") =>
  decideToolCall(platform, project(), input, [CODING_AGENT_SAFETY_PACK], "claude-code", onAllow);

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "pharos-hook-"));
  writeFileSync(
    join(root, "pharos.yaml"),
    renderProjectFile({
      version: 1,
      tenant: "local",
      storage: { backend: "embedded", dataDir: ".pharos" },
      policies: ["coding-agent-safety"],
    }),
  );
  platform = await openPlatform(project());
  await platform.tenants.createTenant({ tenantId: "local", displayName: "local" });
});
afterAll(async () => {
  await platform.close();
  rmSync(root, { recursive: true, force: true });
});

describe("Claude Code PreToolUse hook", () => {
  it("maps Claude Code tool calls onto the governed action shapes", () => {
    expect(actionForToolCall(call("Bash", { command: "git status" }), "a")).toMatchObject({
      type: "shell.exec",
      payload: { command: "git status", cwd: root },
      sessionId: "s-1",
    });
    expect(
      actionForToolCall(call("Write", { file_path: "/p/.env", content: "x" }), "a"),
    ).toMatchObject({
      type: "file.write",
      payload: { path: "/p/.env", tool: "Write" },
    });
    expect(
      actionForToolCall(call("Read", { file_path: "/home/me/.ssh/id_rsa" }), "a"),
    ).toMatchObject({
      type: "file.read",
      payload: { path: "/home/me/.ssh/id_rsa" },
    });
    expect(
      actionForToolCall(call("mcp__filesystem__delete_file", { path: "/x" }), "a"),
    ).toMatchObject({
      type: "mcp.filesystem.delete_file",
      payload: { server: "filesystem", tool: "delete_file", arguments: { path: "/x" } },
    });
    expect(actionForToolCall(call("WebFetch", { url: "https://x" }), "a").type).toBe(
      "tool.WebFetch",
    );
  });

  it("block → deny with the cited rule, and the denial is sealed", async () => {
    const before = await platform.store.count("local");
    const { output } = await decide(call("Bash", { command: "git push --force origin main" }));
    expect(output.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(output.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(output.hookSpecificOutput.permissionDecisionReason).toMatch(
      /cas-git-force-push-protected/,
    );
    expect(output.hookSpecificOutput.permissionDecisionReason).toMatch(/sealed #\d+ [0-9a-f]{12}…/);
    expect(await platform.store.count("local")).toBe(before + 1);
    const head = await platform.store.getHead("local");
    const record = await platform.store.getRecord("local", head!.sequence);
    expect(record?.content.verdict.decision).toBe("block");
    expect(record?.content.action.type).toBe("shell.exec");
  });

  it("escalate → ask, with the reason a human will read", async () => {
    const { output } = await decide(call("Bash", { command: "rm -rf build" }));
    expect(output.hookSpecificOutput.permissionDecision).toBe("ask");
    expect(output.hookSpecificOutput.permissionDecisionReason).toMatch(/cas-rm-recursive/);
  });

  it("secret reads are denied in the Read/Write shapes, not just Bash", async () => {
    const read = await decide(call("Read", { file_path: `${root}/.env` }));
    expect(read.output.hookSpecificOutput.permissionDecision).toBe("deny");
    const write = await decide(
      call("Edit", { file_path: `${root}/.aws/credentials`, old_string: "a", new_string: "b" }),
    );
    expect(write.output.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("allow → no decision by default (Claude Code's own permission rules still apply), sealed anyway", async () => {
    const before = await platform.store.count("local");
    const { output } = await decide(call("Bash", { command: "pnpm test" }));
    expect(output.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(output.hookSpecificOutput.permissionDecisionReason).toMatch(/allowed and sealed/);
    expect(await platform.store.count("local")).toBe(before + 1);
    const auto = await decide(call("Bash", { command: "pnpm test" }), "allow");
    expect(auto.output.hookSpecificOutput.permissionDecision).toBe("allow");
  });

  it("MCP tool calls are governed as mcp.<server>.<tool> actions and sealed", async () => {
    const { output, verdict } = await decide(
      call("mcp__filesystem__read_file", { path: "/tmp/x" }),
    );
    expect(verdict.decision).toBe("allow");
    expect(output.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    const head = await platform.store.getHead("local");
    expect((await platform.store.getRecord("local", head!.sequence))?.content.action.type).toBe(
      "mcp.filesystem.read_file",
    );
  });

  it("the output shape is exactly what Claude Code documents", () => {
    const verdict = {
      decision: "modify" as const,
      tierReached: 1 as const,
      ruleCitations: [],
      riskScore: 0,
      failMode: null,
      judgeVersion: null,
      latency: { totalMs: 1, perTier: {}, deadlineMs: 800, deadlineBreached: false },
    };
    const out = hookOutput(verdict, call("Bash", { command: "x" }), "defer", {
      sequence: 3,
      hash: "f".repeat(64),
    });
    expect(Object.keys(out)).toEqual(["hookSpecificOutput"]);
    expect(out.hookSpecificOutput).toMatchObject({
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { command: "x" },
    });
  });

  it("pharos init --claude-code merges the hook into .claude/settings.json idempotently", () => {
    const dir = mkdtempSync(join(tmpdir(), "pharos-hook-settings-"));
    mkdirSync(join(dir, ".claude"));
    writeFileSync(
      join(dir, ".claude", "settings.json"),
      JSON.stringify({
        permissions: { allow: ["Bash(ls:*)"] },
        hooks: {
          PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo done" }] }],
        },
      }),
    );
    const first = installClaudeCodeHook(dir);
    expect(first.changed).toBe(true);
    const settings = JSON.parse(readFileSync(first.file, "utf8"));
    expect(settings.permissions).toEqual({ allow: ["Bash(ls:*)"] });
    expect(settings.hooks.PostToolUse).toHaveLength(1);
    expect(settings.hooks.PreToolUse).toEqual([claudeCodeHookSettings()]);
    expect(settings.hooks.PreToolUse[0].matcher).toBe(
      "Bash|Write|Edit|MultiEdit|NotebookEdit|Read|mcp__.*",
    );
    expect(installClaudeCodeHook(dir).changed).toBe(false);
    expect(JSON.parse(readFileSync(first.file, "utf8")).hooks.PreToolUse).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });
});
