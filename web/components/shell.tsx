import Link from "next/link";
import { ThemeToggle } from "./theme";

const NAV = [
  { href: "/", label: "Home" },
  { href: "/charts/npm", label: "Charts" },
  { href: "/movers", label: "Movers" },
  { href: "/multi-store", label: "Multi-store" },
  { href: "/new", label: "New" },
  { href: "/categories", label: "Categories" },
  { href: "/answer-share", label: "Answer share" },
];

export function Shell({
  children,
  shot,
}: {
  children: React.ReactNode;
  shot?: boolean;
}) {
  return (
    <div className={shot ? "movers-shot min-h-screen" : "min-h-screen"}>
      <header className="sticky top-0 z-20 border-b border-line bg-[color:var(--bg)]/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-5 px-4 py-3">
          <Link href="/" className="flex items-baseline gap-2 font-medium tracking-tight">
            <span className="text-accent">●</span>
            <span>AgentStore Radar</span>
          </Link>
          <nav className="hidden items-center gap-3 text-sm text-muted md:flex">
            {NAV.map((item) => (
              <Link key={item.href} href={item.href} className="hover:text-ink">
                {item.label}
              </Link>
            ))}
          </nav>
          <form action="/search" className="site-search ml-auto flex min-w-0 flex-1 max-w-sm">
            <input
              name="q"
              type="search"
              placeholder="Search apps…"
              className="w-full rounded-md border border-line bg-elev px-3 py-1.5 text-sm outline-none placeholder:text-muted focus:border-accent"
            />
          </form>
          <ThemeToggle />
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-6 text-xs text-muted md:flex-row md:items-center md:justify-between">
          <p>Public aggregates only. Raw snapshot history stays in the private data repo.</p>
          <p>
            <a className="hover:text-ink" href="https://github.com/Verdent06/agentstore-radar">
              Source
            </a>
            {" · "}
            Sanctioned public APIs · MCP · Smithery · npm · GitHub · Gemini CLI · PyPI
          </p>
        </div>
      </footer>
    </div>
  );
}
