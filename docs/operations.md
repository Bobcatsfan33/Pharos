# Operations: observability, resilience & runbooks (Sprint 8 — Granite)

## Observability

- **Metrics** — Prometheus exposition at `GET /metrics`
  ([`@pharos/observability`](../packages/observability/src/metrics.ts)):
  `pharos_verdicts_total{decision,tier}`, `pharos_records_sealed_total`,
  `pharos_escalations_total{queue}`, `pharos_verdict_latency_ms` (histogram),
  `pharos_errors_total`.
- **Tracing** — OTel-style spans across SDK → verdict → seal
  ([`tracing.ts`](../packages/observability/src/tracing.ts)); each span emits a structured
  JSON log line with trace/span ids for ingestion by an OTel collector.
- **Structured logs** — JSON lines; ship to your log pipeline.
- **Status page** — drive from `GET /healthz` (DB/Redis/WORM reachability) and the metrics
  above.

## Resilience (RPO / RTO)

| Component | Strategy | RPO | RTO |
|-----------|----------|-----|-----|
| Operational state (Postgres) | Multi-AZ managed instance + PITR backups | ≤ 5 min (PITR) | ≤ 15 min (failover) |
| Evidence chain (S3 WORM) | Cross-region replication, Object Lock | 0 (replicated, immutable) | minutes |
| Verdict cache (Redis) | Rebuildable; not authoritative | n/a | seconds |
| Signing keys (KMS) | Managed multi-region KMS | 0 | seconds |

**Region failover** is verified in `test/integration.granite.test.ts`: the active region is
torn down and a fresh region is brought up against the same durable stores; the recovered
region sees **zero evidence loss** (record count and chain head preserved) and **re-verifies
the chain green** on boot. Because the evidence chain lives in WORM + Postgres (not process
memory), failover never loses or rewrites evidence.

## Backup / restore

- Postgres: managed automated backups + PITR; restore-test quarterly.
- WORM: Object Lock prevents deletion before retention; cross-region replication for DR.
- The chain-integrity service re-verifies genesis-to-head after any restore.

## Alerting runbooks

| Alert | Condition | Action |
|-------|-----------|--------|
| Chain break | chain-integrity sweep reports a break | Page on-call; freeze exports; investigate the first broken sequence; do not redact under hold |
| Verdict latency p99 > budget | `pharos_verdict_latency_ms` p99 > 800ms | Check judge/registry load; scale API; inspect Tier-3 |
| SLA breach surge | `pharos_escalations_total` rising + review SLA dashboard breaches | Page review on-call; reassign queues |
| Error rate | `pharos_errors_total` rising | Inspect logs by route/trace id |

## Billing / metering

Usage is metered from the authoritative recorded-action count, so invoices reconcile to
recorded usage **exactly** (`test/integration.granite.test.ts`, `test/billing.test.ts`). See
the three-part model in [`@pharos/billing`](../packages/billing/src/index.ts).
