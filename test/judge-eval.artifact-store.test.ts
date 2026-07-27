import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureArtifact, loadManifest, sha256Hex, type ModelManifest } from "@pharos/judge";

/**
 * The external artifact store: manifest is committed, blobs are fetched + sha256-verified against
 * it. We exercise the fetch/verify/cache logic with an INJECTED fetch (no 500MB download) so CI is
 * fast; the real Release fetch is exercised by the serving PR, which fails loudly if the maintainer
 * has not uploaded the blobs yet.
 */
describe("model artifact store", () => {
  it("committed manifest pins 3 served models with sha256 asset hashes", () => {
    const m = loadManifest();
    expect(Object.keys(m.models).sort()).toEqual([
      "finra-promissory",
      "funds-movement-intent",
      "phi-in-context",
    ]);
    for (const entry of Object.values(m.models)) {
      expect(entry.modelVersion).toMatch(/@[0-9a-f]{12}$/);
      expect(entry.assets.model.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.assets.tokenizer.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(["model.onnx", "model.int8.onnx"]).toContain(entry.served);
    }
    expect(m.release.baseUrl).toContain("releases/download");
  });

  const fakeManifest = (modelBytes: Uint8Array, tokBytes: Uint8Array): ModelManifest => ({
    schemaVersion: "1.0.0",
    release: {
      repo: "x/y",
      tag: "t",
      baseUrl: "https://github.com/x/y/releases/download/t",
    },
    models: {
      demo: {
        modelVersion: "demo@000000000000",
        kind: "onnx-transformer",
        baseModel: "b",
        maxLen: 128,
        temperature: 1,
        threshold: 0.5,
        served: "model.int8.onnx",
        assets: {
          model: { asset: "demo.model.int8.onnx", sha256: sha256Hex(modelBytes) },
          tokenizer: { asset: "demo.tokenizer.json", sha256: sha256Hex(tokBytes) },
        },
      },
    },
  });

  it("fetches, verifies, caches, and returns local paths on a hash match", async () => {
    const model = new Uint8Array([1, 2, 3, 4]);
    const tok = new Uint8Array([9, 9, 9]);
    const cacheDir = mkdtempSync(join(tmpdir(), "pharos-models-"));
    let fetches = 0;
    const fetchImpl = async (url: string) => {
      fetches++;
      return url.endsWith("tokenizer.json") ? tok : model;
    };
    const r = await ensureArtifact("demo", {
      manifest: fakeManifest(model, tok),
      cacheDir,
      fetchImpl,
    });
    expect(readFileSync(r.modelPath)).toEqual(Buffer.from(model));
    expect(readFileSync(r.tokenizerPath)).toEqual(Buffer.from(tok));
    expect(r.modelVersion).toBe("demo@000000000000");
    expect(fetches).toBe(2);

    // Second call hits the cache (no new fetches).
    await ensureArtifact("demo", { manifest: fakeManifest(model, tok), cacheDir, fetchImpl });
    expect(fetches).toBe(2);
  });

  it("throws LOUDLY on a sha256 mismatch (refuses to serve a wrong/tampered blob)", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "pharos-models-"));
    const manifest = fakeManifest(new Uint8Array([1, 2, 3, 4]), new Uint8Array([9]));
    // Serve DIFFERENT bytes than the manifest hash expects.
    const fetchImpl = async () => new Uint8Array([7, 7, 7, 7]);
    await expect(ensureArtifact("demo", { manifest, cacheDir, fetchImpl })).rejects.toThrow(
      /sha256 mismatch/,
    );
  });

  it("throws a clear error when the blob is not fetchable (not uploaded yet)", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "pharos-models-"));
    const manifest = fakeManifest(new Uint8Array([1]), new Uint8Array([2]));
    const fetchImpl = async () => {
      throw new Error("404");
    };
    await expect(ensureArtifact("demo", { manifest, cacheDir, fetchImpl })).rejects.toThrow(
      /uploaded the blobs to the Release/,
    );
  });

  it("rejects a path-traversal asset name and a bad repo (SSRF/traversal barrier)", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "pharos-models-"));
    const good = fakeManifest(new Uint8Array([1]), new Uint8Array([2]));
    const fetchImpl = async () => new Uint8Array([1]);

    const traversal: ModelManifest = JSON.parse(JSON.stringify(good));
    traversal.models.demo!.assets.model.asset = "../../etc/passwd";
    await expect(
      ensureArtifact("demo", { manifest: traversal, cacheDir, fetchImpl }),
    ).rejects.toThrow(/unsafe asset name/);

    // The host is a hardcoded constant; only validated repo/tag segments come from the manifest.
    const badRepo: ModelManifest = JSON.parse(JSON.stringify(good));
    badRepo.release.repo = "evil.com/../../x";
    await expect(
      ensureArtifact("demo", { manifest: badRepo, cacheDir, fetchImpl }),
    ).rejects.toThrow(/unsafe repo/);
  });

  it("throws on an unknown concern", async () => {
    await expect(
      ensureArtifact("nope", { manifest: fakeManifest(new Uint8Array([1]), new Uint8Array([2])) }),
    ).rejects.toThrow(/no manifest entry/);
  });
});
