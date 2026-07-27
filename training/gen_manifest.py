"""
Generate the committed model manifest from the local trained artifacts.

    uv run python gen_manifest.py

Writes packages/judge/models/manifest.json — the tiny committed text that pins each served model's
identity + asset content hashes (what modelVersion() commits to). The ONNX/tokenizer blobs
themselves are uploaded to the GitHub Release (maintainer step) and fetched hash-verified against
THIS manifest at load time (packages/judge/src/artifactStore.ts). No blobs in git.
"""
import json
from pathlib import Path

HERE = Path(__file__).parent
MODELS = HERE / "models"
OUT = HERE.parent / "packages" / "judge" / "models" / "manifest.json"
TAG = "judge-models-v1"
REPO = "Bobcatsfan33/Pharos"

manifest = {
    "schemaVersion": "1.0.0",
    "note": "Served transformer-judge artifacts. Blobs are GitHub Release assets, fetched and "
    "sha256-verified against this manifest at load time (never committed to git). modelVersion "
    "pins each identity.",
    "release": {
        "repo": REPO,
        "tag": TAG,
        "baseUrl": f"https://github.com/{REPO}/releases/download/{TAG}",
    },
    "models": {},
}

for cdir in sorted(MODELS.iterdir()):
    art = cdir / "artifact.json"
    if not art.exists():
        continue
    a = json.loads(art.read_text())
    concern = a["concern"]
    served = a["served"]  # model.int8.onnx | model.onnx
    served_hash = a["hashes"]["onnxInt8"] if served == "model.int8.onnx" else a["hashes"]["onnx"]
    manifest["models"][concern] = {
        "modelVersion": a["modelVersion"],
        "kind": a["kind"],
        "baseModel": a["baseModel"],
        "maxLen": a["maxLen"],
        "temperature": a["temperature"],
        "threshold": a["threshold"],
        "served": served,
        "assets": {
            "model": {"asset": f"{concern}.{served}", "sha256": served_hash},
            "tokenizer": {"asset": f"{concern}.tokenizer.json", "sha256": a["hashes"]["tokenizer"]},
        },
    }

OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(json.dumps(manifest, indent=2) + "\n")
print(f"wrote {OUT} with {len(manifest['models'])} models:")
for c, m in manifest["models"].items():
    print(f"  {c}: served {m['served']} ({m['assets']['model']['sha256'][:12]}) {m['modelVersion']}")
