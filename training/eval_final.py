"""
Numbers of record for Sprint 6 (tech-lead ruling): logistic baseline vs transformer, fp32 vs int8,
DEV vs LOCKBOX — all at the frozen operating point 0.5, blinded (metrics only, no eval text printed).

    uv run python eval_final.py --concern finra-promissory

- DEV = the committed judge-eval set (now a dev set — the recipe was shaped against it).
- LOCKBOX = fresh instances, new seed, hardened base64/rot13 (never observed by the recipe).
- The dev→lockbox gap is the optimism cost. The int8 numbers are the SERVED artifact's numbers.
Reports the SEMANTIC-suite model win (bare) and the ENCODING-suite bare floor (expected ~0 on the
hardened lockbox — the normalizer, not the model, wins those).
"""
import argparse
import json
import re
from pathlib import Path

import numpy as np
import onnxruntime as ort
from transformers import AutoTokenizer

ROOT = Path(__file__).resolve().parents[1]
EVAL_DIR = ROOT / "packages" / "judge-eval" / "data"
LOCKBOX_DIR = Path(__file__).parent / "lockbox"
LOGISTIC_DIR = ROOT / "packages" / "judge" / "models"
MODELS = Path(__file__).parent / "models"
MAX_LEN = 128
THR = 0.5
SEMANTIC = ["paraphrase", "synonym", "leetspeak", "sentence-split", "prompt-injection", "spanish", "german"]
ENCODING = ["base64", "rot13"]


# ---- logistic baseline (mirrors packages/judge featurize.ts + model.ts) ----
def featurize(text):
    toks = [t for t in re.split(r"[^a-z0-9]+", text.lower()) if t]
    feats = []
    for i, t in enumerate(toks):
        feats.append(f"u:{t}")
        if i + 1 < len(toks):
            feats.append(f"b:{t}_{toks[i+1]}")
    return feats


def logistic_prob(artifact, text):
    z = artifact["bias"]
    counts = {}
    for f in featurize(text):
        counts[f] = counts.get(f, 0) + 1
    for f, c in counts.items():
        w = artifact["weights"].get(f)
        if w is not None:
            z += w * c
    return 1.0 / (1.0 + np.exp(-z)) if z >= 0 else np.exp(z) / (1.0 + np.exp(z))


def softmax_pos(logits, temperature):
    z = logits / max(temperature, 0.05)
    z = z - z.max(axis=-1, keepdims=True)
    e = np.exp(z)
    return (e / e.sum(axis=-1, keepdims=True))[:, 1]


# batch=1 is serving-faithful: dynamic-int8 ONNX is batch-sensitive (per-tensor activation scales
# span the batch), so only batch-1 matches the deterministic, reproducible batch-1 serving path
# (OnnxJudge.scoreBatch). fp32 is batch-invariant. Never raise this above 1 for served-model eval.
def onnx_scores(sess, tok, texts, temperature, batch=1):
    out = []
    for i in range(0, len(texts), batch):
        enc = tok(texts[i:i + batch], padding="max_length", truncation=True, max_length=MAX_LEN, return_tensors="np")
        logits = sess.run(["logits"], {"input_ids": enc["input_ids"].astype(np.int64),
                                       "attention_mask": enc["attention_mask"].astype(np.int64)})[0]
        out.extend(softmax_pos(logits, temperature).tolist())
    return out


def load_dev(concern):
    cdir = EVAL_DIR / concern
    manifest = json.loads((cdir / "manifest.json").read_text())
    return {e["suite"]: json.loads((cdir / e["file"]).read_text())["examples"] for e in manifest["splits"]}


def load_lockbox(concern):
    data = json.loads((LOCKBOX_DIR / f"{concern}.json").read_text())
    return {s["suite"]: s["examples"] for s in data["splits"]}


def recall_at(scores, thr=THR):
    return sum(1 for x in scores if x >= thr) / len(scores) if scores else 0.0


def evaluate(concern, dataset, score_fn):
    pos = [e["text"] for e in dataset["clean-positive"]]
    neg = [e["text"] for e in dataset["clean-negative"]]
    ps, ns = score_fn(pos), score_fn(neg)
    clean_recall = recall_at(ps)
    den = sum(1 for x in ps + ns if x >= THR)
    prec = (sum(1 for x in ps if x >= THR) / den) if den else 0.0
    hard = [e["text"] for e in dataset["clean-negative"] if e.get("hardNegative")]
    hard_fpr = recall_at(score_fn(hard))
    suites = {}
    for s in SEMANTIC + ENCODING:
        if s in dataset:
            suites[s] = recall_at(score_fn([e["text"] for e in dataset[s] if e["label"] == 1]))
    return {"clean_recall": clean_recall, "precision": prec, "hard_fpr": hard_fpr, "suites": suites}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--concern", required=True)
    args = ap.parse_args()
    c = args.concern

    logistic = json.loads((LOGISTIC_DIR / f"{c}.model.json").read_text())
    artifact = json.loads((MODELS / c / "artifact.json").read_text())
    T = artifact["temperature"]
    tok = AutoTokenizer.from_pretrained(str(MODELS / c))
    sess_fp32 = ort.InferenceSession(str(MODELS / c / "model.onnx"), providers=["CPUExecutionProvider"])
    sess_int8 = ort.InferenceSession(str(MODELS / c / "model.int8.onnx"), providers=["CPUExecutionProvider"])

    def log_fn(texts):
        return [logistic_prob(logistic, t) for t in texts]

    def fp32_fn(texts):
        return onnx_scores(sess_fp32, tok, texts, T)

    def int8_fn(texts):
        return onnx_scores(sess_int8, tok, texts, T)

    dev, lock = load_dev(c), load_lockbox(c)
    r = {
        "log_dev": evaluate(c, dev, log_fn),
        "log_lock": evaluate(c, lock, log_fn),
        "fp32_lock": evaluate(c, lock, fp32_fn),
        "int8_dev": evaluate(c, dev, int8_fn),
        "int8_lock": evaluate(c, lock, int8_fn),
    }

    def pc(x):
        return f"{x*100:5.1f}"

    print(f"\n=== {c} — numbers of record ({artifact['modelVersion']}) ===")
    print(f"{'metric':18s} | logistic(lock) | int8(lock)  | int8(dev)   | fp32(lock)  | int8Δfp32(lock) | dev→lock gap")
    for key, label in [("clean_recall", "clean recall"), ("precision", "clean precision"), ("hard_fpr", "hard-neg FPR")]:
        ll, il, idv, fl = r["log_lock"][key], r["int8_lock"][key], r["int8_dev"][key], r["fp32_lock"][key]
        print(f"{label:18s} | {pc(r['log_dev'][key])}(dev){pc(ll)} | {pc(il)}       | {pc(idv)}       | {pc(fl)}       | {pc(il-fl):>6}          | {pc(idv-il):>6}")
    print("SEMANTIC suites — recall (model win = int8 lockbox > logistic lockbox):")
    for s in SEMANTIC:
        if s in r["int8_lock"]["suites"]:
            ll = r["log_lock"]["suites"].get(s, 0)
            il = r["int8_lock"]["suites"][s]
            fl = r["fp32_lock"]["suites"].get(s, 0)
            win = "WIN " if il > ll else "----"
            print(f"  {win} {s:16s} int8 {pc(il)}  logistic {pc(ll)}  Δ {pc(il-ll):>6}   (int8Δfp32 {pc(il-fl):>6})")
    print("ENCODING suites — BARE floor (expected ~0 on hardened lockbox; normalizer wins these):")
    for s in ENCODING:
        if s in r["int8_lock"]["suites"]:
            print(f"       {s:16s} int8 {pc(r['int8_lock']['suites'][s])}  logistic {pc(r['log_lock']['suites'].get(s,0))}")


if __name__ == "__main__":
    main()
