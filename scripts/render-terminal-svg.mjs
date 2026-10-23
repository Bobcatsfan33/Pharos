#!/usr/bin/env node
// Render a committed transcript as a small, dependency-free animated SVG "terminal recording".
// Lines appear one after another (SMIL animate on opacity), so GitHub's README renders it as
// a playing recording without asciinema, a GIF encoder, or any binary asset. Deterministic:
// the same transcript always yields the same bytes, so the asset can be regenerated in CI.
//
//   node scripts/render-terminal-svg.mjs <transcript.txt> <out.svg> [--title "..."] [--max-lines N]
import { readFileSync, writeFileSync } from "node:fs";

const [, , input, output, ...rest] = process.argv;
if (!input || !output) {
  console.error(
    "usage: render-terminal-svg.mjs <transcript.txt> <out.svg> [--title t] [--max-lines n]",
  );
  process.exit(2);
}
const opt = (name, dflt) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : dflt;
};
const title = opt("--title", "pharos demo");
const maxLines = Number(opt("--max-lines", "60"));

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const raw = readFileSync(input, "utf8")
  .split(/\r?\n/)
  .filter((l) => !l.startsWith("#")) // the transcript's provenance header stays in the .txt
  .map((l) => l.replace(ANSI, "").replace(/\t/g, "    "));
while (raw.length && raw[0].trim() === "") raw.shift();
while (raw.length && raw[raw.length - 1].trim() === "") raw.pop();
const lines = raw.slice(0, maxLines);

const COLS = 96;
const CH = 7.8; // px per character at 13px monospace
const LH = 19;
const PAD = 16;
const width = Math.round(COLS * CH + PAD * 2);
const height = Math.round(lines.length * LH + PAD * 2 + 28);
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Colour by meaning, not by ANSI codes (the transcript is colour-free).
const colour = (l) => {
  const t = l.trimStart();
  if (t.startsWith("$ ")) return "#9cdcfe";
  if (/^(BLOCK|✘|✗)/.test(t)) return "#f48771";
  if (/^ESCALATE/.test(t)) return "#e5c07b";
  if (/^(ALLOW|✔)/.test(t)) return "#98c379";
  if (t.startsWith("──") || t.startsWith("Pharos demo") || t.startsWith("Next:")) return "#c678dd";
  if (t.startsWith("cited") || t.includes("  cited ")) return "#56b6c2";
  return "#d4d4d4";
};

// Timing: a prompt line "types" over ~0.9 s; output lines land in quick succession.
let t = 0.4;
const timed = lines.map((l) => {
  const isPrompt = l.trimStart().startsWith("$ ");
  const begin = t;
  t += isPrompt ? 0.9 : l.trim() === "" ? 0.08 : 0.16;
  return { l, begin, isPrompt };
});
const total = t + 2.5;

const body = timed
  .map(({ l, begin, isPrompt }, i) => {
    const y = PAD + 28 + i * LH;
    const text = esc(l.slice(0, COLS));
    const k1 = (begin / total).toFixed(4);
    const k2 = Math.min(1, (begin + (isPrompt ? 0.5 : 0.05)) / total).toFixed(4);
    const anim = `<animate attributeName="opacity" values="0;0;1" keyTimes="0;${k1};${k2}" dur="${total.toFixed(2)}s" fill="freeze" repeatCount="1"/>`;
    return `<text x="${PAD}" y="${y}" fill="${colour(l)}" opacity="0" xml:space="preserve">${text}${anim}</text>`;
  })
  .join("\n");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="13">
<title>${esc(title)}</title>
<rect width="100%" height="100%" rx="8" fill="#1e1e1e"/>
<circle cx="18" cy="16" r="5" fill="#ff5f56"/><circle cx="36" cy="16" r="5" fill="#ffbd2e"/><circle cx="54" cy="16" r="5" fill="#27c93f"/>
<text x="${width / 2}" y="20" text-anchor="middle" fill="#8b8b8b" font-size="12">${esc(title)}</text>
${body}
</svg>
`;
writeFileSync(output, svg);
console.log(
  `${output}: ${lines.length} lines, ${(Buffer.byteLength(svg) / 1024).toFixed(1)} KB, ${total.toFixed(1)}s`,
);
