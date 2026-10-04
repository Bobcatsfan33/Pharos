# ONNX Runtime 1.20.1 → 1.30.0 requalification (issue #220)

Same models (judge-models-v2, hash-verified), same tokenizer, same frozen 0.5 thresholds;
only the runtime moves. Measured on darwin-arm64 with the committed parity corpus (28 records,
finra int8 + funds int8 — the quantized served configs, where int8 numerics were the concern).

- Node-vs-node probability delta: max |dp| = 2.261e-02
- **Decision flips at the frozen 0.5 threshold: 0 of 28**
- Worst margin shrink: -45.2% (a near-threshold mixed-script probe,
  p 0.4869 → 0.4928 — not a decision change; all real-content records keep wide margins)
- Node/Python same-host parity at 1.30.0 passes the 1e-4 gate on darwin-arm64 (local) and
  linux-x64 (the judge-parity CI job on this change is the qualification record).

The September concern (ORT 1.20→1.29 moving int8 numerics against the OLD models, one record
losing 78% of its margin) was re-measured against the CURRENT served models: no flips, worst
margin shrink above. qualifiedRuntimes now lists 1.30.0 on linux-x64 and darwin-arm64;
1.20.1/linux-x64 is retained as the historical qualified identity.

| concern | text | p@1.20.1 | p@1.30.0 | delta p | margin change |
|---|---|---|---|---|---|
| finra-promissory | MRN 620148: patient started on dialysis. | 0.282739 | 0.305350 | 2.26e-02 | -10.4% |
| funds-movement-intent | Hello, 世界! 你好 mixed-script test. | 0.486934 | 0.492838 | 5.90e-03 | -45.2% |
| funds-movement-intent | MRN 620148: patient started on dialysis. | 0.948605 | 0.953968 | 5.36e-03 | +1.2% |
| funds-movement-intent |    extra   whitespace	and	tabs    | 0.709929 | 0.715103 | 5.17e-03 | +2.5% |
| finra-promissory | out-of-vocab emoji rocket and symbols te | 0.946280 | 0.942654 | 3.63e-03 | -0.8% |
| funds-movement-intent | El niño preguntó: ¿está seguro? ¡Sí! | 0.051183 | 0.048505 | 2.68e-03 | +0.6% |
| finra-promissory | café résumé naïve coöperate Zürich | 0.991873 | 0.990030 | 1.84e-03 | -0.4% |
| funds-movement-intent | café résumé naïve coöperate Zürich | 0.648244 | 0.649936 | 1.69e-03 | +1.1% |
| funds-movement-intent | a.b-c/d_e (test) [x] {y} <z> | 0.965666 | 0.966842 | 1.18e-03 | +0.3% |
| funds-movement-intent | Wir garantieren Ihnen eine feste Rendite | 0.187238 | 0.186292 | 9.47e-04 | +0.3% |
