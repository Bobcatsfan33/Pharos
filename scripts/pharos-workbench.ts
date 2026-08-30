#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import {
  diffPolicies,
  runDoctor,
  sanitizeFixture,
  simulatePolicy,
} from "../packages/devkit/src/index.js";
import type { PolicyArtifact } from "../packages/policy/src/index.js";

function usage(): never {
  throw new Error(
    "usage: pharos:workbench doctor | simulate <policy.json> <cases.json> | diff <base.json> <candidate.json> <cases.json> | sanitize <fixture.json>",
  );
}

async function json(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

const [command, ...args] = process.argv.slice(2);
if (command === "doctor") {
  const result = runDoctor({
    nodeVersion: process.version,
    pharosUrl: process.env.PHAROS_URL,
    apiKey: process.env.PHAROS_API_KEY,
  });
  process.stdout.write(
    JSON.stringify({ passed: result.every((check) => check.passed), checks: result }, null, 2) +
      "\n",
  );
} else if (command === "simulate") {
  if (args.length !== 2) usage();
  process.stdout.write(
    JSON.stringify(
      simulatePolicy((await json(args[0]!)) as PolicyArtifact, (await json(args[1]!)) as never[]),
      null,
      2,
    ) + "\n",
  );
} else if (command === "diff") {
  if (args.length !== 3) usage();
  process.stdout.write(
    JSON.stringify(
      diffPolicies(
        (await json(args[0]!)) as PolicyArtifact,
        (await json(args[1]!)) as PolicyArtifact,
        (await json(args[2]!)) as never[],
      ),
      null,
      2,
    ) + "\n",
  );
} else if (command === "sanitize") {
  if (args.length !== 1) usage();
  process.stdout.write(JSON.stringify(sanitizeFixture(await json(args[0]!)), null, 2) + "\n");
} else {
  usage();
}
