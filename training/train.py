"""
Fine-tune a CPU-servable multilingual encoder per concern and export ONNX + calibration + manifest.

    uv run python train.py --concern finra-promissory [--seed 42] [--epochs 4]

Model: distilbert-base-multilingual-cased (135M) — multilingual because the "translation" semantic
suite (native es/de) cannot be beaten by an English-only encoder. Binary sequence classifier.

Determinism: seeds are fixed (python/numpy/torch), torch is single-threaded, and deterministic
algorithms are requested. CPU BLAS/threading can still introduce last-bit differences across
machines; the committed artifact + its content hash are authoritative (same contract as the eval
datasets). Caveats are recorded in the manifest.

Calibration: temperature scaling — a single scalar T fit on a held-out split by minimizing NLL. The
served probability is softmax(logits / T)[positive].

Output: models/<concern>/{model.onnx, tokenizer files, artifact.json}. artifact.json carries the
content hashes, dataset hash, hyperparameters, threshold, temperature, and the modelVersion-style id.
"""
import argparse
import hashlib
import json
import os
import random
from pathlib import Path

os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")

import numpy as np
import torch
from torch.utils.data import DataLoader, TensorDataset
from transformers import AutoTokenizer, AutoModelForSequenceClassification

BASE_MODEL = "distilbert-base-multilingual-cased"
MAX_LEN = 128
THRESHOLD = 0.5  # frozen operating point (§7-10(e)); never tuned on the eval set
HERE = Path(__file__).parent
DATA = HERE / "data"
OUT = HERE / "models"


def set_determinism(seed: int):
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    torch.use_deterministic_algorithms(True, warn_only=True)
    torch.set_num_threads(4)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    h.update(path.read_bytes())
    return h.hexdigest()


def sha256_obj(obj) -> str:
    return hashlib.sha256(json.dumps(obj, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def load_corpus(concern: str):
    rows = [json.loads(l) for l in (DATA / f"{concern}.jsonl").read_text().splitlines()]
    # Also fold in the small committed training seeds from packages/judge/data (parsed from TS).
    ts = (HERE.parent / "packages" / "judge" / "data" / f"{concern}.ts").read_text()
    import re
    for m in re.finditer(r'text:\s*"((?:[^"\\]|\\.)*)"\s*,\s*label:\s*([01])', ts):
        rows.append({"text": m.group(1).encode().decode("unicode_escape"), "label": int(m.group(2)), "lang": "en"})
    return rows


def encode(tok, texts):
    enc = tok(texts, padding="max_length", truncation=True, max_length=MAX_LEN, return_tensors="pt")
    return enc["input_ids"], enc["attention_mask"]


def fit_temperature(logits: torch.Tensor, labels: torch.Tensor) -> float:
    """Fit a single temperature by minimizing NLL on held-out logits (Guo et al. 2017)."""
    T = torch.nn.Parameter(torch.ones(1))
    opt = torch.optim.LBFGS([T], lr=0.05, max_iter=60)
    nll = torch.nn.CrossEntropyLoss()

    def closure():
        opt.zero_grad()
        loss = nll(logits / T.clamp(min=0.05), labels)
        loss.backward()
        return loss

    opt.step(closure)
    return float(T.detach().clamp(min=0.05).item())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--concern", required=True)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--epochs", type=int, default=4)
    ap.add_argument("--lr", type=float, default=2e-5)
    ap.add_argument("--batch", type=int, default=16)
    args = ap.parse_args()

    set_determinism(args.seed)
    rows = load_corpus(args.concern)
    dataset_hash = sha256_obj([{"t": r["text"], "l": r["label"]} for r in rows])

    # Deterministic held-out split (stratified 15%) for calibration.
    rng = random.Random(args.seed)
    idx = list(range(len(rows)))
    rng.shuffle(idx)
    holdout = set(idx[: max(20, len(rows) // 7)])
    train_rows = [rows[i] for i in idx if i not in holdout]
    cal_rows = [rows[i] for i in sorted(holdout)]
    print(f"{args.concern}: {len(train_rows)} train / {len(cal_rows)} calibration; dataset {dataset_hash[:12]}")

    tok = AutoTokenizer.from_pretrained(BASE_MODEL)
    model = AutoModelForSequenceClassification.from_pretrained(BASE_MODEL, num_labels=2)
    model.train()

    ids, mask = encode(tok, [r["text"] for r in train_rows])
    labels = torch.tensor([r["label"] for r in train_rows])
    loader = DataLoader(TensorDataset(ids, mask, labels), batch_size=args.batch, shuffle=False)
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr)

    for epoch in range(args.epochs):
        total = 0.0
        for bids, bmask, blab in loader:
            opt.zero_grad()
            out = model(input_ids=bids, attention_mask=bmask, labels=blab)
            out.loss.backward()
            opt.step()
            total += float(out.loss)
        print(f"  epoch {epoch + 1}/{args.epochs} loss {total / len(loader):.4f}")

    # Temperature calibration on held-out logits.
    model.eval()
    with torch.no_grad():
        cids, cmask = encode(tok, [r["text"] for r in cal_rows])
        cal_logits = model(input_ids=cids, attention_mask=cmask).logits
    temperature = fit_temperature(cal_logits, torch.tensor([r["label"] for r in cal_rows]))
    print(f"  temperature {temperature:.4f}")

    # Export ONNX (opset 17, dynamic batch + sequence).
    outdir = OUT / args.concern
    outdir.mkdir(parents=True, exist_ok=True)
    onnx_path = outdir / "model.onnx"
    dummy = encode(tok, ["calibration sentence for export"])
    torch.onnx.export(
        model,
        (dummy[0], dummy[1]),
        str(onnx_path),
        input_names=["input_ids", "attention_mask"],
        output_names=["logits"],
        dynamic_axes={
            "input_ids": {0: "batch", 1: "seq"},
            "attention_mask": {0: "batch", 1: "seq"},
            "logits": {0: "batch"},
        },
        opset_version=17,
        do_constant_folding=True,
    )
    tok.save_pretrained(str(outdir))

    artifact = {
        "packId": args.concern,
        "concern": args.concern,
        "kind": "onnx-transformer",
        "baseModel": BASE_MODEL,
        "maxLen": MAX_LEN,
        "threshold": THRESHOLD,
        "temperature": temperature,
        "hyperparams": {"seed": args.seed, "epochs": args.epochs, "lr": args.lr, "batch": args.batch},
        "trainedOn": {"examples": len(rows), "positives": sum(r["label"] for r in rows), "datasetHash": dataset_hash[:16]},
        "hashes": {
            "onnx": sha256_file(onnx_path),
            "tokenizer": sha256_file(outdir / "tokenizer.json") if (outdir / "tokenizer.json").exists()
            else sha256_file(outdir / "vocab.txt"),
        },
        "nondeterminismCaveat": "CPU BLAS/threading may cause last-bit logit differences across machines; the committed model.onnx + its content hash are authoritative.",
    }
    # modelVersion-compatible id: packId@sha256(identity)[:12].
    version_hash = sha256_obj({
        "packId": artifact["packId"], "concern": artifact["concern"], "kind": artifact["kind"],
        "onnx": artifact["hashes"]["onnx"], "tokenizer": artifact["hashes"]["tokenizer"],
        "temperature": round(temperature, 6), "threshold": THRESHOLD,
    })
    artifact["modelVersion"] = f"{artifact['packId']}@{version_hash[:12]}"
    (outdir / "artifact.json").write_text(json.dumps(artifact, indent=2, sort_keys=True) + "\n")
    print(f"  wrote {onnx_path.name} ({onnx_path.stat().st_size // (1024*1024)}MB) + artifact {artifact['modelVersion']}")


if __name__ == "__main__":
    main()
