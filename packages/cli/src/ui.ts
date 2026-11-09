import { stripVTControlCharacters, styleText } from "node:util";

type Style = Parameters<typeof styleText>[0];

const colorEnabled = (): boolean =>
  !process.env.NO_COLOR &&
  process.env.FORCE_COLOR !== "0" &&
  (process.stdout.isTTY || process.env.FORCE_COLOR !== undefined);

/** Colour only when it will render; transcripts and pipes get plain text. */
export function paint(style: Style, text: string): string {
  return colorEnabled() ? styleText(style, text) : text;
}

export const bold = (t: string): string => paint("bold", t);
export const dim = (t: string): string => paint("dim", t);
export const green = (t: string): string => paint("green", t);
export const red = (t: string): string => paint("red", t);
export const yellow = (t: string): string => paint("yellow", t);
export const cyan = (t: string): string => paint("cyan", t);
export const magenta = (t: string): string => paint("magenta", t);

/** Verdicts carry their colour everywhere they are printed. */
export function decisionBadge(decision: string): string {
  const label = decision.toUpperCase().padEnd(8);
  switch (decision) {
    case "allow":
      return paint(["bold", "green"], label);
    case "block":
      return paint(["bold", "red"], label);
    case "escalate":
      return paint(["bold", "yellow"], label);
    case "modify":
      return paint(["bold", "magenta"], label);
    default:
      return bold(label);
  }
}

/** First 12 hex characters plus an ellipsis — enough to recognise, short enough to align. */
export function shortHash(hash: string, n = 12): string {
  return `${hash.slice(0, n)}…`;
}

export function heading(text: string): string {
  return `\n${paint(["bold", "cyan"], `── ${text}`)}\n`;
}

export function ok(text: string): string {
  return `${green("✔")} ${text}`;
}

export function fail(text: string): string {
  return `${red("✘")} ${text}`;
}

export function warn(text: string): string {
  return `${yellow("!")} ${text}`;
}

export function kv(key: string, value: string, width = 10): string {
  return `  ${dim(key.padEnd(width))} ${value}`;
}

/** Render rows with left-aligned columns; `widths` caps each column (truncating with …). */
export function table(rows: string[][], widths?: number[]): string {
  if (rows.length === 0) return "";
  const cols = Math.max(...rows.map((r) => r.length));
  const w: number[] = [];
  for (let c = 0; c < cols; c++) {
    const natural = Math.max(...rows.map((r) => visible(r[c] ?? "").length));
    w.push(widths?.[c] ? Math.min(natural, widths[c]!) : natural);
  }
  return rows
    .map((r) =>
      r
        .map((cell, c) => {
          const text = clip(cell, w[c]!);
          return text + " ".repeat(Math.max(0, w[c]! - visible(text).length));
        })
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

function visible(s: string): string {
  return stripVTControlCharacters(s);
}
function clip(s: string, width: number): string {
  const plain = visible(s);
  if (plain.length <= width) return s;
  // Styled cells are clipped on their plain text; the style is dropped rather than left unterminated.
  return `${plain.slice(0, Math.max(0, width - 1))}…`;
}

export function print(...lines: string[]): void {
  for (const line of lines) process.stdout.write(`${line}\n`);
}

export function printError(message: string): void {
  process.stderr.write(`${red("error:")} ${message}\n`);
}
