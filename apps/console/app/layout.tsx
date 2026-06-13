import type { ReactNode } from "react";
import { Nav } from "./nav";

export const metadata = {
  title: "Pharos — Trust control plane for AI agents",
  description: "Pharos decides. Pharos proves.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: "#0b0f17", color: "#e5e7eb", fontFamily: "ui-sans-serif, system-ui, sans-serif" }}>
        <div style={{ display: "flex" }}>
          <Nav />
          <main style={{ flex: 1, padding: "32px 40px", maxWidth: 1100 }}>{children}</main>
        </div>
      </body>
    </html>
  );
}
