export default function Home() {
  return (
    <div>
      <h1 style={{ fontSize: 28, marginBottom: 8 }}>Pharos</h1>
      <p style={{ color: "#9ca3af", maxWidth: 640, lineHeight: 1.6 }}>
        The trust control plane for enterprise AI agents. Every consequential agent action passes through
        Pharos twice: once before it happens — a real-time policy verdict — and once after — a tamper-evident,
        cryptographically signed evidence record. The same event that governs the action becomes the proof of
        how it was governed.
      </p>
      <div style={{ display: "flex", gap: 16, marginTop: 28 }}>
        <Card title="Beam — Decide" body="Policy packs, the verdict cascade, and review operations. Deterministic, citation-backed verdicts under an 800ms budget." href="/beam/verdicts" />
        <Card title="Ledger — Prove" body="The evidence chain, risk profile, and claims packs. Litigation-grade proof of every decision, forever." href="/ledger/chain" />
      </div>
    </div>
  );
}

function Card({ title, body, href }: { title: string; body: string; href: string }) {
  return (
    <a href={href} style={{ flex: 1, border: "1px solid #1f2937", borderRadius: 12, padding: 20, textDecoration: "none", color: "inherit" }}>
      <div style={{ fontWeight: 600, marginBottom: 8 }}>{title}</div>
      <div style={{ color: "#9ca3af", fontSize: 14, lineHeight: 1.5 }}>{body}</div>
    </a>
  );
}
