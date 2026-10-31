// The application frame: navy sidebar, top bar with search, and the standing reminder that findings
// are leads for review. On narrow screens the sidebar becomes a drawer.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ChartColumn, CircleHelp, ClipboardCheck, FileText, Folder, Gavel, LayoutGrid, ListChecks, Menu, Search, X, type LucideIcon } from "lucide-react";
import { cx } from "./ui";
import { href, type Route } from "../lib/router";
import { useWorkspace } from "../lib/workspace";

type NavItem = { label: string; icon: LucideIcon; link: string; names: Route["name"][] };
const WORKSPACE: NavItem[] = [
  { label: "Dashboard", icon: LayoutGrid, link: href.dashboard(), names: ["dashboard"] },
  { label: "Cases", icon: Folder, link: href.cases(), names: ["cases"] },
  { label: "Depositions", icon: FileText, link: href.depositions(), names: ["case", "depositions"] },
  { label: "Analyses", icon: ChartColumn, link: href.analyses(), names: ["analyses", "analysis"] },
  { label: "Findings", icon: ListChecks, link: href.findings(), names: ["findings"] },
  { label: "Review", icon: ClipboardCheck, link: href.review(), names: ["review"] },
];
const SYSTEM: NavItem[] = [
  { label: "Help", icon: CircleHelp, link: href.help(), names: ["help"] },
];

function NavLinks({ items, route }: { items: NavItem[]; route: Route["name"] }) {
  return (
    <ul className="flex flex-col gap-space-xs px-space-xs">
      {items.map((item) => {
        const active = item.names.includes(route);
        return (
          <li key={item.label}>
            <a href={item.link} aria-current={active ? "page" : undefined} className={cx("flex items-center gap-space-md rounded-lg px-space-md py-space-sm transition-colors focus-visible:outline-white", active ? "bg-white/10 font-semibold text-white" : "text-primary-fixed-dim hover:bg-white/5 hover:text-white")}>
              <item.icon aria-hidden className="size-5" strokeWidth={1.75} />
              {item.label}
            </a>
          </li>
        );
      })}
    </ul>
  );
}

const GroupLabel = ({ children }: { children: ReactNode }) => <p className="mb-space-xs px-space-lg text-label-sm tracking-wider text-on-primary-container">{children}</p>;

function Sidebar({ route, open, onClose }: { route: Route["name"]; open: boolean; onClose: () => void }) {
  return (
    <aside className={cx("fixed inset-y-0 left-0 z-50 flex w-60 flex-col justify-between overflow-y-auto bg-primary-container py-space-md transition-transform lg:translate-x-0", open ? "translate-x-0" : "invisible -translate-x-full lg:visible")}>
      <nav aria-label="Main">
        <div className="flex items-center justify-between px-space-md pb-space-lg">
          <a href={href.dashboard()} className="flex items-center gap-space-sm rounded-lg focus-visible:outline-white">
            <span className="flex size-8 items-center justify-center rounded-lg bg-secondary text-white">
              <Gavel aria-hidden className="size-5" strokeWidth={1.75} />
            </span>
            <span className="flex flex-col">
              <span className="text-headline-md tracking-tight text-white">Deposition</span>
              <span className="text-label-sm tracking-wider text-primary-fixed-dim">Checker</span>
            </span>
          </a>
          <button type="button" onClick={onClose} aria-label="Close navigation" className="rounded-lg p-1 text-primary-fixed-dim focus-visible:outline-white lg:hidden">
            <X aria-hidden className="size-5" />
          </button>
        </div>
        <GroupLabel>Workspace</GroupLabel>
        <NavLinks items={WORKSPACE} route={route} />
        <div className="mt-space-lg">
          <GroupLabel>System</GroupLabel>
          <NavLinks items={SYSTEM} route={route} />
        </div>
      </nav>
      <p className="px-space-lg pt-space-lg text-label-sm text-on-primary-container">Findings are leads for a person to review, not conclusions.</p>
    </aside>
  );
}

function GlobalSearch() {
  const { data } = useWorkspace();
  const [q, setQ] = useState("");
  const results = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term || !data) return [];
    return data.details.flatMap((d) => {
      const items = [{ key: `c${d.case.id}`, label: d.case.name, kind: "Case" }];
      d.witnesses.forEach((w) => items.push({ key: `w${w.id}`, label: w.name, kind: `Witness in ${d.case.name}` }));
      d.depositions.forEach((s) => s.originalFilename && items.push({ key: `d${s.id}`, label: s.originalFilename, kind: `File in ${d.case.name}` }));
      return items.filter((i) => i.label.toLowerCase().includes(term)).map((i) => ({ ...i, link: href.case(d.case.id) }));
    }).slice(0, 8);
  }, [q, data]);
  return (
    <search className="relative w-full max-w-lg">
      <Search aria-hidden className="absolute top-2.5 left-3 size-5 text-on-surface-variant" strokeWidth={1.75} />
      <input type="search" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setQ("")} aria-label="Search cases, witnesses or files" placeholder="Search cases, witnesses, or files..." className="h-10 w-full rounded-lg bg-surface-container-lowest pr-space-md pl-10 text-body-md shadow-sm outline-none placeholder:text-on-surface-variant focus:ring-2 focus:ring-secondary/30" />
      {q.trim() && (
        <div className="absolute inset-x-0 top-11 z-50 overflow-hidden rounded-lg bg-surface-container-lowest shadow-lg">
          {results.length === 0 && <p className="px-space-md py-3 text-body-sm text-on-surface-variant">{data ? "Nothing matches that search." : "Loading…"}</p>}
          <ul>
            {results.map((r) => (
              <li key={r.key}>
                <a href={r.link} onClick={() => setQ("")} className="block px-space-md py-2 hover:bg-surface-container-low">
                  <span className="block truncate font-medium">{r.label}</span>
                  <span className="block truncate text-label-sm text-on-surface-variant">{r.kind}</span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </search>
  );
}

export function Shell({ route, children }: { route: Route["name"]; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [route]);
  return (
    <div className="min-h-screen">
      <a href="#main" onClick={(e) => { e.preventDefault(); document.getElementById("main")?.focus(); }} className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[60] focus:rounded-lg focus:bg-surface-container-lowest focus:p-2">Skip to content</a>
      <Sidebar route={route} open={open} onClose={() => setOpen(false)} />
      {open && <div aria-hidden onClick={() => setOpen(false)} className="fixed inset-0 z-40 bg-primary-container/50 lg:hidden" />}
      <div className="flex min-h-screen flex-col lg:pl-60">
        <header className="sticky top-0 z-40 flex h-16 items-center gap-space-md bg-surface/90 px-4 shadow-[0_1px_8px_rgba(0,0,0,0.04)] backdrop-blur-xl sm:px-space-xl">
          <button type="button" onClick={() => setOpen(true)} aria-label="Open navigation" className="rounded-lg p-1 text-on-surface-variant hover:bg-surface-container-low lg:hidden">
            <Menu aria-hidden className="size-6" />
          </button>
          <GlobalSearch />
        </header>
        <main id="main" tabIndex={-1} className="w-full flex-1 px-4 py-space-lg outline-none sm:px-space-xl">
          <div className="mx-auto w-full max-w-7xl space-y-space-xl pb-space-xl">{children}</div>
        </main>
        <footer className="bg-surface-container-lowest px-space-xl py-space-sm text-center text-label-sm text-on-surface-variant">
          Quotations are shown verbatim from the stored transcript; text read by OCR is labelled and may differ from the scan. Assessments are labelled as model interpretation.
        </footer>
      </div>
    </div>
  );
}
