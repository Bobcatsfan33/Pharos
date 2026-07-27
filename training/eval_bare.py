"""
Blinded BARE evaluation of a trained ONNX judge against the eval suites (prime directive).

    uv run python eval_bare.py --concern finra-promissory

Runs the model over the held-out eval splits and reports per-suite metrics ONLY — it never prints
or inspects the eval text, and it is never used to select or tune the model (that would be leakage).
"Bare" = NO cascade normalizer (ADR 0004): models are measured naked so model-vs-model comparison
stays attributable. base64/rot13 are expected to stay ~0 here — that is the SYSTEM's job, not the
model's. Prints the baseline (logistic) numbers beside the transformer for the split-AC review.
"""
import argparse
import json
import math
from pathlib import Path

import numpy as np
import onnxruntime as ort
from transformers import AutoTokenizer

ROOT = Path(__file__).resolve().parents[1]
EVAL_DIR = ROOT / "packages" / "judge-eval" / "data"
BASELINE = ROOT / "docs" / "benchmarks" / "judge-evals.json"
MODELS = Path(__file__).parent / "models"
MAX_LEN = 128
SEMANTIC = ["paraphrase", "synonym", "leetspeak", "sentence-split", "prompt-injection", "spanish", "german"]
ENCODING = ["base64", "rot13"]


def load_splits(concern):
    cdir = EVAL_DIR / concern
    manifest = json.loads((cdir / "manifest.json").read_text())
    return {e["suite"]: json.loads((cdir / e["file"]).read_text()) for e in manifest["splits"]}


def softmax_pos(logits, temperature):
    z = logits / max(temperature, 0.05)
    z = z - z.max(axis=-1, keepdims=True)
    e = np.exp(z)
    p = e / e.sum(axis=-1, keepdims=True)
    return p[:, 1]


def score(sess, tok, texts, temperature, batch=32):
    probs = []
    for i in range(0, len(texts), batch):
        enc = tok(texts[i:i + batch], padding="max_length", truncation=True, max_length=MAX_LEN, return_tensors="np")
        out = sess.run(["logits"], {"input_ids": enc["input_ids"].astype(np.int64),
                                    "attention_mask": enc["attention_mask"].astype(np.int64)})[0]
        probs.extend(softmax_pos(out, temperature).tolist())
    return probs


def pr_auc(scores, labels):
    pos = sum(labels)
    if pos == 0:
        return 0.0
    order = sorted(range(len(scores)), key=lambda i: -scores[i])
    tp = fp = 0
    prev_r = 0.0
    ap = 0.0
    i = 0
    while i < len(order):
        p = scores[order[i]]
        while i < len(order) and scores[order[i]] == p:
            if labels[order[i]] == 1:
                tp += 1
            else:
                fp += 1
            i += 1
        rec = tp / pos
        prec = tp / (tp + fp) if tp + fp else 0.0
        ap += (rec - prev_r) * prec
        prev_r = rec
    return ap


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--concern", required=True)
    args = ap.parse_args()

    outdir = MODELS / args.concern
    artifact = json.loads((outdir / "artifact.json").read_text())
    T = artifact["temperature"]
    thr = artifact["threshold"]
    tok = AutoTokenizer.from_pretrained(str(outdir))
    sess = ort.InferenceSession(str(outdir / "model.onnx"), providers=["CPUExecutionProvider"])
    splits = load_splits(args.concern)

    base = None
    if BASELINE.exists():
        for r in json.loads(BASELINE.read_text())["reports"]:
            if r["concern"] == args.concern:
                base = r
    bl = {a["suite"]: a["recall"] for a in base["adversarial"]} if base else {}

    # Clean split.
    pos = splits["clean-positive"]["examples"]
    neg = splits["clean-negative"]["examples"]
    ps = score(sess, tok, [e["text"] for e in pos], T)
    ns = score(sess, tok, [e["text"] for e in neg], T)
    clean_scores = ps + ns
    clean_labels = [1] * len(ps) + [0] * len(ns)
    recall = sum(1 for x in ps if x >= thr) / len(ps)
    precision_den = sum(1 for x in clean_scores if x >= thr)
    precision = (sum(1 for x in ps if x >= thr) / precision_den) if precision_den else 0.0
    prauc = pr_auc(clean_scores, clean_labels)
    hard = [e for e in neg if e.get("hardNegative")]
    hs = score(sess, tok, [e["text"] for e in hard], T)
    hard_fpr = sum(1 for x in hs if x >= thr) / len(hs)

    print(f"\n=== {args.concern} — BARE transformer ({artifact['modelVersion']}) vs logistic baseline ===")
    print(f"clean: PR-AUC {prauc*100:5.1f}% (base {base['clean']['prAuc']*100:.1f}%) · "
          f"recall {recall*100:5.1f}% (base {base['clean']['recall']*100:.1f}%) · "
          f"precision {precision*100:.1f}% (base {base['clean']['precision']*100:.1f}%) · "
          f"hard-neg FPR {hard_fpr*100:.1f}% (base {base['hardNegatives']['falsePositiveRate']*100:.1f}%)")

    print("SEMANTIC suites (model must beat baseline):")
    for suite in SEMANTIC:
        if suite not in splits:
            continue
        ex = [e for e in splits[suite]["examples"] if e["label"] == 1]
        s = score(sess, tok, [e["text"] for e in ex], T)
        rec = sum(1 for x in s if x >= thr) / len(ex)
        b = bl.get(suite, 0.0)
        flag = "WIN " if rec > b else "----"
        print(f"  {flag} {suite:16s} recall {rec*100:5.1f}%  (base {b*100:5.1f}%)  Δ {(rec-b)*100:+5.1f}")

    print("ENCODING suites (NOT a model win — the cascade normalizer's job, ADR 0004):")
    for suite in ENCODING:
        if suite not in splits:
            continue
        ex = [e for e in splits[suite]["examples"] if e["label"] == 1]
        s = score(sess, tok, [e["text"] for e in ex], T)
        rec = sum(1 for x in s if x >= thr) / len(ex)
        print(f"       {suite:16s} recall {rec*100:5.1f}%  (base {bl.get(suite,0.0)*100:5.1f}%)")


if __name__ == "__main__":
    main()
