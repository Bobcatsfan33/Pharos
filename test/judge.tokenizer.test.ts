import { describe, it, expect } from "vitest";
import { BertTokenizer, type TokenizerConfig } from "@pharos/judge";

/**
 * Hermetic unit test of the BERT WordPiece algorithm on a tiny synthetic vocab (the real-vocab
 * bit-parity vs Python is proven in the live spec against test/fixtures/onnx-parity.json).
 */
const cfg: TokenizerConfig = {
  vocab: {
    "[PAD]": 0,
    "[UNK]": 1,
    "[CLS]": 2,
    "[SEP]": 3,
    word: 4,
    un: 5,
    "##aff": 6,
    "##able": 7,
    pay: 8,
    "##ing": 9,
    ",": 10,
    ".": 11,
    café: 12,
  },
  unkToken: "[UNK]",
  continuingSubwordPrefix: "##",
  maxInputCharsPerWord: 100,
  cls: "[CLS]",
  sep: "[SEP]",
  pad: "[PAD]",
  lowercase: false,
  handleChineseChars: true,
};
const tok = new BertTokenizer(cfg);
const real = (text: string, maxLen = 8) => {
  const enc = tok.encode(text, maxLen);
  const n = enc.attentionMask.filter((m) => m === 1).length;
  return enc.inputIds.slice(0, n);
};

describe("BertTokenizer", () => {
  it("wraps content in [CLS] … [SEP]", () => {
    expect(real("word")).toEqual([2, 4, 3]);
  });

  it("greedy WordPiece with ## continuation", () => {
    expect(real("unaffable")).toEqual([2, 5, 6, 7, 3]); // un ##aff ##able
    expect(real("paying")).toEqual([2, 8, 9, 3]); // pay ##ing
  });

  it("isolates punctuation as its own token (BertPreTokenizer)", () => {
    expect(real("word, paying.")).toEqual([2, 4, 10, 8, 9, 11, 3]); // word , pay ##ing .
  });

  it("maps an unknown word to [UNK]", () => {
    expect(real("xyz")).toEqual([2, 1, 3]);
  });

  it("keeps accents (cased, no strip) — café is in vocab", () => {
    expect(real("café")).toEqual([2, 12, 3]);
  });

  it("pads to maxLen with attention mask 0 on the padding", () => {
    const enc = tok.encode("word", 6);
    expect(enc.inputIds).toEqual([2, 4, 3, 0, 0, 0]);
    expect(enc.attentionMask).toEqual([1, 1, 1, 0, 0, 0]);
  });

  it("truncates content to leave room for [CLS]/[SEP]", () => {
    // maxLen 4 → 2 content slots. "word word word" → [CLS, word, word, SEP].
    expect(tok.encode("word word word", 4).inputIds).toEqual([2, 4, 4, 3]);
  });

  it("spaces out CJK so each ideograph is its own token", () => {
    // Not in vocab → [UNK] each, but they must be SEPARATE tokens (2 unks), proving CJK splitting.
    expect(real("你好")).toEqual([2, 1, 1, 3]);
  });
});
