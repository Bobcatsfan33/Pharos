"""
Prove the training corpus does NOT leak either the development eval set or final lockbox
(prime directive / amendment 10(d)).

Mirrors packages/judge-eval/src/dedup.ts: a training example is a leak if its token-bigram
containment in some eval example is >= 0.80 OR its token-trigram Jaccard is >= 0.50, or it matches
exactly (normalized). Reads the eval text ONLY to compute overlap; never prints eval text. Exits
non-zero on any hit so the training run cannot proceed on a contaminated corpus.
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EVAL_DIR = ROOT / "packages" / "judge-eval" / "data"
TRAIN_DIR = Path(__file__).parent / "data"
LOCKBOX_DIR = Path(__file__).parent / "lockbox"
BIGRAM_BLOCK = 0.80
TRIGRAM_BLOCK = 0.50


def toks(text):
    return [t for t in re.split(r"[^a-z0-9]+", text.lower()) if t]


def ngrams(t, n):
    return set(" ".join(t[i:i + n]) for i in range(0, len(t) - n + 1)) if len(t) >= n else set()


def containment(a, b):
    return len(a & b) / len(a) if a else 0.0


def jaccard(a, b):
    return len(a & b) / len(a | b) if (a or b) else 0.0


def eval_texts(concern):
    out = []
    cdir = EVAL_DIR / concern
    manifest = json.loads((cdir / "manifest.json").read_text())
    for entry in manifest["splits"]:
        split = json.loads((cdir / entry["file"]).read_text())
        out.extend(e["text"] for e in split["examples"])
    lockbox = json.loads((LOCKBOX_DIR / f"{concern}.json").read_text())
    for split in lockbox["splits"]:
        out.extend(e["text"] for e in split["examples"])
    return out


def main():
    total_hits = 0
    for path in sorted(TRAIN_DIR.glob("*.jsonl")):
        concern = path.stem
        ev = eval_texts(concern)
        ev_norm = [" ".join(toks(t)) for t in ev]
        ev_big = [ngrams(toks(t), 2) for t in ev]
        ev_tri = [ngrams(toks(t), 3) for t in ev]
        rows = [json.loads(line) for line in path.read_text().splitlines()]
        hits = 0
        worst = 0.0
        for i, r in enumerate(rows):
            tt = toks(r["text"])
            norm = " ".join(tt)
            big, tri = ngrams(tt, 2), ngrams(tt, 3)
            best_bc = 0.0
            for j in range(len(ev)):
                if norm == ev_norm[j] and norm:
                    best_bc = 1.0
                    break
                bc = containment(big, ev_big[j])
                if bc > best_bc:
                    best_bc = bc
                if bc >= BIGRAM_BLOCK or jaccard(tri, ev_tri[j]) >= TRIGRAM_BLOCK:
                    hits += 1
                    print(f"  LEAK {concern} train#{i} bc={bc:.2f} :: {r['text'][:70]}")
                    break
            worst = max(worst, best_bc)
        print(f"{concern}: {len(rows)} train vs {len(ev)} eval — hits={hits}, max bigram containment={worst:.2f}")
        total_hits += hits
    if total_hits:
        print(f"\nFAIL: {total_hits} leakage hit(s). Fix the corpus before training.")
        sys.exit(1)
    print("\nOK: zero training↔eval leakage.")


if __name__ == "__main__":
    main()
