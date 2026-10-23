import type { Condition, PolicyArtifact } from "../rules.js";

/**
 * coding-agent-safety v1 — the wedge pack.
 *
 * A coding agent with shell, git, file and MCP access is the governed subject. Actions
 * arrive in the shapes `pharos run`, the Claude Code hook, and the MCP proxy produce:
 *
 *   shell.exec   payload.command (the full command line), payload.argv, payload.cwd
 *   file.read    payload.path
 *   file.write   payload.path
 *   git.push     payload.command (the full git invocation)
 *
 * Rules are string conditions over those fields (the policy IR has `contains` /
 * `startsWith`, no regular expressions), so the pack is deliberately conservative: it names
 * the specific, widely-agreed dangerous shapes and escalates — never silently allows — the
 * ambiguous ones. Authority where one exists: OWASP Top 10 for LLM Applications 2025, LLM06
 * "Excessive Agency" and LLM02 "Sensitive Information Disclosure"; NIST AI RMF MANAGE 2.3
 * (mechanisms to supersede, disengage, or deactivate). This is a safety net for a developer
 * at 11 pm, not a compliance control; Phase C ships it as YAML with should-allow /
 * should-block / should-escalate fixtures that CI runs.
 */
const SHELL = { field: "action.type", op: "eq", value: "shell.exec" } as const;
const cmd = (op: "contains" | "startsWith", value: string): Condition => ({
  field: "action.payload.command",
  op,
  value,
});
const path = (value: string): Condition => ({
  field: "action.payload.path",
  op: "contains",
  value,
});
const anyCmd = (...values: string[]): Condition => ({ any: values.map((v) => cmd("contains", v)) });

export const CODING_AGENT_SAFETY_PACK: PolicyArtifact = {
  packId: "coding-agent-safety",
  version: "1.0.0",
  title: "Coding-agent safety: shell, git, secrets, egress, publish, cloud",
  changelog:
    "v1: destructive filesystem, force-push to protected branches, secret reads, exfiltration, package publishes, cloud destructive ops, history rewrites.",
  rules: [
    {
      ruleId: "cas-rm-root",
      pack: "coding-agent-safety",
      clause: "CAS-1 destructive filesystem (outside the working tree)",
      description:
        "Recursive force-delete of the filesystem root, the home directory, or a parent directory is never something a coding agent should do unattended. Blocked.",
      when: {
        all: [
          SHELL,
          anyCmd(
            "rm -rf /",
            "rm -rf ~",
            "rm -rf ..",
            "rm -rf $HOME",
            "rm -fr /",
            "rm -fr ~",
            "rm -rf *",
          ),
        ],
      },
      decision: "block",
    },
    {
      ruleId: "cas-rm-recursive",
      pack: "coding-agent-safety",
      clause: "CAS-1 destructive filesystem",
      description:
        "A recursive force-delete inside the working tree may be legitimate (build output) or may erase work that is not committed. Held for a human to confirm.",
      when: { all: [SHELL, anyCmd("rm -rf", "rm -fr", "rm -r -f")] },
      decision: "escalate",
    },
    {
      ruleId: "cas-git-force-push-protected",
      pack: "coding-agent-safety",
      clause: "CAS-2 protected branches",
      description:
        "A force-push to main or master rewrites shared history that other people and CI depend on. Blocked; open a pull request instead.",
      when: {
        all: [
          { any: [SHELL, { field: "action.type", op: "eq", value: "git.push" }] },
          cmd("contains", "git push"),
          anyCmd("--force", " -f ", "--force-with-lease"),
          anyCmd(" main", " master", "refs/heads/main", "refs/heads/master"),
        ],
      },
      decision: "block",
    },
    {
      ruleId: "cas-git-force-push",
      pack: "coding-agent-safety",
      clause: "CAS-2 force push",
      description:
        "A force-push to any branch discards commits that may exist only on the remote. Held for a human to confirm.",
      when: {
        all: [
          { any: [SHELL, { field: "action.type", op: "eq", value: "git.push" }] },
          cmd("contains", "git push"),
          anyCmd("--force", " -f "),
        ],
      },
      decision: "escalate",
    },
    {
      ruleId: "cas-git-history-rewrite",
      pack: "coding-agent-safety",
      clause: "CAS-2 history rewrite",
      description:
        "Hard resets, untracked-file cleans, and branch force-deletes destroy local work that is not elsewhere. Held for a human to confirm.",
      when: {
        all: [
          SHELL,
          anyCmd(
            "git reset --hard",
            "git clean -f",
            "git clean -xdf",
            "git branch -D",
            "git checkout -- .",
          ),
        ],
      },
      decision: "escalate",
    },
    {
      ruleId: "cas-secret-read",
      pack: "coding-agent-safety",
      clause: "CAS-3 secret material (OWASP LLM02)",
      description:
        "Reading .env files, SSH private keys, cloud credential files, or the OS keychain exposes secrets to the model context and to any tool that sees the transcript. Blocked.",
      when: {
        any: [
          {
            all: [
              SHELL,
              anyCmd(
                ".env",
                "id_rsa",
                "id_ed25519",
                ".ssh/",
                ".aws/credentials",
                ".netrc",
                "security find-generic-password",
                "security find-internet-password",
                ".kube/config",
                ".npmrc",
                ".pypirc",
              ),
            ],
          },
          {
            all: [
              {
                any: [
                  { field: "action.type", op: "eq", value: "file.read" },
                  { field: "action.type", op: "eq", value: "file.write" },
                ],
              },
              {
                any: [
                  path(".env"),
                  path("id_rsa"),
                  path("id_ed25519"),
                  path(".ssh/"),
                  path(".aws/credentials"),
                  path(".netrc"),
                  path(".kube/config"),
                  path(".npmrc"),
                  path(".pypirc"),
                ],
              },
            ],
          },
        ],
      },
      decision: "block",
    },
    {
      ruleId: "cas-exfiltration",
      pack: "coding-agent-safety",
      clause: "CAS-4 outbound transfer of local files",
      description:
        "Uploading local files with curl or wget sends data off the machine. Held for a human to confirm the destination.",
      when: {
        all: [
          SHELL,
          {
            any: [
              {
                all: [
                  cmd("contains", "curl"),
                  anyCmd(" -F ", " -T ", "--upload-file", "--data-binary @", " -d @", "--data @"),
                ],
              },
              { all: [cmd("contains", "wget"), anyCmd("--post-file", "--body-file")] },
              anyCmd("scp ", "rsync ", "rclone "),
            ],
          },
        ],
      },
      decision: "escalate",
    },
    {
      ruleId: "cas-package-publish",
      pack: "coding-agent-safety",
      clause: "CAS-5 registry publish",
      description:
        "Publishing a package is irreversible on every public registry. Held for a human to confirm.",
      when: {
        all: [
          SHELL,
          anyCmd(
            "npm publish",
            "pnpm publish",
            "yarn publish",
            "twine upload",
            "cargo publish",
            "gem push",
            "docker push",
            "gh release create",
          ),
        ],
      },
      decision: "escalate",
    },
    {
      ruleId: "cas-cloud-destructive",
      pack: "coding-agent-safety",
      clause: "CAS-6 destructive infrastructure operations",
      description:
        "Destroying or deleting cloud resources, clusters, databases, or images from an agent session is held for a human to confirm.",
      when: {
        all: [
          SHELL,
          {
            any: [
              anyCmd(
                "terraform destroy",
                "tofu destroy",
                "pulumi destroy",
                "kubectl delete",
                "helm uninstall",
                "docker system prune",
                "dropdb",
                "DROP TABLE",
                "DROP DATABASE",
              ),
              {
                all: [
                  cmd("contains", "aws "),
                  anyCmd(" delete", " terminate-instances", " rm ", "s3 rb"),
                ],
              },
              { all: [cmd("contains", "gcloud "), cmd("contains", " delete")] },
              { all: [cmd("contains", "az "), cmd("contains", " delete")] },
            ],
          },
        ],
      },
      decision: "escalate",
    },
  ],
};
