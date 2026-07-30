# Gateway held-request key rotation

This runbook rotates the AES-256-GCM master keys used for gateway continuations without
draining the gateway. Ciphertext is tenant-bound and records its key identifier. The
rotation job locks bounded batches of pending rows and skips deliveries in progress.

## Preconditions

- Export and retain the current key ring from the approved secret manager under dual
  control.
- Inventory every Pharos tenant served by this gateway deployment.
- Confirm the database backup/PITR policy and alerting are healthy.
- Generate a new random key of at least 32 bytes in the approved secret manager. Never put
  plaintext key material in source control, a Helm values file, or command history.

`PHAROS_GATEWAY_HOLD_KEYS_B64` is a JSON object whose keys match
`[A-Za-z0-9][A-Za-z0-9._-]{0,63}` and whose values are canonical base64. The ring supports
up to 16 retained versions.

## Routine rotation

1. **Expand.** Add the new id and secret to `PHAROS_GATEWAY_HOLD_KEYS_B64`, leaving
   `PHAROS_GATEWAY_HOLD_ACTIVE_KEY_ID` on the old id. Roll all gateway replicas and verify
   readiness. This proves every replica can read both versions before any new-version
   ciphertext exists.
2. **Activate.** Change `PHAROS_GATEWAY_HOLD_ACTIVE_KEY_ID` to the new id and roll all
   replicas again. New held requests now use the new key; old requests remain readable.
3. **Re-encrypt.** From an approved operator job with the same key-ring secret and database
   identity, run the following once for every tenant:

   ```bash
   pnpm gateway:rotate-held-keys -- <tenant-id>
   ```

   The command emits JSON start/finish records with counts by key id and never logs key
   material. Exit `0` means no old-key rows remain for that tenant. Exit `2` means a
   delivery was in progress; wait at least one lease interval and rerun.
4. **Verify.** Preserve the successful per-tenant job logs as change evidence. Exercise one
   hold/review/resume transaction through the gateway and confirm health/readiness.
5. **Contract.** Only after every tenant reports zero old-key rows, remove the old key from
   the secret manager and roll all replicas. Keep the retired secret in the organization’s
   escrow/retention system according to policy.

The legacy `PHAROS_GATEWAY_HOLD_MASTER_KEY_B64` spelling remains readable for upgrades. To
leave legacy mode, first deploy a key ring containing the same secret under id `legacy`
with `legacy` active, then continue at step 1.

## Compromise rotation

Activate a new key immediately, restrict database access, and follow the same per-tenant
re-encryption procedure. Retain the suspected key in the runtime ring only as long as
needed to recover pending ciphertext. Removing it early intentionally makes those rows
unrecoverable; that decision requires incident commander and data-owner approval. Key
rotation limits future exposure but cannot revoke plaintext already recovered by an
attacker who possessed both ciphertext and the compromised key.

## Rollback

Before contraction, rollback is configuration-only: make the previous retained id active
and roll the gateway. After old-key contraction, restore the retired secret from escrow,
expand the ring, and roll forward; do not edit ciphertext rows manually.
