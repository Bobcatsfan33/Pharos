import Link from "next/link";

/**
 * The merged information architecture: one left-nav with two sections.
 *   Beam   (Decide) — the runtime policy decision plane.
 *   Ledger (Prove)  — the evidence and liability plane.
 *
 * This replaces the two legacy consoles (AI Lighthouse, Flightline) with a single
 * canonical IA. Evidence and policy concepts that existed in both products are
 * unified here into one of each.
 */
const SECTIONS = [
  {
    title: "Beam — Decide",
    items: [
      { href: "/beam/verdicts", label: "Verdicts" },
      { href: "/beam/policies", label: "Policy packs" },
      { href: "/beam/review", label: "Review ops" },
    ],
  },
  {
    title: "Ledger — Prove",
    items: [
      { href: "/ledger/evidence", label: "Evidence explorer" },
      { href: "/ledger/chain", label: "Chain integrity" },
      { href: "/ledger/access-audit", label: "Access audit" },
    ],
  },
];

export function Nav() {
  return (
    <nav style={{ width: 240, borderRight: "1px solid #1f2937", padding: "24px 16px", minHeight: "100vh" }}>
      <Link href="/" style={{ textDecoration: "none" }}>
        <div style={{ fontWeight: 700, fontSize: 20, color: "#f9fafb", marginBottom: 4 }}>Pharos</div>
        <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 28 }}>Decide. Prove.</div>
      </Link>
      {SECTIONS.map((section) => (
        <div key={section.title} style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 1, color: "#6b7280", marginBottom: 8 }}>
            {section.title}
          </div>
          {section.items.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              style={{ display: "block", padding: "6px 8px", color: "#d1d5db", textDecoration: "none", fontSize: 14 }}
            >
              {item.label}
            </Link>
          ))}
        </div>
      ))}
    </nav>
  );
}
