# Platform administrator token rotation

The `x-pharos-admin` credential can provision tenants and initial tenant-admin keys. Treat it
as a break-glass bootstrap credential: store it in the deployment secret manager, restrict the
admin route at the network boundary, and give every active credential a short, explicit lifetime.

## Zero-downtime rotation

1. Generate a new random token with at least 256 bits of entropy and choose its RFC 3339 expiry.
2. Move the old `PHAROS_ADMIN_TOKEN` and its expiry to
   `PHAROS_ADMIN_PREVIOUS_TOKEN` and `PHAROS_ADMIN_PREVIOUS_TOKEN_EXPIRES_AT`.
3. Put the new values in `PHAROS_ADMIN_TOKEN` and `PHAROS_ADMIN_TOKEN_EXPIRES_AT`, then roll the
   deployment. Both credentials work only until their respective expiry.
4. Update the authorized provisioning client, exercise a tenant-provisioning probe, and remove
   both previous-token variables in a second rollout before the overlap expires.
5. Record the secret-manager version, rollout, probe, and removal in the change ticket. Never
   record either credential value.

Production startup rejects a missing or already-expired current expiry, a short token, and a
previous token without a paired expiry. The request guard checks expiry on every request, so a
running process does not extend the lifetime past the declared deadline. An expired credential
returns the same generic 401 as any invalid value.

## Emergency revocation

Remove the compromised value from both active and previous slots, deploy a replacement active
credential, and confirm the old value receives 401. If provisioning is not needed during the
response, remove `PHAROS_ADMIN_TOKEN` entirely; the route fails closed with 503.
