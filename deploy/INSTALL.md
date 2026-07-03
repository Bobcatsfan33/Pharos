# Customer-hosted install (Pharos)

Pharos installs in your own VPC or datacenter with no outbound dependency at runtime
(airgap-tolerant). Judge inference is CPU-only — no GPU required. This guide installs Pharos
from documentation alone.

## Option A — Docker Compose (single host / pilot)

```bash
cp deploy/.env.prod.example .env.prod
# Edit .env.prod and set EVERY value — there are no default credentials:
#   PHAROS_PG_USER, PHAROS_PG_PASSWORD, PHAROS_PG_DB
#   PHAROS_REDIS_PASSWORD
#   PHAROS_S3_ACCESS_KEY, PHAROS_S3_SECRET_KEY
#   PHAROS_ADMIN_TOKEN  (the platform-operator bootstrap token)
docker compose -f deploy/docker-compose.prod.yml --env-file .env.prod up -d

# Verify
curl -sf http://localhost:4000/healthz
curl -s  http://localhost:4000/metrics | head
```

Provision your first tenant and bootstrap key:

```bash
curl -sXPOST http://localhost:4000/v1/admin/tenants \
  -H "x-pharos-admin: $PHAROS_ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"tenantId":"acme","displayName":"Acme"}'
# -> returns adminKey.plaintext (shown once)
```

## Option B — Kubernetes (multi-AZ, production)

```bash
# 1. Create the secret (connection strings + KMS config) — no values are baked into the chart.
kubectl create secret generic pharos-secrets \
  --from-literal=PHAROS_PG_URL=postgres://... \
  --from-literal=PHAROS_REDIS_URL=redis://... \
  --from-literal=PHAROS_S3_ENDPOINT=https://s3.amazonaws.com \
  --from-literal=PHAROS_S3_ACCESS_KEY=... \
  --from-literal=PHAROS_S3_SECRET_KEY=... \
  --from-literal=PHAROS_ADMIN_TOKEN=...

# 2. Install the chart (3 replicas across zones by default).
helm install pharos deploy/helm

# 3. Verify
kubectl rollout status deploy/pharos-api
kubectl port-forward svc/pharos-api 4000:80 & curl -sf localhost:4000/healthz
```

Use managed Postgres (multi-AZ RDS), Redis (ElastiCache), and S3 with Object Lock enabled in
production.

## Key management (read this before production)

Only `PHAROS_KMS_PROVIDER=local-kms` is implemented today — `aws-kms` is a configuration
placeholder and the API refuses to start with it. local-kms stores Ed25519 signing keys as
files under `PHAROS_KMS_KEYSTORE_DIR` (the TSA keystore is the sibling `<dir>-tsa`). Those
keys sign every evidence record, so:

* Persist the keystore on a durable volume (the prod compose file mounts `pharos_keys`;
  the provided Dockerfile defaults the dir to `/var/lib/pharos/keys/keystore`).
* Back the volume up; losing the keys breaks external verification of prior records.
* Restrict access to the volume — the key files are plaintext JSON (0600).

A managed-KMS provider is planned; until then treat the keystore volume as an HSM boundary.

## Upgrades & migrations

Schema migrations run automatically on boot (idempotent, tracked in `pharos_migrations`).
Roll forward by deploying a newer image; the API applies any new migrations before serving.

## Resilience

See [docs/operations.md](../docs/operations.md) for RPO/RTO, backup/restore, region-failover,
and alerting runbooks. The evidence chain survives a region failover with zero loss because
the authoritative stores (Postgres + WORM) are durable and shared across regions; the
recovered region re-verifies the chain on boot.
