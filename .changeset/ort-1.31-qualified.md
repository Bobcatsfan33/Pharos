---
"@getpharos/cli": patch
---

Qualify `onnxruntime-node@1.31.1` on linux-x64 and darwin-arm64 in the judge model manifest
the CLI bundles. Measured, not assumed: all 28 records of the committed parity corpus return
bit-identical probabilities to 1.30.0, with zero decision flips at the frozen 0.5 threshold
(`docs/benchmarks/ort-1.31-requalification.md`). Without this the pinned runtime is one a
production API refuses to start on.
