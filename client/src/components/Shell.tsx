// The frame: a navy icon rail that opens like the Dock (below), and on a phone a slim top bar whose
// menu opens the same navigation. Adding a deposition is open from every page.

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Briefcase, CircleHelp, FileText, Highlighter, LayoutGrid, ListChecks, Menu, Plus, X, type LucideIcon } from "lucide-react";
import { href, type Section } from "../lib/router";
import { cx } from "./ui";
import { AddDeposition } from "./AddDeposition";

const NAV: { id: Section; label: string; icon: LucideIcon; to: string }[] = [
  { id: "overview", label: "Overview", icon: LayoutGrid, to: href.overview() },
  { id: "cases", label: "Cases", icon: Briefcase, to: href.cases() },
  { id: "depositions", label: "Depositions", icon: FileText, to: href.depositions() },
  { id: "findings", label: "Findings", icon: Highlighter, to: href.findings() },
  { id: "analyses", label: "Analyses", icon: ListChecks, to: href.analyses() },
];

type AddContext = { open: (caseId?: number) => void };
const Add = createContext<AddContext>({ open: () => undefined });
export const useAddDeposition = () => useContext(Add);

// The logo's V, redrawn so it reads on navy: the stem in white, the second stroke in the logo's slate.
export function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 100 100" aria-hidden className={className}>
      <path d="M2 20h24.5a6 6 0 0 1 5.2 3L62 79l-6.4 19a3 3 0 0 1-5.4.5Z" fill="currentColor" />
      <path d="M74 2h24L63 72 50 46 69.7 4.4A4 4 0 0 1 74 2Z" fill="#8ea3c0" />
    </svg>
  );
}

// On desktop the sidebar is a slim rail of icons that opens over the page, like the Dock, when the
// pointer reaches the rail at the left edge, and closes when it leaves. Keyboard focus opens it too.
// Labels stay in the DOM, so screen readers and tooltips always have them.
const label = (rail: boolean) => cx("whitespace-nowrap", rail && "opacity-0 transition-opacity duration-150 group-hover/rail:opacity-100 group-focus-within/rail:opacity-100");

export function Shell({ section, children }: { section: Section | null; children: ReactNode }) {
  const [drawer, setDrawer] = useState(false);
  const [adding, setAdding] = useState<{ caseId?: number } | null>(null);
  useEffect(() => setDrawer(false), [section]);

  const row = (active: boolean) => cx("flex h-9 items-center gap-3 overflow-hidden rounded-md px-[13px] text-[14px] transition-colors", active ? "bg-navy-3 font-medium text-white" : "text-navy-ink hover:bg-navy-2 hover:text-white");

  const nav = (rail: boolean) => (
    <nav aria-label="Main" className="flex flex-1 flex-col gap-0.5 px-3">
      {NAV.map((n) => (
        <a key={n.id} href={n.to} aria-current={section === n.id ? "page" : undefined} onClick={() => setDrawer(false)} className={row(section === n.id)}>
          <n.icon aria-hidden className="size-[18px] flex-none" strokeWidth={1.6} />
          <span className={label(rail)}>{n.label}</span>
        </a>
      ))}
    </nav>
  );

  const footer = (rail: boolean) => (
    <div className="border-t border-white/10 px-3 py-3">
      <a href={href.help()} aria-current={section === "help" ? "page" : undefined} className={row(section === "help")}>
        <CircleHelp aria-hidden className="size-[18px] flex-none" strokeWidth={1.6} />
        <span className={label(rail)}>Help</span>
      </a>
    </div>
  );

  const addButton = (rail: boolean) => (
    <div className="px-3 pb-4">
      <button type="button" onClick={() => setAdding({})} className="flex h-9 w-full items-center gap-2.5 overflow-hidden rounded-md bg-white px-[13px] text-[13px] font-semibold text-navy transition-colors hover:bg-[#e6ebf3]">
        <Plus aria-hidden className="size-4 flex-none" strokeWidth={2} />
        <span className={label(rail)}>Add deposition</span>
      </button>
    </div>
  );

  const brand = (rail: boolean) => (
    <a href={href.overview()} className="flex h-16 flex-none items-center gap-2.5 overflow-hidden px-5 text-white">
      <Mark className="size-7 flex-none text-white" />
      <span className={cx("font-serif text-[22px] font-semibold tracking-[-0.01em]", label(rail))}>Veridict</span>
    </a>
  );

  return (
    <Add.Provider value={{ open: (caseId) => setAdding({ caseId }) }}>
      <div className="min-h-screen lg:flex">
        <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-sheet focus:px-3 focus:py-2">Skip to content</a>

        {/* Desktop: the rail keeps its 68px in the layout and opens over the page, never pushing it. */}
        <div aria-hidden className="hidden w-[68px] flex-none lg:block print:hidden" />
        <aside
          className="group/rail fixed inset-y-0 left-0 z-40 hidden w-[68px] flex-col overflow-hidden bg-navy transition-[width,box-shadow] delay-0 duration-200 ease-out hover:w-[232px] hover:delay-75 hover:shadow-[8px_0_32px_-8px_rgb(19_33_58/0.45)] focus-within:w-[232px] focus-within:shadow-[8px_0_32px_-8px_rgb(19_33_58/0.45)] lg:flex print:hidden"
        >
          {brand(true)}
          {addButton(true)}
          {nav(true)}
          {footer(true)}
        </aside>

        {/* Phone and tablet top bar */}
        <header className="sticky top-0 z-30 flex h-12 items-center justify-between bg-navy px-4 lg:hidden print:hidden">
          <a href={href.overview()} className="flex items-center gap-2 text-white">
            <Mark className="size-6 text-white" />
            <span className="font-serif text-lg font-semibold">Veridict</span>
          </a>
          <button type="button" onClick={() => setDrawer(true)} aria-label="Open menu" aria-expanded={drawer} className="-mr-2 rounded-md p-2 text-white hover:bg-navy-2">
            <Menu aria-hidden className="size-5" />
          </button>
        </header>
        {drawer && (
          <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal aria-label="Menu">
            <button type="button" aria-label="Close menu" onClick={() => setDrawer(false)} className="absolute inset-0 bg-navy/50" />
            <div className="absolute inset-y-0 left-0 flex w-[min(280px,85vw)] flex-col bg-navy">
              <div className="flex items-center justify-between pr-3">
                {brand(false)}
                <button type="button" onClick={() => setDrawer(false)} aria-label="Close menu" className="rounded-md p-2 text-white hover:bg-navy-2"><X aria-hidden className="size-5" /></button>
              </div>
              {addButton(false)}
              {nav(false)}
              {footer(false)}
            </div>
          </div>
        )}

        <main id="main" className="min-w-0 flex-1">
          <div className="mx-auto w-full max-w-[1320px] space-y-6 px-4 pt-6 pb-16 sm:px-8 lg:pt-8">{children}</div>
        </main>
      </div>
      <AddDeposition open={adding !== null} caseId={adding?.caseId} onClose={() => setAdding(null)} />
    </Add.Provider>
  );
}
