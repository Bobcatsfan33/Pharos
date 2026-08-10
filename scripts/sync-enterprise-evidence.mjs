#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "prettier";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "docs/enterprise-readiness.json");
const document = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

function collectEvidence() {
  const paths = new Set();
  for (const control of document.controls ?? []) {
    for (const evidence of control.evidence ?? []) paths.add(evidence);
  }
  for (const gate of document.externalGates ?? []) {
    paths.add(gate.handoff);
    for (const evidence of gate.evidence ?? []) paths.add(evidence);
  }
  if (document.assessment?.deploymentDecision === "approved") {
    paths.add(document.assessment?.approval?.decisionRecord);
  }
  return [...paths].sort();
}

function hashEvidence(relative) {
  if (
    typeof relative !== "string" ||
    relative === "" ||
    path.isAbsolute(relative) ||
    relative.split("/").includes("..") ||
    relative.includes("\\")
  ) {
    throw new Error(`unsafe evidence path: ${String(relative)}`);
  }
  const candidate = path.join(root, relative);
  const descriptor = fs.openSync(candidate, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    if (!fs.fstatSync(descriptor).isFile()) {
      throw new Error(`evidence must be a regular non-symlink file: ${relative}`);
    }
    return {
      path: relative,
      sha256: crypto.createHash("sha256").update(fs.readFileSync(descriptor)).digest("hex"),
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

document.evidenceSnapshot = {
  algorithm: "sha256",
  generatedAt: new Date().toISOString().slice(0, 10),
  files: collectEvidence().map(hashEvidence),
};
fs.writeFileSync(
  manifestPath,
  await format(JSON.stringify(document), { parser: "json", printWidth: 100 }),
);
console.log(`snapshotted ${document.evidenceSnapshot.files.length} enterprise evidence files`);
