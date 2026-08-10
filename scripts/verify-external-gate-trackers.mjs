#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.resolve(
  process.argv[2] ?? path.join(root, "docs/enterprise-readiness.json"),
);
const repository = "Bobcatsfan33/Pharos";
const issuePattern = /^https:\/\/github\.com\/Bobcatsfan33\/Pharos\/issues\/([1-9]\d*)$/;

function fail(message) {
  throw new Error(message);
}

async function verify() {
  if (process.argv.length > 3) fail("usage: verify-external-gate-trackers.mjs [manifest.json]");
  const document = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const gates = document.externalGates;
  if (!Array.isArray(gates) || gates.length === 0) fail("manifest externalGates must not be empty");

  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "pharos-readiness-verifier",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  let trackers = 0;
  for (const gate of gates) {
    if (!Array.isArray(gate.trackingIssues) || gate.trackingIssues.length === 0) {
      fail(`gate ${gate.id} has no tracking issues`);
    }
    let open = 0;
    for (const tracker of gate.trackingIssues) {
      const match = issuePattern.exec(tracker);
      if (!match) fail(`gate ${gate.id} has an invalid tracker URL: ${tracker}`);
      const response = await fetch(
        `https://api.github.com/repos/${repository}/issues/${match[1]}`,
        {
          headers,
        },
      );
      if (!response.ok) {
        fail(`gate ${gate.id} tracker ${tracker} returned GitHub API status ${response.status}`);
      }
      const issue = await response.json();
      if (issue.pull_request)
        fail(`gate ${gate.id} tracker ${tracker} is a pull request, not an issue`);
      if (issue.html_url !== tracker)
        fail(`gate ${gate.id} tracker canonical URL mismatch: ${tracker}`);
      if (!issue.labels?.some((label) => label.name === "tracking")) {
        fail(`gate ${gate.id} tracker ${tracker} must carry the tracking label`);
      }
      if (issue.state === "open") open += 1;
      trackers += 1;
    }
    if (gate.status === "open" && open === 0) {
      fail(`open gate ${gate.id} must retain at least one open tracking issue`);
    }
    if (gate.status === "complete" && open > 0) {
      fail(`complete gate ${gate.id} still has ${open} open tracking issue(s)`);
    }
  }
  console.log(`external gate trackers valid: ${trackers} issues across ${gates.length} gates`);
}

try {
  await verify();
} catch (error) {
  console.error(`external gate tracker verification failed: ${error.message}`);
  process.exit(1);
}
