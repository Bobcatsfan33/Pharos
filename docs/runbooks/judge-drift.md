# Judge drift monitoring and response

## Control objective

Detect material movement in each active judge's calibrated score distribution without retaining
prompts, action payloads, tenant IDs, or identities. Pharos uses population stability index (PSI)
over an independently approved, version-pinned reference distribution and a bounded rolling
window per process.

PSI is a detection signal, not proof that accuracy changed. Labels and a representative re-test
are required before approving a threshold change or model replacement.

## Establish the reference

1. Score a representative, authorized reference population with the exact ONNX artifacts and
   normalizer intended for production. Keep the source data in the approved evaluation boundary.
2. Export JSONL containing only `concern`, `judgeVersion`, and `probability`. The profile builder
   rejects any additional field to prevent copying prompts or customer metadata.
3. Generate a candidate:

   ```sh
   pnpm judges:drift-profile -- --input scores.jsonl > candidate-profile.json
   ```

4. Independently review corpus provenance, sample counts, model-version matches, ten-bin
   distribution, `minSamples`, rolling `windowSize`, and PSI thresholds. Default candidate
   thresholds (`warning=0.1`, `critical=0.25`) are starting points, not universal approvals.
5. Record approval and candidate SHA-256 in the change record. Create a dedicated ConfigMap:

   ```sh
   kubectl -n pharos create configmap pharos-judge-drift \
     --from-file=profile.json=candidate-profile.json \
     --dry-run=client -o yaml
   ```

6. Set `judgeDriftProfile.existingConfigMap=pharos-judge-drift`. Production configuration and Helm
   rendering fail closed when the profile is absent; API startup fails if any active model version
   is missing or mapped to the wrong concern.

## Alerts

Scrape `/metrics` and route these conditions to the model-risk and service owners:

```promql
max by (concern, model_version) (pharos_judge_drift_profile_ready) == 0
max by (concern, model_version) (pharos_judge_drift_status{status="critical"}) == 1
max by (concern, model_version) (pharos_judge_drift_status{status="warning"}) == 1
```

Alert on a missing profile immediately. Route `critical` at high severity after two scrape
intervals and `warning` as a model-risk ticket after the approved persistence interval. Because
each replica maintains a bounded local window, aggregate with `max`, not `avg`; averaging can hide
a shifted traffic partition.

## Triage and containment

1. Confirm the alert's concern, exact model version, sample count, PSI, deployment revision, and
   replica distribution. Do not inspect customer prompts unless a separately authorized incident
   procedure permits it.
2. Check for routing, customer-mix, language, action-type, normalization, tokenizer, threshold, and
   artifact changes. Verify artifact hashes against the committed manifest.
3. For `critical`, freeze model/threshold changes, notify the model-risk owner, and run the approved
   labeled representative/adversarial suite. If policy requires, force the affected concern to
   human escalation or roll back to the last independently approved full model-system release.
4. Do not "fix" drift by editing PSI thresholds. Threshold/profile changes require the same
   independent approval and change record as the original profile.
5. Close only after documenting root cause, impact window, labeled efficacy/calibration findings,
   disposition, and a successful alert/rollback exercise.

## Rotation

Generate and approve a new profile for every new model, tokenizer, temperature, decision threshold,
or normalizer version. Deploy the profile and artifacts in one reviewed release; Pharos verifies
the exact active model identities during startup. Retain prior signed profiles and approvals in the
assurance record for audit, but never configure an old profile for a new version.
