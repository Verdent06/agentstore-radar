import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

// Latin-only static cuts of IBM Plex (OFL). Vendored so the production build
// does not download Google Fonts. CSS variables stay --font-sans / --font-mono.
const sans = localFont({
  src: [
    { path: "../fonts/ibm-plex-sans-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "../fonts/ibm-plex-sans-latin-500-normal.woff2", weight: "500", style: "normal" },
    { path: "../fonts/ibm-plex-sans-latin-600-normal.woff2", weight: "600", style: "normal" },
  ],
  variable: "--font-sans",
});

const mono = localFont({
  src: [
    { path: "../fonts/ibm-plex-mono-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "../fonts/ibm-plex-mono-latin-500-normal.woff2", weight: "500", style: "normal" },
  ],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: {
    default: "AgentStore Radar",
    template: "%s · AgentStore Radar",
  },
  description: "Public leaderboards and trends for MCP servers and AI agent stores. Aggregates only — no bulk history downloads.",
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "https://agentstore-radar.vercel.app"),
  openGraph: {
    siteName: "AgentStore Radar",
    type: "website",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `try{if(localStorage.getItem('radar-theme')==='light')document.documentElement.classList.add('light')}catch(e){}`,
          }}
        />
      </head>
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
