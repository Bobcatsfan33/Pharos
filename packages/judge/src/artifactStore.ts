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

// Asset names come from the (committed, but still validated) manifest. Constrain them to a strict
// charset so they can never traverse the cache directory or inject into the fetch URL.
const SAFE_ASSET = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// Release downloads originate from GitHub; pin the host so a bad manifest can't point the fetch at
// an arbitrary server (SSRF barrier). Redirects to objects.githubusercontent.com are followed by fetch.
const ALLOWED_HOSTS = new Set(["github.com", "objects.githubusercontent.com"]);

/** Validate + build the asset URL. Throws on path-traversal names, non-https, or non-GitHub hosts. */
function safeAssetUrl(baseUrl: string, asset: string): string {
  if (!SAFE_ASSET.test(asset))
    throw new Error(`unsafe artifact asset name: ${JSON.stringify(asset)}`);
  const url = new URL(`${baseUrl.replace(/\/$/, "")}/${asset}`);
  if (url.protocol !== "https:") throw new Error(`artifact baseUrl must be https: ${baseUrl}`);
  if (!ALLOWED_HOSTS.has(url.hostname))
    throw new Error(`artifact host not allowed: ${url.hostname}`);
  return url.toString();
}

/** Return a cached asset path, fetching + verifying from the Release if not already cached. */
async function ensureAsset(
  baseUrl: string,
  ref: AssetRef,
  cacheDir: string,
  fetchImpl: (url: string) => Promise<Uint8Array>,
): Promise<string> {
  // Validate the asset name + URL BEFORE it touches the filesystem or the network (SSRF /
  // path-traversal barrier); the sha256 also constrains the cache filename to a safe hex prefix.
  const url = safeAssetUrl(baseUrl, ref.asset);
  if (!/^[0-9a-f]{64}$/.test(ref.sha256))
    throw new Error(`invalid sha256 in manifest for ${ref.asset}`);
  // Cache by content hash so a manifest bump never serves a stale blob.
  const cached = join(cacheDir, `${ref.sha256}-${ref.asset}`);
  if (existsSync(cached) && sha256Hex(readFileSync(cached)) === ref.sha256) return cached;

  let bytes: Uint8Array;
  try {
    bytes = await fetchImpl(url);
  } catch (err) {
    throw new Error(
      `Could not fetch judge artifact ${ref.asset} from ${url}: ${(err as Error).message}. ` +
        `Has the maintainer uploaded the blobs to the Release yet?`,
    );
  }
  const got = sha256Hex(bytes);
  if (got !== ref.sha256) {
    throw new Error(
      `sha256 mismatch for ${ref.asset}: manifest ${ref.sha256} != fetched ${got} (refusing to serve).`,
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

  const [modelPath, tokenizerPath] = await Promise.all([
    ensureAsset(manifest.release.baseUrl, entry.assets.model, cacheDir, fetchImpl),
    ensureAsset(manifest.release.baseUrl, entry.assets.tokenizer, cacheDir, fetchImpl),
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
