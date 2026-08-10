import fs from "node:fs";
import path from "node:path";

const workflowsDir = path.resolve(".github/workflows");
const workflowFiles = fs
  .readdirSync(workflowsDir)
  .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
  .sort();

const failures = [];
let remoteActions = 0;

for (const name of workflowFiles) {
  const source = fs.readFileSync(path.join(workflowsDir, name), "utf8");
  for (const [index, line] of source.split(/\r?\n/u).entries()) {
    const match = /^\s*(?:-\s*)?uses:\s*([^\s#]+)/u.exec(line);
    if (!match) continue;

    const target = match[1];
    if (target.startsWith("./") || target.startsWith("docker://")) continue;

    remoteActions += 1;
    const separator = target.lastIndexOf("@");
    const ref = separator === -1 ? "" : target.slice(separator + 1);
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(ref)) {
      failures.push(`${name}:${index + 1}: ${target}`);
    }
  }
}

if (failures.length > 0) {
  console.error("Remote GitHub Actions must use an immutable full commit SHA:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `GitHub Actions pinning valid: ${remoteActions} remote action references across ${workflowFiles.length} workflows`,
);
