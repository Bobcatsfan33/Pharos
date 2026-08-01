import type { ReactNode } from "react";
// The console's own declarations, extracted from inline style props so `style-src` can
// drop 'unsafe-inline' (#79). A nonce can never cover a style ATTRIBUTE.
import "./globals.css";
import { Nav } from "./nav";

export const metadata = {
  title: "Pharos — Trust control plane for AI agents",
  description: "Pharos decides. Pharos proves.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="m-0 bg-canvas c-fg font-family-ui-sans-serif-system-ui-sans-serif">
        <div className="display-flex">
          <Nav />
          <main className="flex-1 p-32px-40px maxw-1100">{children}</main>
        </div>
      </body>
    </html>
  );
}
