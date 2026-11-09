---
"@getpharos/cli": minor
---

`pharos hook claude-code` — a Claude Code PreToolUse hook that governs every Bash, Write/Edit,
Read and MCP tool call (block → deny, escalate → ask, allow → Claude Code's own rules), sealing
each decision to the project's embedded chain before answering. `pharos init --claude-code`
installs it into `.claude/settings.json`.
