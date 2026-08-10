import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const classifier = fileURLToPath(new URL("../scripts/classify-release-ref.mjs", import.meta.url));

function classify(eventName: string, ref: string) {
  return JSON.parse(
    execFileSync(process.execPath, [classifier, eventName, ref], { encoding: "utf8" }),
  ) as { channel: string; publishSdks: boolean };
}

describe("release ref classification", () => {
  it("publishes SDKs for an exact stable tag", () => {
    expect(classify("push", "refs/tags/v0.3.0")).toEqual({
      channel: "stable",
      publishSdks: true,
    });
  });

  it("publishes only the assessment image for a prerelease tag", () => {
    expect(classify("push", "refs/tags/v0.3.0-rc.1")).toEqual({
      channel: "prerelease-image",
      publishSdks: false,
    });
  });

  it("preserves explicit manual SDK publication", () => {
    expect(classify("workflow_dispatch", "refs/heads/main")).toEqual({
      channel: "manual",
      publishSdks: true,
    });
  });

  it.each(["refs/tags/vnext", "refs/tags/v0.3", "refs/heads/main"])(
    "rejects an invalid pushed release ref: %s",
    (ref) => {
      const result = spawnSync(process.execPath, [classifier, "push", ref], {
        encoding: "utf8",
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("release tag must be");
    },
  );
});
