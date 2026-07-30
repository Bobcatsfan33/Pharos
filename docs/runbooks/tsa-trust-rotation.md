# RFC 3161 trust and certificate rotation

Production Pharos accepts timestamps only from leaf certificates whose SHA-256 fingerprints are
approved outside Pharos. Treat `PHAROS_TSA_CERT_SHA256` as trust policy, not as an endpoint-derived
value. The security or PKI team must obtain each fingerprint from the contracted TSA through an
authenticated independent channel and record the approval in the change ticket.

## Planned rotation

1. Obtain and verify the next leaf-certificate fingerprint and its activation window.
2. Add it after the current pin as a comma-separated overlap set. Keep the old pin:
   `PHAROS_TSA_CERT_SHA256=<current>,<next>`.
3. Deploy and confirm health. Create a test anchor after the TSA activates the new signer, export
   it, and verify it offline with both approved pins.
4. Confirm every replica has the overlap set and that scheduled anchors are succeeding.
5. After the contracted rollback window, remove the retired pin through a second approved change.
   Retain the historical pin in evidence-verification policy for old bundles.

Never replace the current pin before the next signer is active. Never copy a fingerprint from a
token or bundle and then use it to authenticate that same evidence.

## Outage or unexpected signer

A network failure, non-success response, malformed token, invalid CMS signature, unapproved signer,
certificate outside its validity window, missing timestamping EKU, or weak digest fails anchoring
closed. Pharos does not persist the token and must not silently fall back to local time.

1. Alert on failed or stale anchors and preserve the exact error without logging token bodies.
2. Confirm endpoint reachability and contracted TSA status.
3. For a signer mismatch, pause evidence release. Obtain the new fingerprint independently and
   validate the provider's incident/change notice. Do not approve a pin from the rejected token.
4. Add a new pin only through the normal dual-control change process, then verify a fresh token
   offline before resuming evidence release.
5. Document the anchoring gap and attach the first successful post-recovery token to the incident.

Emergency fallback to `local` timestamps or an unpinned RFC 3161 signer is prohibited in
production.
