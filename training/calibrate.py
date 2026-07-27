"""
Per-model operating-threshold calibration for the int8 served artifact (tech-lead ruling, phi).

    uv run python calibrate.py --concern phi-in-context

0.5 is not sacred per model. int8 quantization can raise the hard-negative false-positive rate; we
raise the int8 threshold on the DEV split (never the lockbox) until dev hard-neg FPR is back under
fp32@0.5 + gate_tolerance, without cratering recall, then freeze + content-hash that threshold into
the served artifact and RE-MEASURE on the lockbox. Calibration only — the training recipe stays
locked (amendment 10(l)).
"""
import argparse
import hashlib
import json
import re
from pathlib import Path

import numpy as np
import onnxruntime as ort
from transformers import AutoTokenizer

ROOT = Path(__file__).resolve().parents[1]
EVAL_DIR = ROOT / "packages" / "judge-eval" / "data"
LOCKBOX_DIR = Path(__file__).parent / "lockbox"
MODELS = Path(__file__).parent / "models"
MAX_LEN = 128
FPR_TOLERANCE = 0.03  # gate tolerance for hard-negative FPR
MIN_RECALL = 0.90  # do not crater recall to chase FPR


def sha256_obj(obj):
    return hashlib.sha256(json.dumps(obj, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def softmax_pos(logits, T):
    z = logits / max(T, 0.05)
    z = z - z.max(axis=-1, keepdims=True)
    e = np.exp(z)
    return (e / e.sum(axis=-1, keepdims=True))[:, 1]


def scores(sess, tok, texts, T, batch=32):
    out = []
    for i in range(0, len(texts), batch):
        enc = tok(texts[i:i + batch], padding="max_length", truncation=True, max_length=MAX_LEN, return_tensors="np")
        lg = sess.run(["logits"], {"input_ids": enc["input_ids"].astype(np.int64),
                                   "attention_mask": enc["attention_mask"].astype(np.int64)})[0]
        out.extend(softmax_pos(lg, T).tolist())
    return out


def dev_splits(concern):
    cdir = EVAL_DIR / concern
    m = json.loads((cdir / "manifest.json").read_text())
    return {e["suite"]: json.loads((cdir / e["file"]).read_text())["examples"] for e in m["splits"]}


def lock_splits(concern):
    d = json.loads((LOCKBOX_DIR / f"{concern}.json").read_text())
    return {s["suite"]: s["examples"] for s in d["splits"]}


def frac_ge(xs, t):
    return sum(1 for x in xs if x >= t) / len(xs) if xs else 0.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--concern", required=True)
    args = ap.parse_args()
    c = args.concern
    outdir = MODELS / c
    artifact = json.loads((outdir / "artifact.json").read_text())
    T = artifact["temperature"]
    tok = AutoTokenizer.from_pretrained(str(outdir))
    int8 = ort.InferenceSession(str(outdir / "model.int8.onnx"), providers=["CPUExecutionProvider"])
    fp32 = ort.InferenceSession(str(outdir / "model.onnx"), providers=["CPUExecutionProvider"])

    dev = dev_splits(c)
    pos = [e["text"] for e in dev["clean-positive"]]
    hard = [e["text"] for e in dev["clean-negative"] if e.get("hardNegative")]

    fp32_fpr = frac_ge(scores(fp32, tok, hard, T), 0.5)
    target = fp32_fpr + FPR_TOLERANCE
    int8_pos = scores(int8, tok, pos, T)
    int8_hard = scores(int8, tok, hard, T)

    chosen = 0.5
    for t in [x / 100 for x in range(50, 100)]:
        fpr = frac_ge(int8_hard, t)
        rec = frac_ge(int8_pos, t)
        if fpr <= target and rec >= MIN_RECALL:
            chosen = t
            break
    print(f"{c}: fp32@0.5 dev FPR {fp32_fpr*100:.1f}% → target ≤{target*100:.1f}%; "
          f"chosen int8 threshold {chosen} (dev FPR {frac_ge(int8_hard, chosen)*100:.1f}%, dev recall {frac_ge(int8_pos, chosen)*100:.1f}%)")

    # Re-measure on the LOCKBOX at the chosen threshold.
    lock = lock_splits(c)
    lpos = scores(int8, tok, [e["text"] for e in lock["clean-positive"]], T)
    lhard = scores(int8, tok, [e["text"] for e in lock["clean-negative"] if e.get("hardNegative")], T)
    fp32_lhard = scores(fp32, tok, [e["text"] for e in lock["clean-negative"] if e.get("hardNegative")], T)
    print(f"  LOCKBOX int8@{chosen}: hard-neg FPR {frac_ge(lhard, chosen)*100:.1f}%  clean recall {frac_ge(lpos, chosen)*100:.1f}%  "
          f"(fp32@0.5 lockbox FPR {frac_ge(fp32_lhard, 0.5)*100:.1f}%)")

    # Freeze + content-hash the threshold into the served artifact.
    artifact["threshold"] = chosen
    artifact["thresholdBasis"] = "int8 recalibrated on dev split to hold hard-neg FPR within fp32@0.5 + gate tolerance (recipe locked)"
    vh = sha256_obj({"packId": artifact["packId"], "concern": artifact["concern"], "kind": artifact["kind"],
                     "onnxInt8": artifact["hashes"]["onnxInt8"], "tokenizer": artifact["hashes"]["tokenizer"],
                     "temperature": round(T, 6), "threshold": chosen})
    artifact["modelVersion"] = f"{artifact['packId']}@{vh[:12]}"
    (outdir / "artifact.json").write_text(json.dumps(artifact, indent=2, sort_keys=True) + "\n")
    print(f"  froze threshold; served {artifact['modelVersion']}")


if __name__ == "__main__":
    main()
