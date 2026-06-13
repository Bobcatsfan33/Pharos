import { type PolicyRule, type Condition } from "./rules.js";

/**
 * Policy compiler v1 — natural-language policy documents to candidate rule sets.
 *
 * A constrained, line-oriented grammar maps plain-English policy statements to declarative
 * rules, each with a confidence flag. Compilation NEVER auto-activates: output is candidate
 * rules requiring human approval, and the lifecycle requires a dry-run before activation.
 */
export interface CompileResult {
  rules: PolicyRule[];
  warnings: string[];
  /** Lines the compiler could not interpret (kept for the human reviewer). */
  unparsed: string[];
}

const SUBJECT_TO_ACTION: Array<[RegExp, string]> = [
  [/payments?|transfers?/i, "payment."],
  [/wires?/i, "wire."],
  [/emails?|messages?|communications?/i, "email."],
  [/exports?/i, "export"],
];

function subjectToCondition(subject: string): Condition | null {
  for (const [re, prefix] of SUBJECT_TO_ACTION) {
    if (re.test(subject)) return { field: "action.type", op: "startsWith", value: prefix };
  }
  return null;
}

const NUM = (s: string) => Number(s.replace(/[$,]/g, ""));

export function compilePolicy(packId: string, version: string, title: string, text: string): CompileResult {
  const rules: PolicyRule[] = [];
  const warnings: string[] = [];
  const unparsed: string[] = [];
  let n = 0;

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const rule = compileLine(packId, line, n);
    if (rule) {
      rules.push(rule);
      if ((rule.confidence ?? 1) < 0.8) warnings.push(`Low-confidence rule from: "${line}"`);
      n += 1;
    } else {
      unparsed.push(line);
    }
  }
  if (unparsed.length) warnings.push(`${unparsed.length} line(s) could not be interpreted and need manual rules.`);
  return { rules, warnings, unparsed };
}

function compileLine(packId: string, line: string, idx: number): PolicyRule | null {
  const id = `${packId}-r${idx + 1}`;

  // "Block/Escalate promissory|guaranteed-return language"
  let m = line.match(/^(block|escalate)\s+(promissory|guaranteed[- ]return)\s+language/i);
  if (m) {
    return rule(id, packId, m[1]!, { judge: "finra-promissory", gte: 0.5 }, `Tier-3 judge flags ${m[2]} language.`, "FINRA Rule 2210(d)(1)(B)", 0.9);
  }

  // "Block/Escalate PHI / protected health information"
  m = line.match(/^(block|escalate)\s+(phi|protected health information)/i);
  if (m) {
    return rule(id, packId, m[1]!, { judge: "phi-in-context", gte: 0.5 }, "Tier-3 judge flags PHI in message context.", "45 CFR 164.502(b)", 0.9);
  }

  // "Block/Escalate <subject> when amount over <N>"
  m = line.match(/^(block|escalate|modify)\s+(.+?)\s+when\s+amount\s+(?:over|above|exceeds|greater than|>=?)\s*\$?([\d,]+)/i);
  if (m) {
    const subj = subjectToCondition(m[2]!);
    const amount = NUM(m[3]!);
    const cond: Condition = subj
      ? { all: [subj, { field: "liability.blastRadius.financialAmount", op: "gt", value: amount }] }
      : { field: "liability.blastRadius.financialAmount", op: "gt", value: amount };
    return rule(id, packId, m[1]!, cond, `${m[2]} exceeding ${amount} are ${m[1]!.toLowerCase()}ed.`, undefined, subj ? 0.9 : 0.7);
  }

  // "Require human review/approval for <subject>"
  m = line.match(/^require human (?:review|approval) for (.+)/i);
  if (m) {
    const subj = subjectToCondition(m[1]!) ?? { field: "action.type", op: "contains", value: m[1]!.trim() };
    return rule(id, packId, "escalate", subj, `Human review required for ${m[1]}.`, undefined, 0.85);
  }

  // "Block/Escalate <subject> when <field> contains "<text>""
  m = line.match(/^(block|escalate)\s+(.+?)\s+when\s+(.+?)\s+(?:contains|includes|mentions)\s+"(.+)"/i);
  if (m) {
    return rule(id, packId, m[1]!, { field: `action.payload.${m[3]!.trim()}`, op: "contains", value: m[4]! }, `${m[2]} mentioning "${m[4]}".`, undefined, 0.6);
  }

  return null;
}

function rule(
  ruleId: string,
  pack: string,
  decisionWord: string,
  when: Condition,
  description: string,
  clause: string | undefined,
  confidence: number,
): PolicyRule {
  return {
    ruleId,
    pack,
    clause,
    description,
    when,
    decision: decisionWord.toLowerCase() as "block" | "escalate" | "modify",
    confidence,
  };
}
