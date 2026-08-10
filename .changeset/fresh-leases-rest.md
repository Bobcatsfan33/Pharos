---
"@pharos/storage": patch
---

Grant held gateway requests a full wall-clock lease after decryption, avoiding stale transaction-time
expiry during slow key resolution or database lock waits.
