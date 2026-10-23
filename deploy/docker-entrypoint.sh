#!/bin/sh
# Entrypoint of the Pharos API image (POSIX sh; the runtime image has no bash guarantees).
#
#   <none> / anything else  exec as given — the default CMD is the API server over tsx
#   demo                    `pharos init && pharos demo` over EMBEDDED storage inside the
#                           container (/tmp/.pharos): three verdicts sealed, the chain verified,
#                           evidence-bundle.json written. Ephemeral; tamper-evident, not WORM.
#   pharos <args>           the bundled @getpharos/cli, e.g. `pharos --version`
#
# The image's PHAROS_KMS_KEYSTORE_DIR / PHAROS_JUDGE_MODEL_DIR point at the production volume
# mounts, which the embedded CLI path must not inherit (the keystore lives under its own data
# directory, and an env override would win over it) — so the CLI branches unset them.
set -e

CLI=/app/cli/bin/pharos.mjs

case "${1:-}" in
  demo)
    unset PHAROS_KMS_KEYSTORE_DIR PHAROS_JUDGE_MODEL_DIR
    cd /tmp
    node "$CLI" init >/dev/null
    exec node "$CLI" demo
    ;;
  pharos)
    shift
    unset PHAROS_KMS_KEYSTORE_DIR PHAROS_JUDGE_MODEL_DIR
    exec node "$CLI" "$@"
    ;;
  *)
    exec "$@"
    ;;
esac
