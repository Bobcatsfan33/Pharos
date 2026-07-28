export * from "./schema.js";
export { CONCERN_SPECS, type ConcernSpec, type Template } from "./concerns/index.js";
export { generateConcern } from "./generate.js";
export {
  detectLeakage,
  containment,
  jaccard,
  tokenize,
  BIGRAM_CONTAINMENT_BLOCK,
  TRIGRAM_JACCARD_BLOCK,
  type LeakageReport,
  type LeakageHit,
} from "./dedup.js";
export {
  loadConcern,
  loadAllConcerns,
  allExamples,
  datasetExists,
  DATA_DIR,
  type LoadedConcern,
} from "./loader.js";
export {
  TRANSFORMS,
  base64WrapHardened,
  rot13WrapHardened,
  type TransformName,
} from "./transforms.js";
export * from "./metrics.js";
export { bootstrapCI, pairedBootstrapDeltaCI, DEFAULT_RESAMPLES, type CI } from "./bootstrap.js";
export {
  adjustedPrecision,
  baseRateBox,
  PREVALENCE_SCENARIOS,
  type BaseRateBox,
} from "./baserate.js";
export {
  logisticScorer,
  constantScorer,
  seededRandomScorer,
  type EvalScorer,
  type ScoreInput,
  type ScoredResult,
} from "./scorer.js";
export {
  loadOperatingPoints,
  operatingPointsHash,
  thresholdFor,
  OPERATING_POINTS_PATH,
  type OperatingPoints,
  type LoadedOperatingPoints,
} from "./operatingPoints.js";
export {
  evaluateConcern,
  type ConcernReport,
  type SuiteRecall,
  type ControlMetrics,
} from "./report.js";
export { renderMarkdown, type ReportMeta } from "./renderMarkdown.js";
export {
  ENCODING_SUITE,
  ENCODINGS,
  encode,
  type EncodingExample,
  type EncodingName,
} from "./encoding-suite.js";
export {
  runGate,
  gateConcern,
  loadTolerances,
  loadBaselineLock,
  validateBaselineLock,
  artifactHash,
  baselineModelsDir,
  renderGateDiff,
  type GateResult,
  type MetricVerdict,
  type Tolerances,
  type BaselineLock,
  type Direction,
} from "./gate.js";
