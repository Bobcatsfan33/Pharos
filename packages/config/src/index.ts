import { z } from "zod";

/**
 * Validated platform configuration, loaded from the environment at startup.
 * Fail-fast: a missing or malformed value aborts boot rather than failing later
 * mid-request. This is the single source of truth for connection strings and the
 * deployment posture across all three deployment modes (SaaS, VPC, customer-hosted).
 */
const boolish = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === "boolean" ? v : v.toLowerCase() === "true"));

const OidcIssuerSchema = z
  .object({
    issuer: z.url(),
    audience: z.string().min(1),
    jwksUri: z.url().optional(),
    jwks: z
      .object({
        keys: z.array(z.object({ kty: z.string().min(1) }).catchall(z.unknown())).min(1),
      })
      .optional(),
    jwksTimeoutMs: z.coerce.number().int().min(100).max(30_000).default(5_000),
    jwksCooldownMs: z.coerce.number().int().min(0).max(300_000).default(30_000),
    jwksCacheMaxAgeMs: z.coerce.number().int().min(1_000).max(86_400_000).default(600_000),
    claims: z.object({
      tenant: z.string().min(1),
      roles: z.string().min(1),
      displayName: z.string().min(1).optional(),
    }),
  })
  .superRefine((issuer, ctx) => {
    if (Boolean(issuer.jwksUri) === Boolean(issuer.jwks)) {
      ctx.addIssue({
        code: "custom",
        path: ["jwksUri"],
        message: "configure exactly one of jwksUri or inline jwks",
      });
    }
  });

const ConfigSchema = z
  .object({
    env: z.enum(["local", "dev", "staging", "prod"]).default("local"),
    pg: z.object({ url: z.string().min(1) }),
    redis: z.object({ url: z.string().min(1) }),
    s3: z.object({
      endpoint: z.string().min(1),
      region: z.string().min(1),
      bucket: z.string().min(1),
      accessKey: z.string().min(1).optional(),
      secretKey: z.string().min(1).optional(),
      forcePathStyle: boolish.default(true),
      wormRetentionDays: z.coerce.number().int().positive().default(3650),
    }),
    kms: z.object({
      provider: z.enum(["local-kms", "aws-kms"]).default("local-kms"),
      keystoreDir: z.string().default(".pharos-keystore"),
      /** AWS region for aws-kms. Credentials come from the standard AWS provider chain. */
      awsRegion: z.string().default("us-east-1"),
      /** Optional endpoint override for a KMS emulator (dev/CI); omit for real AWS. */
      awsEndpoint: z.string().optional(),
      /**
       * Permit aws-kms to mint a CMK on first use for a tenant that has no signing key yet.
       * Defaults to **false**: an implicitly created key carries the AWS default key policy,
       * so Pharos binds to an operator-provisioned key unless this is explicitly enabled.
       * The refusal names the exact alias to provision.
       */
      awsAllowKeyCreation: boolish.default(false),
    }),
    tsa: z.object({
      /** Trusted-time authority: `local` (simulated, hermetic) or `rfc3161` (a real TSA). */
      provider: z.enum(["local", "rfc3161"]).default("local"),
      /** RFC 3161 TSA endpoint (rfc3161 only). Dev default FreeTSA; DigiCert/Sectigo in prod. */
      url: z.string().optional(),
      /**
       * Independently approved RFC 3161 leaf-certificate SHA-256 fingerprints. Multiple pins
       * permit overlap during a contracted TSA certificate rotation.
       */
      trustedCertSha256: z
        .array(z.string().regex(/^[a-fA-F0-9]{64}$/, "must be a 64-character SHA-256 hex value"))
        .default([]),
      /** Scheduled anchoring interval (ms). Default 1h. 0 disables the background scheduler. */
      intervalMs: z.coerce.number().int().min(0).default(3_600_000),
    }),
    judge: z.object({
      /** Linear is a measured development baseline; production must preload the ONNX judges. */
      provider: z.enum(["linear", "onnx"]).default("linear"),
      /** Content-addressed ONNX/tokenizer cache. Pre-stage this path for restricted networks. */
      modelDir: z.string().min(1).optional(),
      /** Version-pinned reference distributions and approved PSI thresholds. */
      driftProfilePath: z.string().min(1).optional(),
    }),
    api: z.object({
      port: z.coerce.number().int().positive().default(4000),
      verdictDeadlineMs: z.coerce.number().int().positive().default(800),
      /** Allowed CORS origins. Empty = same-origin only (deny cross-origin browser calls). */
      allowedOrigins: z.array(z.string()).default([]),
      /** Per-principal (tenant+subject) request budget per minute. */
      rateLimitPerMin: z.coerce.number().int().positive().default(600),
      /**
       * Per-tenant aggregate request budget per minute, applied in addition to the
       * per-principal budget. A tenant that mints many API keys would otherwise
       * multiply its effective ingest budget by the number of principals it holds.
       */
      rateLimitTenantPerMin: z.coerce.number().int().positive().default(6000),
      /**
       * Admission behavior when the rate-limit counter store is unreachable.
       * "closed" refuses the request (503); "open" admits it unmetered. Production
       * must be "closed" — an attacker who can degrade the cache must not thereby
       * remove the ingest limit.
       */
      rateLimitFailMode: z.enum(["closed", "open"]).default("closed"),
    }),
    /** Trusted OIDC issuers (Okta, Entra, ...). Optional; empty disables SSO bearer auth. */
    oidc: z.array(OidcIssuerSchema).default([]),
    /**
     * Platform-operator bootstrap credentials for tenant provisioning. The previous
     * credential permits a bounded overlap during rotation; both expiries are checked
     * on every request rather than only at process startup.
     */
    admin: z.object({
      token: z.string().optional(),
      tokenExpiresAt: z.string().datetime({ offset: true }).optional(),
      previousToken: z.string().optional(),
      previousTokenExpiresAt: z.string().datetime({ offset: true }).optional(),
    }),
  })
  .superRefine((config, ctx) => {
    if (Boolean(config.s3.accessKey) !== Boolean(config.s3.secretKey)) {
      ctx.addIssue({
        code: "custom",
        path: ["s3"],
        message: "S3 static credentials must provide both access key and secret key",
      });
    }
    if (Boolean(config.admin.previousToken) !== Boolean(config.admin.previousTokenExpiresAt)) {
      ctx.addIssue({
        code: "custom",
        path: ["admin", "previousToken"],
        message: "previous administrative token and its expiry must be configured together",
      });
    }
    if (config.env !== "prod") return;

    const seenIssuers = new Set<string>();
    for (const [index, issuer] of config.oidc.entries()) {
      if (seenIssuers.has(issuer.issuer)) {
        ctx.addIssue({
          code: "custom",
          path: ["oidc", index, "issuer"],
          message: "duplicate OIDC issuer",
        });
      }
      seenIssuers.add(issuer.issuer);
      if (!isHttpsUrl(issuer.issuer)) {
        ctx.addIssue({
          code: "custom",
          path: ["oidc", index, "issuer"],
          message: "production OIDC issuers must use HTTPS",
        });
      }
      if (!isHttpsUrl(issuer.jwksUri)) {
        ctx.addIssue({
          code: "custom",
          path: ["oidc", index, "jwksUri"],
          message: "production OIDC JWKS endpoints must use HTTPS",
        });
      }
      if (issuer.jwks) {
        ctx.addIssue({
          code: "custom",
          path: ["oidc", index, "jwks"],
          message: "production does not permit inline OIDC signing keys",
        });
      }
    }

    if (config.api.rateLimitFailMode !== "closed") {
      ctx.addIssue({
        code: "custom",
        path: ["api", "rateLimitFailMode"],
        message: "production requires a fail-closed rate limiter; admission cannot fail open",
      });
    }
    if (config.api.rateLimitTenantPerMin < config.api.rateLimitPerMin) {
      ctx.addIssue({
        code: "custom",
        path: ["api", "rateLimitTenantPerMin"],
        message: "tenant aggregate budget cannot be below the per-principal budget",
      });
    }
    if (config.kms.provider !== "aws-kms") {
      ctx.addIssue({
        code: "custom",
        path: ["kms", "provider"],
        message: "production requires aws-kms; local key files are not permitted",
      });
    }
    if (config.kms.awsEndpoint) {
      ctx.addIssue({
        code: "custom",
        path: ["kms", "awsEndpoint"],
        message: "production does not permit a KMS endpoint override",
      });
    }
    if (config.tsa.provider !== "rfc3161") {
      ctx.addIssue({
        code: "custom",
        path: ["tsa", "provider"],
        message: "production requires an RFC 3161 timestamp authority",
      });
    }
    if (!isHttpsUrl(config.tsa.url)) {
      ctx.addIssue({
        code: "custom",
        path: ["tsa", "url"],
        message: "production requires an HTTPS RFC 3161 endpoint",
      });
    }
    if (config.tsa.trustedCertSha256.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["tsa", "trustedCertSha256"],
        message: "production requires at least one approved TSA certificate SHA-256 fingerprint",
      });
    }
    if (config.tsa.intervalMs === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["tsa", "intervalMs"],
        message: "production anchoring cannot be disabled",
      });
    }
    if (config.judge.provider !== "onnx") {
      ctx.addIssue({
        code: "custom",
        path: ["judge", "provider"],
        message: "production requires ONNX transformer judges; linear judges are not permitted",
      });
    }
    if (!config.judge.modelDir) {
      ctx.addIssue({
        code: "custom",
        path: ["judge", "modelDir"],
        message: "production requires an explicit writable or pre-staged judge model cache",
      });
    }
    if (!config.judge.driftProfilePath) {
      ctx.addIssue({
        code: "custom",
        path: ["judge", "driftProfilePath"],
        message: "production requires an approved judge drift profile",
      });
    }
    if (!isHttpsUrl(config.s3.endpoint)) {
      ctx.addIssue({
        code: "custom",
        path: ["s3", "endpoint"],
        message: "production object storage must use HTTPS",
      });
    }
    if (isAwsS3Url(config.s3.endpoint) && (config.s3.accessKey || config.s3.secretKey)) {
      ctx.addIssue({
        code: "custom",
        path: ["s3", "accessKey"],
        message:
          "production AWS S3 must use the workload-identity/default credential chain, not static keys",
      });
    }
    if (!hasVerifiedPostgresTls(config.pg.url)) {
      ctx.addIssue({
        code: "custom",
        path: ["pg", "url"],
        message: "production PostgreSQL must set sslmode=verify-ca or sslmode=verify-full",
      });
    }
    if (!hasProtocol(config.redis.url, "rediss:")) {
      ctx.addIssue({
        code: "custom",
        path: ["redis", "url"],
        message: "production Redis must use rediss://",
      });
    }
    if (!config.admin.token || config.admin.token.trim().length < 32) {
      ctx.addIssue({
        code: "custom",
        path: ["admin", "token"],
        message: "production requires an administrative token of at least 32 characters",
      });
    }
    if (!config.admin.tokenExpiresAt) {
      ctx.addIssue({
        code: "custom",
        path: ["admin", "tokenExpiresAt"],
        message: "production administrative credentials require an explicit RFC 3339 expiry",
      });
    } else if (Date.parse(config.admin.tokenExpiresAt) <= Date.now()) {
      ctx.addIssue({
        code: "custom",
        path: ["admin", "tokenExpiresAt"],
        message: "production administrative credential is already expired",
      });
    }
    if (config.admin.previousToken && config.admin.previousToken.trim().length < 32) {
      ctx.addIssue({
        code: "custom",
        path: ["admin", "previousToken"],
        message: "previous administrative token must be at least 32 characters",
      });
    }
  });

export type PharosConfig = z.infer<typeof ConfigSchema>;

function isHttpsUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function hasProtocol(value: string, protocol: string): boolean {
  try {
    return new URL(value).protocol === protocol;
  } catch {
    return false;
  }
}

function hasVerifiedPostgresTls(value: string): boolean {
  try {
    const url = new URL(value);
    const sslMode = url.searchParams.get("sslmode")?.toLowerCase();
    return (
      (url.protocol === "postgres:" || url.protocol === "postgresql:") &&
      (sslMode === "verify-ca" || sslMode === "verify-full")
    );
  } catch {
    return false;
  }
}

function isAwsS3Url(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return (
      hostname === "s3.amazonaws.com" ||
      (hostname.startsWith("s3.") && hostname.endsWith(".amazonaws.com")) ||
      (hostname.includes(".s3.") && hostname.endsWith(".amazonaws.com"))
    );
  } catch {
    return false;
  }
}

function csv(value: string | undefined): string[] {
  return value
    ? value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
}

function safeJsonArray(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    throw new Error("PHAROS_OIDC_ISSUERS must be a JSON array of issuer configs");
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): PharosConfig {
  const parsed = ConfigSchema.safeParse({
    env: env.PHAROS_ENV,
    pg: { url: env.PHAROS_PG_URL },
    redis: { url: env.PHAROS_REDIS_URL },
    s3: {
      endpoint: env.PHAROS_S3_ENDPOINT,
      region: env.PHAROS_S3_REGION,
      bucket: env.PHAROS_S3_BUCKET,
      accessKey: env.PHAROS_S3_ACCESS_KEY,
      secretKey: env.PHAROS_S3_SECRET_KEY,
      forcePathStyle: env.PHAROS_S3_FORCE_PATH_STYLE,
      wormRetentionDays: env.PHAROS_S3_WORM_RETENTION_DAYS,
    },
    kms: {
      provider: env.PHAROS_KMS_PROVIDER,
      keystoreDir: env.PHAROS_KMS_KEYSTORE_DIR,
      awsRegion: env.PHAROS_KMS_AWS_REGION,
      awsEndpoint: env.PHAROS_KMS_AWS_ENDPOINT,
      awsAllowKeyCreation: env.PHAROS_KMS_AWS_ALLOW_KEY_CREATION,
    },
    tsa: {
      provider: env.PHAROS_TSA_PROVIDER,
      url: env.PHAROS_TSA_URL,
      trustedCertSha256: csv(env.PHAROS_TSA_CERT_SHA256),
      intervalMs: env.PHAROS_TSA_ANCHOR_INTERVAL_MS,
    },
    judge: {
      provider: env.PHAROS_JUDGE_PROVIDER,
      modelDir: env.PHAROS_JUDGE_MODEL_DIR,
      driftProfilePath: env.PHAROS_JUDGE_DRIFT_PROFILE_PATH,
    },
    api: {
      port: env.PHAROS_API_PORT,
      verdictDeadlineMs: env.PHAROS_VERDICT_DEADLINE_MS,
      allowedOrigins: csv(env.PHAROS_ALLOWED_ORIGINS),
      rateLimitPerMin: env.PHAROS_RATE_LIMIT_PER_MIN,
      rateLimitTenantPerMin: env.PHAROS_RATE_LIMIT_TENANT_PER_MIN,
      rateLimitFailMode: env.PHAROS_RATE_LIMIT_FAIL_MODE,
    },
    oidc: env.PHAROS_OIDC_ISSUERS ? safeJsonArray(env.PHAROS_OIDC_ISSUERS) : [],
    admin: {
      token: env.PHAROS_ADMIN_TOKEN,
      tokenExpiresAt: env.PHAROS_ADMIN_TOKEN_EXPIRES_AT,
      previousToken: env.PHAROS_ADMIN_PREVIOUS_TOKEN,
      previousTokenExpiresAt: env.PHAROS_ADMIN_PREVIOUS_TOKEN_EXPIRES_AT,
    },
  });
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Invalid Pharos configuration:\n${detail}\nSee .env.example for required variables.`,
    );
  }
  return parsed.data;
}
