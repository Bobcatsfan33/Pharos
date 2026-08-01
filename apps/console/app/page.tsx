export default function Home() {
  return (
    <div>
      <h1 className="fs-28 mb-8">Pharos</h1>
      <p className="c-muted maxw-640 lh-1-6">
        The trust control plane for enterprise AI agents. Every consequential agent action passes
        through Pharos twice: once before it happens — a real-time policy verdict — and once after —
        a tamper-evident, cryptographically signed evidence record. The same event that governs the
        action becomes the proof of how it was governed.
      </p>
      <div className="display-flex gap-16 mt-28">
        <Card
          title="Beam — Decide"
          body="Policy packs, the verdict cascade, and review operations. Deterministic, citation-backed verdicts under an 800ms budget."
          href="/beam/verdicts"
        />
        <Card
          title="Ledger — Prove"
          body="The evidence chain, risk profile, and claims packs. Litigation-grade proof of every decision, forever."
          href="/ledger/chain"
        />
      </div>
    </div>
  );
}

function Card({ title, body, href }: { title: string; body: string; href: string }) {
  return (
    <a
      href={href}
      className="flex-1 border-1px-solid-1f2937 radius-12 p-20 text-decoration-none c-inherit"
    >
      <div className="fw-600 mb-8">{title}</div>
      <div className="c-muted fs-14 lh-1-5">{body}</div>
    </a>
  );
}
