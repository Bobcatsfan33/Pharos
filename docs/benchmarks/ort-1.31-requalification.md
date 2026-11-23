# ONNX Runtime 1.30.0 → 1.31.1 requalification (PR #361)

Same models (judge-models-v2, hash-verified), same tokenizer, same frozen 0.5 thresholds; only
the runtime moves. `qualifiedRuntimes` in `packages/judge/models/manifest.json` gates production
startup (`buildJudgeRegistry` calls `assertQualifiedOnnxRuntime` when `env=prod` and the judge
provider is `onnx`), so a runtime bump without this measurement would refuse to boot — which is
the point of the gate.

## Result

- **Node-vs-node probability delta: max |dp| = 0.000e+00 over 28 records — bit-identical.**
  Every record of both served int8 configs returns the same float at 1.31.1 as at 1.30.0.
- **Decision flips at the frozen 0.5 threshold: 0 of 28.**
- **Worst margin change: +0.00%.** Nothing moved, including the near-threshold probes.
- **Node/Python parity at 1.31.1: max |dp| = 8.532e-08 against the Python reference, gate 1e-4.**
  Identical to the 1.30.0 figure, because the Node output did not change.
- The three-test live serving suite (`pnpm test:judge-parity`) passes on darwin-arm64 at 1.31.1:
  input_ids bit-identical, probability within 1e-4, `ModelRegistry.judgeAsync` integration, and
  the cold-load-with-verify vs warm p50/p99 latency publication. This exercises
  `phi-in-context` (fp32) as well as the two int8 configs, so the fp32 path is covered by load,
  hash verification and inference even though the parity corpus is int8-only.
- CI qualification record on linux-x64: the `hash-verified ONNX Node/Python parity` job on
  PR #361 (`3 passed`), with `[latency] finra-promissory: cold-load+verify 415ms · warm p50
  18.4ms · p99 23.6ms`, `phi-in-context: 4434ms · 110.8ms · 144.0ms`, `funds-movement-intent:
  498ms · 33.1ms · 42.2ms`.

`qualifiedRuntimes` now lists 1.31.1 on linux-x64 and darwin-arm64. The 1.30.0 and
1.20.1/linux-x64 identities are retained as historical qualified identities, as when 1.30.0
landed.

## How it was measured, and how the measurement was checked

Both runs scored the committed parity corpus (`test/fixtures/onnx-parity.json`,
`test/fixtures/onnx-parity-funds.json` — 28 records, 14 per concern) through
`loadOnnxJudge().scoreBatch`, from the same hash-verified blob cache, on darwin-arm64.

A zero delta is exactly what a *failed* version swap also looks like, so the runtime each run
actually loaded was read from the native library rather than inferred from the manifest pin:
`onnxruntime-node`'s `env.versions` reported `{"common":"1.30.0","node":"1.30.0"}` for the
baseline and `{"common":"1.31.1","node":"1.31.1"}` after the bump, with only the matching
version present in the pnpm store each time. The pinned identity string
(`onnxRuntimeIdentity()`) comes from `packages/judge/package.json` and would have agreed either
way; the native version is what makes the result trustworthy.

The Python reference generator in `judge-parity.yml` deliberately stays on `onnxruntime==1.30.0`.
The gate's value is cross-implementation agreement, and holding the Python side still while the
Node side moves makes the 1e-4 check a cross-version check too. Moving both at once would
weaken it.

## Near-threshold records (the ones a numerics change would flip first)

Ordered by margin to the frozen 0.5 threshold, closest first.

| concern | text | margin to 0.5 | p@1.30.0 | p@1.31.1 | delta p | python ref |
|---|---|---|---|---|---|---|
| funds-movement-intent | Hello, 世界! 你好 mixed-script test. | 0.0072 | 0.492838 | 0.492838 | +0.0e+00 | 0.492838 |
| funds-movement-intent | café résumé naïve coöperate Zürich | 0.1499 | 0.649936 | 0.649936 | +0.0e+00 | 0.649936 |
| finra-promissory | MRN 620148: patient started on dialysi | 0.1946 | 0.305350 | 0.305350 | +0.0e+00 | 0.305350 |
| funds-movement-intent |    extra   whitespace and tabs    | 0.2151 | 0.715103 | 0.715103 | +0.0e+00 | 0.715103 |
| finra-promissory | Le garantizamos una rentabilidad asegu | 0.2469 | 0.746894 | 0.746894 | +0.0e+00 | 0.746894 |
| funds-movement-intent | out-of-vocab emoji rocket and symbols  | 0.2502 | 0.750222 | 0.750222 | +0.0e+00 | 0.750222 |
| funds-movement-intent | Straße für 5,00 € — jährlich, ohne Ris | 0.2732 | 0.773230 | 0.773230 | +0.0e+00 | 0.773230 |
| funds-movement-intent | Le garantizamos una rentabilidad asegu | 0.2796 | 0.220377 | 0.220377 | +0.0e+00 | 0.220377 |
| funds-movement-intent | Wir garantieren Ihnen eine feste Rendi | 0.3137 | 0.186292 | 0.186292 | +0.0e+00 | 0.186292 |
| finra-promissory | a.b-c/d_e (test) [x] {y} <z> | 0.3926 | 0.892631 | 0.892631 | +0.0e+00 | 0.892631 |

The remaining 18 records sit further from the threshold and are likewise unchanged; the full
dumps are reproducible with the corpus above and the two runtime pins.
