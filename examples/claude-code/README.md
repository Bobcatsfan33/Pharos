# Claude Code + Pharos: every tool call gets a verdict and a sealed record

```bash
npx @getpharos/cli init --claude-code
```

That writes `pharos.yaml`, creates `.pharos/` (embedded storage), and merges a `PreToolUse`
hook into `.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Write|Edit|MultiEdit|NotebookEdit|Read|mcp__.*",
        "hooks": [{ "type": "command", "command": "npx -y @getpharos/cli hook claude-code", "timeout": 30 }]
      }
    ]
  }
}
```

From then on, every Bash, Write/Edit, Read and MCP tool call Claude Code makes in that project
is submitted as an action, evaluated against the project's policy packs (`coding-agent-safety`
by default), **sealed to the local chain before Claude Code learns the answer**, and mapped onto
the hook protocol:

| Pharos verdict | Hook answer | What Claude Code does |
|---|---|---|
| `block` | `permissionDecision: "deny"` + cited rule | refuses the call and shows Claude the reason — even under `--dangerously-skip-permissions` |
| `escalate` | `permissionDecision: "ask"` + cited rule | prompts you, with the reason |
| `allow` | no decision (sealed) | its own permission rules apply as usual (`--on-allow allow` auto-approves instead) |
| `modify` | `updatedInput` | runs the rewritten input (no shipped pack produces `modify` yet) |

## A real session

[`session-transcript.txt`](session-transcript.txt) is a headless (`claude -p`) session asked to
run `git push --force origin main`. The hook answered `deny` citing
`cas-git-force-push-protected`; Claude reported it could not run the command and why; and
`pharos log` shows the denial sealed as record #0 of the chain:

```
seq  verdict   tier  action      cited rule                    sealed at            hash
#0   BLOCK     3     shell.exec  cas-git-force-push-protected  2026-10-23 03:06:56  2dce28816206…
```

`pharos verify` or `pharos export` turn that chain into a bundle anyone can check offline.

## What the hook can and cannot see

Read [`docs/LIMITATIONS.md` §9](../../docs/LIMITATIONS.md#9-the-claude-code-hook-governs-tool-calls-before-they-run--within-what-a-hook-can-see)
before relying on it: the hook sees the command string or file path, not the effect; coverage is
whatever `.claude/settings.json` says; the rules are string matches, not a sandbox; and embedded
storage is tamper-evident, not WORM. It fails closed (exit 2, call blocked, reason shown) when
it cannot read its input, find a project, or seal a record.

## Test the hook without Claude Code

The protocol is plain JSON over stdin/stdout, so you can exercise it directly — this is what
`scripts/cli-smoke.sh` does in CI:

```bash
echo '{"cwd":"'"$PWD"'","tool_name":"Bash","tool_input":{"command":"git push --force origin main"}}' \
  | npx @getpharos/cli hook claude-code
# {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Pharos blocked this tool call — cas-git-force-push-protected (CAS-2 protected branches): … [sealed #0 …]"}}
```
