"""
Generate the tokenizer/serving parity ground truth (Sprint 6, S6-T2).

    uv run python gen_parity_fixture.py

Dumps, for a curated set of edge-case texts (NOT eval examples — accents, punctuation, CJK, numbers,
mixed scripts), the HF input_ids and the finra model's positive-class probability. The JS serving
path must reproduce input_ids EXACTLY and the probability within 1e-4 (test/fixtures/onnx-parity.json).
"""
import json
from pathlib import Path

import numpy as np
import onnxruntime as ort
from transformers import AutoTokenizer

HERE = Path(__file__).parent
CONCERN = "finra-promissory"  # representative; the tokenizer is shared across concerns
MODEL = HERE / "models" / CONCERN
OUT = HERE.parent / "test" / "fixtures" / "onnx-parity.json"
MAX_LEN = 128

TEXTS = [
    "We guarantee a fixed return, no risk.",
    "Le garantizamos una rentabilidad asegurada.",
    "Wir garantieren Ihnen eine feste Rendite.",
    "Straße für 5,00 € — jährlich, ohne Risiko.",
    "El niño preguntó: ¿está seguro? ¡Sí!",
    "Please transfer $1,234.56 to account #4821 now.",
    "café résumé naïve coöperate Zürich",
    "a.b-c/d_e (test) [x] {y} <z>",
    "007 42 3.14159 100% +/-",
    "Hello, 世界! 你好 mixed-script test.",
    "MRN 620148: patient started on dialysis.",
    "   extra   whitespace\tand\ttabs   ",
    "ALL CAPS SHOUTING GUARANTEE",
    "out-of-vocab emoji rocket and symbols test",
]


def main():
    tok = AutoTokenizer.from_pretrained(str(MODEL))
    art = json.loads((MODEL / "artifact.json").read_text())
    T = art["temperature"]
    served = art["served"]
    sess = ort.InferenceSession(str(MODEL / served), providers=["CPUExecutionProvider"])

    records = []
    for text in TEXTS:
        enc = tok(text, truncation=True, max_length=MAX_LEN)
        ids = enc["input_ids"]
        # Probability with padding to MAX_LEN (serving pads too).
        p = tok(text, padding="max_length", truncation=True, max_length=MAX_LEN, return_tensors="np")
        logits = sess.run(
            ["logits"],
            {"input_ids": p["input_ids"].astype(np.int64), "attention_mask": p["attention_mask"].astype(np.int64)},
        )[0]
        z = logits / max(T, 0.05)
        z = z - z.max(axis=-1, keepdims=True)
        e = np.exp(z)
        prob = float((e / e.sum(axis=-1, keepdims=True))[0, 1])
        records.append({"text": text, "inputIds": ids, "probability": round(prob, 8)})

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps(
            {
                "concern": CONCERN,
                "served": served,
                "modelVersion": art["modelVersion"],
                "temperature": T,
                "threshold": art["threshold"],
                "maxLen": MAX_LEN,
                "records": records,
            },
            indent=2,
            ensure_ascii=False,
        )
        + "\n"
    )
    print(f"wrote {OUT} with {len(records)} parity records (served {served})")
    for r in records[:4]:
        print(f"  ids[:8]={r['inputIds'][:8]} p={r['probability']:.4f} :: {r['text'][:40]}")


if __name__ == "__main__":
    main()
