# ENG-JUDGES — production judge and efficacy promotion

Primary tracker: [#36](https://github.com/Bobcatsfan33/Pharos/issues/36). Supporting blockers:
[#37](https://github.com/Bobcatsfan33/Pharos/issues/37) and
[#91](https://github.com/Bobcatsfan33/Pharos/issues/91).

The independent AI-risk evaluator receives the model manifest, model cards, frozen evaluation and
system-encoding reports, runtime-qualification record, drift runbook, and target deployment profile.
Approval requires fresh representative and adversarial lockboxes for all three concerns; documented
dataset provenance and adjudication; prevalence-adjusted operating points and error costs;
OOD/abstention calibration; an observed drift alert/rollback exercise; and production-topology cold,
warm, tail-latency, capacity, and failure-mode results. The funds meta-frame weakness must be resolved
and re-evaluated without training against the observed lockbox.

The receipt must identify the evaluator and promotion authority, target model hashes/runtime/commit,
methodology, limitations, thresholds, retained artifact digests, and signed promotion decision.
Repository CI and same-host parity are prerequisites, not independent efficacy approval.
