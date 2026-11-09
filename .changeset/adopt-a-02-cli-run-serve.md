---
"@getpharos/cli": minor
---

`pharos run -- <command>` governs a shell command (verdict, record sealed before anything
executes, then run / block with exit 2 / hold with exit 3) and `pharos serve` starts the Pharos
API over embedded storage with an API key for the project tenant. Projects select their policy
packs in `pharos.yaml`; `init` defaults to the new `coding-agent-safety` pack.
