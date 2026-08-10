"""
Dynamic int8 quantization of a trained ONNX judge (Sprint 6, tech-lead ruling).

    uv run python quantize.py --concern finra-promissory

The INT8 model is the SERVED and EVALUATED artifact (amendment 10) — smaller fetch + faster CPU
inference (helps the 800ms envelope). Produces model.int8.onnx beside model.onnx and updates
artifact.json with the int8 hash + a distinct served modelVersion. eval_bare.py --int8 measures the
int8-vs-fp32 recall delta the tech lead asked for; if the delta exceeds the gate tolerance we revisit
fp32-and-eat-the-storage.
"""
import argparse
import hashlib
import json
from pathlib import Path

from onnxruntime.quantization import quantize_dynamic, QuantType

MODELS = Path(__file__).parent / "models"


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def sha256_obj(obj) -> str:
    return hashlib.sha256(json.dumps(obj, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--concern", required=True)
    args = ap.parse_args()
    outdir = MODELS / args.concern
    fp32 = outdir / "model.onnx"
    int8 = outdir / "model.int8.onnx"

    quantize_dynamic(str(fp32), str(int8), weight_type=QuantType.QInt8)

    artifact = json.loads((outdir / "artifact.json").read_text())
    artifact["hashes"]["onnxInt8"] = sha256_file(int8)
    artifact["served"] = "model.int8.onnx"
    version_hash = sha256_obj({
        "packId": artifact["packId"], "concern": artifact["concern"], "kind": artifact["kind"],
        "onnxInt8": artifact["hashes"]["onnxInt8"], "tokenizer": artifact["hashes"]["tokenizer"],
        "recipeVersion": artifact["recipeVersion"],
        "temperature": round(artifact["temperature"], 6), "threshold": artifact["threshold"],
    })
    artifact["modelVersion"] = f"{artifact['packId']}@{version_hash[:12]}"
    (outdir / "artifact.json").write_text(json.dumps(artifact, indent=2, sort_keys=True) + "\n")

    fp32_mb = fp32.stat().st_size // (1024 * 1024)
    int8_mb = int8.stat().st_size // (1024 * 1024)
    print(f"{args.concern}: fp32 {fp32_mb}MB -> int8 {int8_mb}MB · served {artifact['modelVersion']}")


if __name__ == "__main__":
    main()
