"""Generate a same-host Python ONNX probability reference from hash-pinned release bytes."""

from __future__ import annotations

import hashlib
import json
import sys
import tempfile
import urllib.request
from pathlib import Path

import numpy as np
import onnxruntime as ort

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "packages" / "judge" / "models" / "manifest.json"
FIXTURE = ROOT / "test" / "fixtures" / "onnx-parity.json"


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: generate_runtime_parity_reference.py OUTPUT.json")
    output = Path(sys.argv[1])
    manifest = json.loads(MANIFEST.read_text())
    fixture = json.loads(FIXTURE.read_text())
    entry = manifest["models"][fixture["concern"]]
    model = entry["assets"]["model"]
    url = (
        f"https://github.com/{manifest['release']['repo']}/releases/download/"
        f"{manifest['release']['tag']}/{model['asset']}"
    )
    with urllib.request.urlopen(url, timeout=120) as response:
        payload = response.read()
    digest = hashlib.sha256(payload).hexdigest()
    if digest != model["sha256"]:
        raise RuntimeError(f"model digest mismatch: expected {model['sha256']}, got {digest}")

    with tempfile.NamedTemporaryFile(suffix=".onnx") as model_file:
        model_file.write(payload)
        model_file.flush()
        session = ort.InferenceSession(model_file.name, providers=["CPUExecutionProvider"])
        for record in fixture["records"]:
            ids = record["inputIds"]
            max_len = fixture["maxLen"]
            input_ids = np.array([ids + [0] * (max_len - len(ids))], dtype=np.int64)
            attention_mask = np.array(
                [[1] * len(ids) + [0] * (max_len - len(ids))], dtype=np.int64
            )
            logits = session.run(
                ["logits"], {"input_ids": input_ids, "attention_mask": attention_mask}
            )[0]
            scaled = logits / max(fixture["temperature"], 0.05)
            scaled -= scaled.max(axis=-1, keepdims=True)
            exp = np.exp(scaled)
            record["probability"] = float((exp / exp.sum(axis=-1, keepdims=True))[0, 1])

    fixture["pythonRuntime"] = f"onnxruntime@{ort.__version__}/{sys.platform}"
    output.write_text(json.dumps(fixture, ensure_ascii=False, indent=2) + "\n")
    print(f"wrote {output} from {digest} using {fixture['pythonRuntime']}")


if __name__ == "__main__":
    main()
