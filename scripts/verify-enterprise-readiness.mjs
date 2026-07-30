#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const selected = path.resolve(process.argv[2] ?? path.join(root, "docs/enterprise-readiness.json"));
const requiredControls = new Set([
  "GOV-01",
  "SDLC-01",
  "APPSEC-01",
  "SUPPLY-01",
  "IAM-01",
  "CRYPTO-01",
  "DATA-01",
  "RES-01",
  "OBS-01",
  "IR-01",
  "VM-01",
  "AIRISK-01",
]);
const requiredFrameworks = new Set([
  "nist-ssdf-1.1",
  "slsa-1.2",
  "owasp-asvs-5.0.0",
  "csa-ccm-caiq-4.1",
  "nist-ai-rmf-1.0",
  "csa-ai-caiq-1.0.2",
]);

function fail(message) {
  throw new Error(message);
}

function objectValue(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function arrayValue(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value;
}

function textValue(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${label} must be a non-empty string`);
  }
  return value;
}

function unique(values, label) {
  if (new Set(values).size !== values.length) fail(`${label} contains duplicates`);
}

function exactSet(values, expected, label) {
  if (values.length !== expected.size || values.some((value) => !expected.has(value))) {
    fail(`${label} must equal ${JSON.stringify([...expected].sort())}`);
  }
}

function evidencePath(value, label) {
  const relative = textValue(value, label);
  if (path.isAbsolute(relative) || relative.split("/").includes("..") || relative.includes("\\")) {
    fail(`${label} must be a repository-relative POSIX path without '..'`);
  }
  const candidate = path.join(root, relative);
  const stat = fs.lstatSync(candidate);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail(`${label} must name a regular, non-symlink repository file: ${relative}`);
  }
  return relative;
}

function isoDate(value, label) {
  const text = textValue(value, label);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) {
    fail(`${label} must be an ISO-8601 date`);
  }
  return text;
}

function verify() {
  const document = objectValue(JSON.parse(fs.readFileSync(selected, "utf8")), "manifest");
  if (document.schemaVersion !== 1) fail("schemaVersion must equal 1");
  textValue(document.product, "product");
  textValue(document.repository, "repository");

  const assessment = objectValue(document.assessment, "assessment");
  const asOf = isoDate(assessment.asOf, "assessment.asOf");
  const reviewBy = isoDate(assessment.reviewBy, "assessment.reviewBy");
  if (reviewBy < asOf) fail("assessment.reviewBy must not precede assessment.asOf");
  const today = new Date().toISOString().slice(0, 10);
  if (today > reviewBy) fail(`enterprise readiness evidence expired on ${reviewBy}`);
  if (!["not-approved", "approved"].includes(assessment.deploymentDecision)) {
    fail("assessment.deploymentDecision must be not-approved or approved");
  }
  if (typeof assessment.softwareReleaseCandidate !== "boolean") {
    fail("assessment.softwareReleaseCandidate must be boolean");
  }
  textValue(assessment.decisionReason, "assessment.decisionReason");

  const frameworks = arrayValue(document.frameworks, "frameworks").map((item, index) =>
    objectValue(item, `frameworks[${index}]`),
  );
  const frameworkIds = frameworks.map((item) => textValue(item.id, "framework.id"));
  unique(frameworkIds, "framework ids");
  exactSet(frameworkIds, requiredFrameworks, "framework ids");
  for (const framework of frameworks) {
    textValue(framework.name, `framework ${framework.id}.name`);
    textValue(framework.version, `framework ${framework.id}.version`);
    if (!textValue(framework.url, `framework ${framework.id}.url`).startsWith("https://")) {
      fail(`framework ${framework.id}.url must use HTTPS`);
    }
  }

  const controls = arrayValue(document.controls, "controls").map((item, index) =>
    objectValue(item, `controls[${index}]`),
  );
  const controlIds = controls.map((item) => textValue(item.id, "control.id"));
  unique(controlIds, "control ids");
  exactSet(controlIds, requiredControls, "control ids");
  let incompleteControls = 0;
  for (const control of controls) {
    textValue(control.title, `control ${control.id}.title`);
    if (!["implemented", "partial", "not-applicable"].includes(control.status)) {
      fail(`control ${control.id}.status is invalid`);
    }
    const mapped = arrayValue(control.frameworks, `control ${control.id}.frameworks`).map((item) =>
      textValue(item, `control ${control.id}.frameworks`),
    );
    unique(mapped, `control ${control.id}.frameworks`);
    if (mapped.length === 0 || mapped.some((item) => !requiredFrameworks.has(item))) {
      fail(`control ${control.id} must map only to declared frameworks`);
    }
    const evidence = arrayValue(control.evidence, `control ${control.id}.evidence`).map((item) =>
      evidencePath(item, `control ${control.id}.evidence`),
    );
    unique(evidence, `control ${control.id}.evidence`);
    const gaps = arrayValue(control.gaps, `control ${control.id}.gaps`).map((item) =>
      textValue(item, `control ${control.id}.gaps`),
    );
    if (["implemented", "partial"].includes(control.status) && evidence.length === 0) {
      fail(`control ${control.id} requires evidence`);
    }
    if (control.status === "implemented" && gaps.length > 0) {
      fail(`implemented control ${control.id} cannot contain gaps`);
    }
    if (control.status === "partial" && gaps.length === 0) {
      fail(`partial control ${control.id} must name its gaps`);
    }
    if (control.status === "partial") incompleteControls += 1;
  }

  const gates = arrayValue(document.externalGates, "externalGates").map((item, index) =>
    objectValue(item, `externalGates[${index}]`),
  );
  if (gates.length === 0) fail("externalGates must not be empty");
  const gateIds = gates.map((item) => textValue(item.id, "external gate id"));
  unique(gateIds, "external gate ids");
  let openBlocking = 0;
  for (const gate of gates) {
    textValue(gate.title, `gate ${gate.id}.title`);
    if (!["open", "complete"].includes(gate.status)) fail(`gate ${gate.id}.status is invalid`);
    if (typeof gate.blocking !== "boolean") fail(`gate ${gate.id}.blocking must be boolean`);
    textValue(gate.ownerRole, `gate ${gate.id}.ownerRole`);
    textValue(gate.acceptanceCriteria, `gate ${gate.id}.acceptanceCriteria`);
    const evidence = arrayValue(gate.evidence, `gate ${gate.id}.evidence`).map((item) =>
      evidencePath(item, `gate ${gate.id}.evidence`),
    );
    unique(evidence, `gate ${gate.id}.evidence`);
    if (gate.status === "complete" && evidence.length === 0) {
      fail(`complete gate ${gate.id} requires retained evidence`);
    }
    if (gate.status === "open" && gate.blocking) openBlocking += 1;
  }

  if (assessment.deploymentDecision === "approved" && (openBlocking || incompleteControls)) {
    fail("deploymentDecision cannot be approved while controls or blocking gates remain open");
  }
  if (openBlocking && assessment.deploymentDecision !== "not-approved") {
    fail("open blocking gates require deploymentDecision=not-approved");
  }
  console.log(
    `enterprise readiness manifest valid: ${controls.length} controls, ${openBlocking} open blocking gates, decision=${assessment.deploymentDecision}, reviewBy=${reviewBy}`,
  );
}

try {
  if (process.argv.length > 3) fail("usage: verify-enterprise-readiness.mjs [manifest.json]");
  verify();
} catch (error) {
  console.error(`enterprise readiness verification failed: ${error.message}`);
  process.exit(1);
}
