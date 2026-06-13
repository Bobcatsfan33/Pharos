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

const ConfigSchema = z.object({
  env: z.enum(["local", "dev", "staging", "prod"]).default("local"),
  pg: z.object({ url: z.string().min(1) }),
  redis: z.object({ url: z.string().min(1) }),
  s3: z.object({
    endpoint: z.string().min(1),
    region: z.string().min(1),
    bucket: z.string().min(1),
    accessKey: z.string().min(1),
    secretKey: z.string().min(1),
    forcePathStyle: boolish.default(true),
    wormRetentionDays: z.coerce.number().int().positive().default(3650),
  }),
  kms: z.object({
    provider: z.enum(["local-kms", "aws-kms"]).default("local-kms"),
    keystoreDir: z.string().default(".pharos-keystore"),
  }),
  api: z.object({
    port: z.coerce.number().int().positive().default(4000),
    verdictDeadlineMs: z.coerce.number().int().positive().default(800),
  }),
});

export type PharosConfig = z.infer<typeof ConfigSchema>;

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
    },
    api: {
      port: env.PHAROS_API_PORT,
      verdictDeadlineMs: env.PHAROS_VERDICT_DEADLINE_MS,
    },
  });
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid Pharos configuration:\n${detail}\nSee .env.example for required variables.`);
  }
  return parsed.data;
}
