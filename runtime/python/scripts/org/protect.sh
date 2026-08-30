#!/usr/bin/env bash
# One-time per repo: branch protection as code (requires admin PAT).
# Enforces: PR required, 1 approving review (not the author), status checks,
# no force-push, signed commits. Run via: bash scripts/org/protect.sh <repo>
#
# NOTE (SH-2): this is NOT yet applied to KEEL. With a single maintainer,
# required_approving_review_count=1 + require_last_push_approval makes every
# merge impossible (no second reviewer exists). Apply this the moment a named
# second maintainer is added — see docs/SDLC-POLICY.md.
set -euo pipefail
gh api -X PUT "repos/Bobcatsfan33/$1/branches/main/protection" \
  -H "Accept: application/vnd.github+json" \
  --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["security-suite / build-scan-sign", "ci"]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "required_approving_review_count": 1,
    "require_code_owner_reviews": true,
    "require_last_push_approval": true
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_signatures": true
}
JSON
