#!/usr/bin/env node

const STABLE_TAG = /^refs\/tags\/v\d+\.\d+\.\d+$/;
const PRERELEASE_TAG = /^refs\/tags\/v\d+\.\d+\.\d+-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*$/;

export function classifyReleaseRef(eventName, ref) {
  if (eventName === "workflow_dispatch") {
    return { channel: "manual", publishSdks: true };
  }

  if (eventName !== "push") {
    throw new Error(`unsupported release event: ${eventName}`);
  }
  if (STABLE_TAG.test(ref)) {
    return { channel: "stable", publishSdks: true };
  }
  if (PRERELEASE_TAG.test(ref)) {
    return { channel: "prerelease-image", publishSdks: false };
  }

  throw new Error(
    `release tag must be vMAJOR.MINOR.PATCH or vMAJOR.MINOR.PATCH-prerelease: ${ref}`,
  );
}

if (process.argv[1]?.endsWith("classify-release-ref.mjs")) {
  try {
    process.stdout.write(JSON.stringify(classifyReleaseRef(process.argv[2], process.argv[3])));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
