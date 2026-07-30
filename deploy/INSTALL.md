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

## Verifying the signed image

The API image is published to GHCR and signed with [cosign](https://docs.sigstore.dev/)
keyless (Sigstore/OIDC) by [`.github/workflows/image.yml`](../.github/workflows/image.yml),
with a [syft](https://github.com/anchore/syft) SBOM (SPDX-JSON) attached as an attestation.
**Verify before you deploy.**

```bash
IMAGE=ghcr.io/bobcatsfan33/pharos-api:0.1.0

# 1. Verify the signature. The identity is the release workflow; the issuer is GitHub's OIDC.
cosign verify "$IMAGE" \
  --certificate-identity-regexp "^https://github.com/Bobcatsfan33/Pharos/.github/workflows/image.yml@.*$" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com"

# 2. Verify + download the SBOM attestation (SPDX-JSON).
cosign verify-attestation "$IMAGE" --type spdxjson \
  --certificate-identity-regexp "^https://github.com/Bobcatsfan33/Pharos/.github/workflows/image.yml@.*$" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
  | jq -r '.payload | @base64d | fromjson | .predicate' > sbom.spdx.json
```

A successful `cosign verify` prints the verified signature entries and exits `0`. Pin by
digest (`ghcr.io/bobcatsfan33/pharos-api@sha256:...`) in production. The Helm chart's
`image.repository` already points at this GHCR path.

## Option B — Kubernetes (multi-AZ, production)

```bash
# 1. Create the secret (connection strings + KMS config) — no values are baked into the chart.
kubectl create secret generic pharos-secrets \
  --from-literal=PHAROS_PG_URL='postgres://...?sslmode=verify-full' \
  --from-literal=PHAROS_REDIS_URL=rediss://... \
  --from-literal=PHAROS_S3_ENDPOINT=https://s3.amazonaws.com \
  --from-literal=PHAROS_ADMIN_TOKEN=...

# 2. Install the chart (3 replicas across zones by default). Production defaults
# use AWS KMS and RFC 3161; pin the verified image digest and provide your TSA.
helm install pharos deploy/helm \
  --set image.digest=sha256:<verified-digest> \
  --set-string serviceAccount.annotations.eks\\.amazonaws\\.com/role-arn=arn:aws:iam::<account>:role/pharos \
  --set config.kmsAwsRegion=us-east-1 \
  --set config.tsaUrl=https://<your-tsa>/tsr

# 3. Verify
kubectl rollout status deploy/pharos-api
kubectl port-forward svc/pharos-api 4000:80 & curl -sf localhost:4000/healthz
```

Use managed Postgres (multi-AZ RDS), Redis (ElastiCache), and S3 with Object Lock enabled in
production.

### Deploying the zero-code gateway

The gateway is a separate, horizontally scalable workload and is disabled by default. It
uses the same signed runtime image but a separate ServiceAccount and a least-privilege
Secret. Create `pharos-gateway-secrets` through your secret-manager controller (External
Secrets, Secrets Store CSI, or an equivalent approved by your platform team) with exactly:

- `PHAROS_API_KEY`: tenant-scoped key with only the action/review permissions the gateway
  needs;
- `PHAROS_PG_URL`: TLS-verifying Postgres connection for durable held requests; and
- `PHAROS_GATEWAY_HOLD_MASTER_KEY_B64`: at least 32 random bytes, canonical base64.

Do not reuse `pharos-secrets`: doing so gives the gateway unrelated API credentials. Copy
[`helm/examples/gateway-production.values.yaml`](helm/examples/gateway-production.values.yaml),
replace its example target and selectors, and install:

```bash
helm upgrade --install pharos deploy/helm \
  --namespace pharos \
  --values /path/to/gateway-production.values.yaml \
  --set image.digest=sha256:<verified-digest> \
  --set config.tsaUrl=https://<your-tsa>/tsr

kubectl rollout status deploy/pharos-gateway
kubectl get hpa,pdb,networkpolicy -l app.kubernetes.io/component=gateway
```

Production rendering fails closed unless the caller and both outbound dependencies have
explicit policy selectors/CIDRs. Standard Kubernetes NetworkPolicy cannot allow an FQDN:
for managed endpoints with changing addresses, use the cluster CNI's audited FQDN policy
and keep the portable chart policy aligned. The target must persist and honor
`Idempotency-Key` before you claim exactly-once side effects.

The held-request master key currently has no online key-ring migration. Keep it in a
versioned secret manager, back it up under dual control, and do not replace it while held
requests exist; see `docs/LIMITATIONS.md`. Native online rotation remains a release blocker
for unattended long-lived gateway deployments.

## Key management (read this before production)

AWS KMS is the production default and uses asymmetric P-256 keys whose private material never
leaves KMS. Configure the region through `config.kmsAwsRegion` and use workload identity
(for example, IRSA) rather than static AWS credentials. The same identity supplies S3 credentials
through the AWS SDK default chain; do not add `PHAROS_S3_ACCESS_KEY` or
`PHAROS_S3_SECRET_KEY` when the production endpoint is AWS S3. Paired static credentials remain
supported for the self-hosted MinIO installation.

`local-kms` is intended for development and stores Ed25519 signing keys as files under
`PHAROS_KMS_KEYSTORE_DIR` (the TSA keystore is the sibling `<dir>-tsa`). If it is selected,
the chart requires `config.localKms.existingClaim`; it will not place signing keys in an
ephemeral volume. Those keys sign every evidence record, so:

* Persist the keystore on a durable volume (the prod compose file mounts `pharos_keys`; the
  provided Dockerfile defaults the dir to `/var/lib/pharos/keys/keystore`).
* Back the volume up; losing the keys breaks external verification of prior records.
* Restrict access to the volume — the key files are plaintext JSON (0600).

Do not describe a local filesystem keystore as an HSM boundary.

## Upgrades & migrations

Schema migrations run automatically on boot (idempotent, tracked in `pharos_migrations`).
Roll forward by deploying a newer image; the API applies any new migrations before serving.

## Resilience

See [docs/operations.md](../docs/operations.md) for RPO/RTO, backup/restore, region-failover,
and alerting runbooks. The evidence chain survives a region failover with zero loss because
the authoritative stores (Postgres + WORM) are durable and shared across regions; the
recovered region re-verifies the chain on boot.
