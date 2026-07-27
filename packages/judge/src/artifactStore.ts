import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

/**
 * External artifact store for transformer-judge blobs (Sprint 6, tech-lead ruling).
 *
 * The ONNX + tokenizer blobs are GitHub Release assets (too large for git; LFS bandwidth is worse
 * on a public repo). Only the tiny manifest is committed. At load time we fetch each asset from the
 * Release and verify its sha256 against the manifest — the manifest is what `modelVersion()` pins,
 * so a tampered or wrong blob fails LOUDLY. Fetched blobs are cached locally by content hash.
 *
 * If the maintainer has not uploaded the assets yet, `ensureArtifact` throws a clear error — the
 * correct loud failure (a serving test fails rather than silently serving nothing).
 */
export interface AssetRef {
  asset: string;
  sha256: string;
}

export interface ModelManifestEntry {
  modelVersion: string;
  kind: string;
  baseModel: string;
  maxLen: number;
  temperature: number;
  threshold: number;
  served: string;
  assets: { model: AssetRef; tokenizer: AssetRef };
}

export interface ModelManifest {
  schemaVersion: string;
  release: { repo: string; tag: string; baseUrl: string };
  models: Record<string, ModelManifestEntry>;
}

const MANIFEST_PATH = fileURLToPath(new URL("../models/manifest.json", import.meta.url));

export function loadManifest(path: string = MANIFEST_PATH): ModelManifest {
  return JSON.parse(readFileSync(path, "utf8")) as ModelManifest;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Default on-disk cache for fetched blobs (override with PHAROS_JUDGE_MODEL_DIR). */
export function defaultCacheDir(): string {
  return process.env.PHAROS_JUDGE_MODEL_DIR ?? join(homedir(), ".cache", "pharos-judge-models");
}

export interface FetchedArtifact {
  concern: string;
  modelVersion: string;
  modelPath: string;
  tokenizerPath: string;
  temperature: number;
  threshold: number;
  maxLen: number;
}

export interface EnsureOptions {
  manifest?: ModelManifest;
  cacheDir?: string;
  /** Injectable fetch (tests / offline). Must resolve asset bytes for a URL. */
  fetchImpl?: (url: string) => Promise<Uint8Array>;
}

async function defaultFetch(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} -> HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

// The fetch destination host + scheme are HARDCODED constants — never derived from the manifest —
// so the outbound request's authority cannot be influenced by file data (SSRF barrier). Only
// path segments come from the manifest, and each is validated to a strict charset below.
const RELEASE_ORIGIN = "https://github.com";
const SAFE_ASSET = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const SAFE_TAG = /^[A-Za-z0-9._-]+$/;
const SAFE_DIGEST = /^[0-9a-f]{64}$/;

function validated(re: RegExp, value: string, what: string): string {
  const m = re.exec(value);
  if (!m) throw new Error(`unsafe ${what} in manifest: ${JSON.stringify(value)}`);
  return m[0]; // the returned value comes from the regex match, not the raw input (barrier)
}

/** Build the Release download URL from a constant origin + validated path segments only. */
function releaseUrl(repo: string, tag: string, safeName: string): string {
  const r = validated(SAFE_REPO, repo, "repo");
  const t = validated(SAFE_TAG, tag, "tag");
  return `${RELEASE_ORIGIN}/${r}/releases/download/${t}/${safeName}`;
}

/** Return a cached asset path, fetching + verifying from the Release if not already cached.
 *  `ext` is a fixed code constant, so the cache path is `<hex-digest>.<ext>` — no manifest string
 *  reaches the filesystem sink (path-injection barrier). */
async function ensureAsset(
  repo: string,
  tag: string,
  ref: AssetRef,
  ext: "onnx" | "json",
  cacheDir: string,
  fetchImpl: (url: string) => Promise<Uint8Array>,
): Promise<string> {
  const safeName = validated(SAFE_ASSET, ref.asset, "asset name");
  const digest = validated(SAFE_DIGEST, ref.sha256, "sha256");
  const url = releaseUrl(repo, tag, safeName);
  // Content-addressed cache path built only from the validated hex digest + a constant extension.
  const cached = join(cacheDir, `${digest}.${ext}`);
  if (existsSync(cached) && sha256Hex(readFileSync(cached)) === digest) return cached;

  let bytes: Uint8Array;
  try {
    bytes = await fetchImpl(url);
  } catch (err) {
    throw new Error(
      `Could not fetch judge artifact ${safeName} from ${url}: ${(err as Error).message}. ` +
        `Has the maintainer uploaded the blobs to the Release yet?`,
    );
  }
  const got = sha256Hex(bytes);
  if (got !== digest) {
    throw new Error(
      `sha256 mismatch for ${safeName}: manifest ${digest} != fetched ${got} (refusing to serve).`,
    );
  }
  mkdirSync(dirname(cached), { recursive: true });
  writeFileSync(cached, bytes);
  return cached;
}

/**
 * Ensure a concern's served ONNX + tokenizer are present and hash-verified, fetching from the
 * Release on a cache miss. Throws loudly on unknown concern, fetch failure, or hash mismatch.
 */
export async function ensureArtifact(
  concern: string,
  opts: EnsureOptions = {},
): Promise<FetchedArtifact> {
  const manifest = opts.manifest ?? loadManifest();
  const cacheDir = opts.cacheDir ?? defaultCacheDir();
  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  const entry = manifest.models[concern];
  if (!entry) throw new Error(`no manifest entry for judge concern "${concern}"`);

  const { repo, tag } = manifest.release;
  const [modelPath, tokenizerPath] = await Promise.all([
    ensureAsset(repo, tag, entry.assets.model, "onnx", cacheDir, fetchImpl),
    ensureAsset(repo, tag, entry.assets.tokenizer, "json", cacheDir, fetchImpl),
  ]);
  return {
    concern,
    modelVersion: entry.modelVersion,
    modelPath,
    tokenizerPath,
    temperature: entry.temperature,
    threshold: entry.threshold,
    maxLen: entry.maxLen,
  };
}
