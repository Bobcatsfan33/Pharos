# ONNX runtime and platform qualification evidence

Date: 2026-08-10  
Scope: FINRA parity fixture, production runtime identity, and `onnxruntime-node` 1.27 major update

The first Linux x64 parity workflow run failed while every default PR check passed. With the
content hash and tokenizer IDs unchanged, `Le garantizamos una rentabilidad asegurada.` produced
approximately `0.7469` on the macOS ARM reference and `0.2287` on the hosted Linux x64 runner.
That crosses the `0.5` decision threshold and is not rounding noise. The failed run is retained at
<https://github.com/Bobcatsfan33/Pharos/actions/runs/31347427138>.

The control response is architectural:

- production is restricted to the manifest-qualified
  `onnxruntime-node@1.20.1/linux-x64` identity;
- Helm and Compose request Linux AMD64 explicitly, and production startup rejects any runtime not
  listed in the signed-source manifest;
- `judgeRuntime` is sealed alongside `judgeVersion`, so a replay consumer knows both the model
  artifact and native execution environment;
- CI generates a Python ONNX reference on the same Linux host from the SHA-256-verified release
  asset and requires Node output within `1e-4`; tokenizer IDs remain exact against the frozen
  fixture;
- judge/runtime changes and a weekly schedule trigger the live job.

The `onnxruntime-node` 1.27 Dependabot update is not qualified. Local evaluation observed a maximum
probability delta of `0.0234337` against the existing reference even after its transitive
`adm-zip` advisory was removed with a safe override. It therefore remains quarantined: resolving
the package advisory does not establish verdict replay compatibility.
