# Customer-hosted install (Pharos)

Pharos installs in your own VPC or datacenter. Judge inference is CPU-only — no GPU required.
Production requires controlled outbound HTTPS to the contracted RFC 3161 authority. A cold,
empty judge cache also fetches content-addressed assets from the pinned Pharos GitHub Release;
restricted networks should pre-stage the verified cache so model startup needs no GitHub egress.

## Production judge startup boundary

Production configuration requires `PHAROS_JUDGE_PROVIDER=onnx`. Before the API listener opens,
each replica reads or downloads all three transformer artifacts and tokenizers, verifies every
SHA-256 digest against `packages/judge/models/manifest.json`, builds every inference session, and
fails startup if the fleet is partial or misidentified. It never falls back to the linear
development baseline. Production also requires a version-pinned drift profile covering every
exact active model identity; see
[`docs/runbooks/judge-drift.md`](../docs/runbooks/judge-drift.md).

The default Compose named volume and Helm 2Gi `emptyDir` are writable caches. For restricted or
restart-sensitive Kubernetes deployments, download the assets from the manifest's pinned Release,
verify their release digests independently, store them under the manifest digest filenames
(`<sha256>.onnx` and `<sha256>.json`), and mount that directory with:

add `--set judgeModelCache.existingClaim=pharos-judge-models` to the production Helm command
below.

Use an RWX claim for multiple replicas, or one pre-staged claim per zone/replica through your
platform's volume provisioning pattern. The API re-verifies cached bytes on every startup, so
pre-staging improves availability without weakening artifact identity. The current transformer
release is still pre-release pending independent efficacy, calibration, reference-profile
approval, drift exercise, and production-latency gates in `docs/LIMITATIONS.md`.

## TLS termination is yours (#76)

Pharos listens on **plain HTTP** and does not terminate TLS in-process. Every deployment
must put a terminating front door in front of it, and the Helm chart will not render a
production release until you declare which one:

```bash
# Option 1 — render the reference Ingress (nginx): forced SSL redirect, TLS 1.3 floor,
# HSTS, and optional mTLS client-certificate verification.
--set ingress.enabled=true \
--set ingress.host=pharos.example.com \
--set ingress.tls.secretName=pharos-tls \
# add mTLS when callers are machine identities rather than browsers:
--set ingress.mtls.enabled=true \
--set ingress.mtls.clientCaSecret=pharos-client-ca

# Option 2 — a mesh / cloud LB / gateway this chart does not manage. Name it, so your
# runbook and this deployment agree on who owns the front door.
--set ingress.externalTerminator=istio-ingressgateway
```

Omitting both fails the render with *"production requires a declared TLS terminator"*.
TLS 1.2 is accepted only with the annotation `pharos.io/tls12-accepted-risk` naming who
accepted it.

**You own** certificate issuance and rotation, the serving private key, the client CA for
mTLS, and the network path between terminator and pod. Pharos cannot verify at runtime
that a terminator is in front of it — see `docs/LIMITATIONS.md` §7.

## Option A — Docker Compose (single host / pilot)

```bash
cp deploy/.env.prod.example .env.prod
# Edit .env.prod and set every placeholder. The production Compose file intentionally
# does not bundle stateful stores; point it at TLS-verifying managed dependencies,
# AWS KMS workload identity, a contracted TSA, and an immutable verified image digest.
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

The API image is built from a digest-pinned base, blocked on fixable
High/Critical findings, published to GHCR, and signed with
[cosign](https://docs.sigstore.dev/) keyless (Sigstore/OIDC) by
[`.github/workflows/image.yml`](../.github/workflows/image.yml). A
[syft](https://github.com/anchore/syft) SPDX SBOM and GitHub build provenance
are attached to the exact digest. **Verify the digest before you deploy.**

```bash
TAG=v0.1.0
IMAGE=ghcr.io/bobcatsfan33/pharos-api
DIGEST=sha256:<approved-release-digest>
SUBJECT="${IMAGE}@${DIGEST}"
IDENTITY="https://github.com/Bobcatsfan33/Pharos/.github/workflows/image.yml@refs/tags/${TAG}"

# 1. Verify the signature against the exact release ref.
cosign verify "$SUBJECT" \
  --certificate-identity "$IDENTITY" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com"

# 2. Verify + download the SBOM attestation (SPDX-JSON).
cosign verify-attestation "$SUBJECT" --type spdxjson \
  --certificate-identity "$IDENTITY" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
  | jq -r '.payload | @base64d | fromjson | .predicate' > sbom.spdx.json

# 3. Verify GitHub build provenance for the same registry subject.
gh attestation verify "oci://${SUBJECT}" --repo Bobcatsfan33/Pharos
```

A successful verification prints the matching entries and exits `0`. The
approved deployment record must allowlist `DIGEST`; a valid signature from this
workflow is necessary but does not authorize every version it built. See
[`docs/security/release-assurance.md`](../docs/security/release-assurance.md).
The Helm chart's `image.repository` already points at this GHCR path.

## Option B — Kubernetes (multi-AZ, production)

```bash
# 1. Create the secret (connection strings + KMS config) — no values are baked into the chart.
kubectl create secret generic pharos-secrets \
  --from-literal=PHAROS_PG_URL='postgres://...?sslmode=verify-full' \
  --from-literal=PHAROS_REDIS_URL=rediss://... \
  --from-literal=PHAROS_S3_ENDPOINT=https://s3.amazonaws.com \
  --from-literal=PHAROS_ADMIN_TOKEN=...

# 2. Create the independently approved, version-pinned drift ConfigMap.
kubectl -n pharos create configmap pharos-judge-drift \
  --from-file=profile.json=/approved/pharos/candidate-profile.json

# 3. Install the chart (3 replicas across zones by default). Production defaults
# use AWS KMS and RFC 3161; pin the image and independently approved TSA certificate.
helm install pharos deploy/helm \
  --set image.digest=sha256:<verified-digest> \
  --set-string serviceAccount.annotations.eks\\.amazonaws\\.com/role-arn=arn:aws:iam::<account>:role/pharos \
  --set config.kmsAwsRegion=us-east-1 \
  --set config.tsaUrl=https://<your-tsa>/tsr \
  --set config.tsaCertSha256=<approved-64-character-leaf-certificate-sha256> \
  --set judgeDriftProfile.existingConfigMap=pharos-judge-drift

# 4. Verify
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
- `PHAROS_GATEWAY_HOLD_ACTIVE_KEY_ID`: the identifier used for new ciphertext; and
- `PHAROS_GATEWAY_HOLD_KEYS_B64`: a JSON object mapping retained key identifiers to
  canonical-base64 secrets of at least 32 random bytes each.

Do not reuse `pharos-secrets`: doing so gives the gateway unrelated API credentials. Copy
[`helm/examples/gateway-production.values.yaml`](helm/examples/gateway-production.values.yaml),
replace its example target and selectors, and install:

```bash
helm upgrade --install pharos deploy/helm \
  --namespace pharos \
  --values /path/to/gateway-production.values.yaml \
  --set image.digest=sha256:<verified-digest> \
  --set config.tsaUrl=https://<your-tsa>/tsr \
  --set config.tsaCertSha256=<approved-64-character-leaf-certificate-sha256>

kubectl rollout status deploy/pharos-gateway
kubectl get hpa,pdb,networkpolicy -l app.kubernetes.io/component=gateway
```

Production rendering fails closed unless the caller and both outbound dependencies have
explicit policy selectors/CIDRs. Standard Kubernetes NetworkPolicy cannot allow an FQDN:
for managed endpoints with changing addresses, use the cluster CNI's audited FQDN policy
and keep the portable chart policy aligned. The target must persist and honor
`Idempotency-Key` before you claim exactly-once side effects. Configure
`gateway.idempotencyProbePath` to a safe, no-op endpoint backed by that same durable
idempotency store. Every production gateway runs the two-delivery conformance protocol
before it starts serving traffic and fails closed if the upstream cannot prove one
execution and one stable result.

Keep the key ring in a versioned secret manager and back it up under dual control. Rotation
is an expand → activate → re-encrypt → contract procedure; never remove an old key merely
because a new one is active. Follow
[`docs/runbooks/gateway-held-key-rotation.md`](../docs/runbooks/gateway-held-key-rotation.md).

## Key management (read this before production)

AWS KMS is the production default and uses asymmetric P-256 keys whose private material never
leaves KMS. Configure the region through `config.kmsAwsRegion` and use workload identity
(for example, IRSA) rather than static AWS credentials. The same identity supplies S3 credentials
through the AWS SDK default chain; do not add `PHAROS_S3_ACCESS_KEY` or
`PHAROS_S3_SECRET_KEY` when the production endpoint is AWS S3. Paired static credentials remain
supported only outside the production posture.

### Provisioning signing keys

Pharos uses **one KMS key per tenant per key version**. It locates them by a derived alias, and
that alias is the operator-facing identifier:

```
alias/<aliasPrefix>/<base64url(keyName)>/v<version>
```

- `aliasPrefix` is `pharos` for the evidence signing keyset and `pharos-tsa` for the simulated
  (`local`) TSA keyset, so the two are isolated.
- `keyName` is `tenant:<tenantId>` (`TenantStore.kmsKeyName`), base64url-encoded because KMS
  alias names disallow `:`.
- `version` starts at `1` and increments on rotation. Old versions keep their alias and stay
  enabled for verification — records embed the keyId that signed them.

So tenant `acme` resolves to `alias/pharos/dGVuYW50OmFjbWU/v1`. Derive it with:

```bash
printf 'alias/pharos/%s/v1\n' "$(printf 'tenant:acme' | basenc --base64url | tr -d '=')"
```

**Provision the key yourself.** Create a customer-managed CMK, attach a key policy you control,
and alias it at the derived name:

```bash
KEY_ID=$(aws kms create-key \
  --key-spec ECC_NIST_P256 --key-usage SIGN_VERIFY \
  --description 'Pharos evidence signing — tenant acme' \
  --policy file://pharos-key-policy.json \
  --query KeyMetadata.KeyId --output text)

aws kms create-alias --alias-name alias/pharos/dGVuYW50OmFjbWU/v1 --target-key-id "$KEY_ID"
```

The key policy should grant the Pharos workload identity exactly `kms:Sign` and
`kms:GetPublicKey` — Pharos never needs `kms:Decrypt`, `kms:ScheduleKeyDeletion`, or
`kms:PutKeyPolicy` — and should keep key administration with your own principals.

**Implicit creation is off by default.** If no key exists at the derived alias, Pharos fails
closed and the error names both the alias to provision and the opt-in flag. Setting
`PHAROS_KMS_AWS_ALLOW_KEY_CREATION=true` lets Pharos mint the CMK itself, but that key is created
under the **AWS default key policy**, which grants the account root full control and does not
express your intended separation of duties. Enabling it is appropriate for development and
evaluation; provision the key yourself for production. This flag gates only first-use creation —
`rotate()` and the migration helper are explicit operator actions and are unaffected.

`local-kms` is intended for development and stores Ed25519 signing keys as files under
`PHAROS_KMS_KEYSTORE_DIR` (the TSA keystore is the sibling `<dir>-tsa`). If it is selected,
the chart requires `config.localKms.existingClaim`; it will not place signing keys in an
ephemeral volume. Those keys sign every evidence record, so development and migration
environments must persist, back up, and restrict the keystore. The production Compose file does
not mount local key storage.

Do not describe a local filesystem keystore as an HSM boundary.

## Trusted timestamp authority

Obtain the RFC 3161 leaf-certificate SHA-256 fingerprint from the contracted TSA or enterprise
trust office through a channel independent of the API endpoint and evidence bundles. Configure it
as `PHAROS_TSA_CERT_SHA256` (or `config.tsaCertSha256`). During planned rotation, deploy the old
and new fingerprints as a comma-separated overlap set, confirm new tokens use the new signer, and
only then remove the retired pin. A mismatched pin, unavailable TSA, malformed response, invalid
CMS signature, weak digest, missing timestamping EKU, or certificate outside its validity window
fails anchoring closed; Pharos never stores an unverified token. See
[`docs/runbooks/tsa-trust-rotation.md`](../docs/runbooks/tsa-trust-rotation.md).

## Upgrades & migrations

Schema migrations run automatically on boot (idempotent, tracked in `pharos_migrations`).
Roll forward by deploying a newer image; the API applies any new migrations before serving.

## Resilience

See [docs/operations.md](../docs/operations.md) for RPO/RTO, backup/restore, region-failover,
and alerting runbooks. The evidence chain survives a region failover with zero loss because
the authoritative stores (Postgres + WORM) are durable and shared across regions; the
recovered region re-verifies the chain on boot.
