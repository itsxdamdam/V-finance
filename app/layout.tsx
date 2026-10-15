import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "V-Finance",
  description:
    "V-Finance: multi-agent, profile-aware market signals with citations, on synthetic NSE data. Educational demo, not investment advice.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
