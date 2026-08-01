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
      { href: "/ledger/risk-profile", label: "Risk profile" },
      { href: "/ledger/claims-packs", label: "Claims packs" },
      { href: "/ledger/access-audit", label: "Access audit" },
    ],
  },
];

export function Nav() {
  return (
    <nav className="w-240 border-right-1px-solid-1f2937 p-24px-16px minh-100vh">
      <Link href="/" className="text-decoration-none">
        <div className="fw-700 fs-20 c-strong mb-4">Pharos</div>
        <div className="fs-12 c-dim mb-28">Decide. Prove.</div>
      </Link>
      {SECTIONS.map((section) => (
        <div key={section.title} className="mb-24">
          <div className="fs-11 text-transform-uppercase ls-1 c-dim mb-8">{section.title}</div>
          {section.items.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="display-block p-6px-8px c-body text-decoration-none fs-14"
            >
              {item.label}
            </Link>
          ))}
        </div>
      ))}
    </nav>
  );
}
