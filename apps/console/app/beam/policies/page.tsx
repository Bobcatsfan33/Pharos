export default function PoliciesPage() {
  return (
    <div>
      <h1 style={{ fontSize: 24 }}>Policy packs</h1>
      <p style={{ color: "#9ca3af", maxWidth: 640, lineHeight: 1.6 }}>
        Citation-level regulation packs power the verdict cascade. The <strong>core</strong> pack ships in
        Sprint 0 (mandate-limit enforcement, expiry, deny lists). Citation-level FINRA and HIPAA packs, the
        natural-language policy compiler, and the full policy lifecycle (draft → shadow → dry-run → active →
        rollback) arrive in Sprint 6 (Codex).
      </p>
      <div style={{ marginTop: 20, border: "1px solid #1f2937", borderRadius: 12, padding: 20 }}>
        <div style={{ fontWeight: 600 }}>core</div>
        <div style={{ color: "#9ca3af", fontSize: 14, marginTop: 6 }}>
          Tier-1 deterministic rules: <code>mandate-limit-exceeded</code>, <code>mandate-expired</code>,
          <code> action-type-blocked</code>, <code>irreversible-oversight</code>.
        </div>
      </div>
    </div>
  );
}
