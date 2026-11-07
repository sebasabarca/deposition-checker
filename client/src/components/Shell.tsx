// The frame: a navy icon rail that opens like the Dock (below), and on a phone a slim top bar whose
// menu opens the same navigation. Adding a deposition is open from every page.

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Briefcase, Check, CircleHelp, FileText, Highlighter, LayoutGrid, ListChecks, LogOut, Menu, Plus, UserRound, X, type LucideIcon } from "lucide-react";
import { href, type Section } from "../lib/router";
import { api, type User } from "../lib/api";
import { cx } from "./ui";
import { AddDeposition } from "./AddDeposition";
import { Tour, TOUR } from "./Tour";

const NAV: { id: Section; label: string; icon: LucideIcon; to: string }[] = [
  { id: "overview", label: "Overview", icon: LayoutGrid, to: href.overview() },
  { id: "cases", label: "Cases", icon: Briefcase, to: href.cases() },
  { id: "depositions", label: "Depositions", icon: FileText, to: href.depositions() },
  { id: "findings", label: "Findings", icon: Highlighter, to: href.findings() },
  { id: "analyses", label: "Analyses", icon: ListChecks, to: href.analyses() },
];

type AddContext = { open: (caseId?: number) => void };
const TourContext = createContext<() => void>(() => undefined);
export const useTour = () => useContext(TourContext);
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
const label = (rail: boolean) => cx("whitespace-nowrap", rail && "opacity-0 transition-opacity duration-150 group-hover/rail:opacity-100 group-focus-within/rail:opacity-100 group-data-[tour=true]/rail:opacity-100");

export function Shell({ section, user, onSignOut, onUser, children }: { section: Section | null; user: User; onSignOut: () => void; onUser: (u: User) => void; children: ReactNode }) {
  const [drawer, setDrawer] = useState(false);
  const [adding, setAdding] = useState<{ caseId?: number } | null>(null);
  // The first-run tour starts once for a new account; Help can replay it any time.
  const [touring, setTouring] = useState(false);
  useEffect(() => {
    if (user.onboarded || user.guest) return; // the demo opens straight on the work, without the first-run tour
    const t = window.setTimeout(() => setTouring(true), 500);
    return () => window.clearTimeout(t);
  }, [user.onboarded]);
  const endTour = () => {
    setTouring(false);
    if (!user.onboarded) api.markOnboarded().then(() => onUser({ ...user, onboarded: true })).catch(() => undefined);
  };
  useEffect(() => setDrawer(false), [section]);

  const row = (active: boolean) => cx("flex h-9 items-center gap-3 overflow-hidden rounded-md px-[13px] text-[14px] transition-colors", active ? "bg-navy-3 font-medium text-white" : "text-navy-ink hover:bg-navy-2 hover:text-white");

  const nav = (rail: boolean) => (
    <nav aria-label="Main" className="flex flex-1 flex-col gap-0.5 px-3">
      {NAV.map((n) => (
        <a key={n.id} href={n.to} data-tour={`nav-${n.id}`} aria-current={section === n.id ? "page" : undefined} onClick={() => setDrawer(false)} className={row(section === n.id)}>
          <n.icon aria-hidden className="size-[18px] flex-none" strokeWidth={1.6} />
          <span className={label(rail)}>{n.label}</span>
        </a>
      ))}
    </nav>
  );

  // A running analysis follows the user to every page: "Analyzing" while it runs, then "Findings ready"
  // until it's opened. Polled from the case list, which says which case is being analyzed.
  const checks = useRunningChecks(section);
  const checkPill = (rail: boolean) =>
    checks.state === "idle" ? null : (
      <div className="px-3 pb-2">
        <a href={href.caseRun(checks.analysisId)} onClick={checks.seen} className={cx("flex h-9 items-center gap-3 overflow-hidden rounded-md px-[13px] text-[13px] font-medium", checks.state === "running" ? "bg-navy-2 text-white" : "bg-ok text-white")} title={checks.state === "running" ? "An analysis is running" : "An analysis has finished"}>
          <span aria-hidden className="flex size-[18px] flex-none items-center justify-center">
            {checks.state === "running" ? <span className="size-2.5 animate-pulse rounded-full bg-[#8ea3c0]" /> : <Check className="size-4" strokeWidth={2.5} />}
          </span>
          <span className={label(rail)}>{checks.state === "running" ? "Analyzing…" : "Findings ready"}</span>
        </a>
      </div>
    );

  const footer = (rail: boolean) => (
    <div className="space-y-0.5 border-t border-white/10 px-3 py-3">
      <a href={href.help()} data-tour="help" aria-current={section === "help" ? "page" : undefined} className={row(section === "help")}>
        <CircleHelp aria-hidden className="size-[18px] flex-none" strokeWidth={1.6} />
        <span className={label(rail)}>Help</span>
      </a>
      <AccountMenu user={user} rail={rail} onSignOut={onSignOut} className={row(false)} label={label(rail)} />
    </div>
  );

  const addButton = (rail: boolean) => (
    <div className="px-3 pb-4">
      <button type="button" data-tour="add" onClick={() => setAdding({})} className="flex h-9 w-full items-center gap-2.5 overflow-hidden rounded-md bg-white px-[13px] text-[13px] font-semibold text-navy transition-colors hover:bg-[#e6ebf3]">
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
    <TourContext.Provider value={() => setTouring(true)}>
      <div className="min-h-screen lg:flex">
        <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-sheet focus:px-3 focus:py-2">Skip to content</a>

        {/* Desktop: the rail keeps its 68px in the layout and opens over the page, never pushing it.
            Open, it gets a light edge and a dark shadow so it stays a separate layer even over navy panels. */}
        <div aria-hidden className="hidden w-[68px] flex-none lg:block print:hidden" />
        <aside
          data-tour={touring}
          className="group/rail fixed inset-y-0 left-0 z-40 hidden w-[68px] data-[tour=true]:w-[232px] flex-col overflow-hidden bg-navy transition-[width,box-shadow] delay-0 duration-200 ease-out hover:w-[232px] hover:delay-75 hover:shadow-[inset_-1px_0_0_rgb(255_255_255/0.14),16px_0_40px_-10px_rgb(0_0_0/0.6)] focus-within:w-[232px] focus-within:shadow-[inset_-1px_0_0_rgb(255_255_255/0.14),16px_0_40px_-10px_rgb(0_0_0/0.6)] lg:flex print:hidden"
        >
          {brand(true)}
          {!user.guest && addButton(true)}
          {nav(true)}
          {checkPill(true)}
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
              {!user.guest && addButton(false)}
              {nav(false)}
              {checkPill(false)}
              {footer(false)}
            </div>
          </div>
        )}

        <main id="main" className="min-w-0 flex-1">
          <div className="mx-auto w-full max-w-[1320px] space-y-6 px-4 pt-6 pb-16 sm:px-8 lg:pt-8">
            {user.guest && <DemoBanner />}
            {!user.emailVerified && !user.guest && <VerifyBanner email={user.email} onRefresh={() => api.me().then((r) => onUser(r.user)).catch(() => undefined)} />}
            {children}
          </div>
        </main>
      </div>
      <AddDeposition open={adding !== null} caseId={adding?.caseId} onClose={() => setAdding(null)} />
      {touring && <Tour steps={TOUR} onDone={endTour} />}
    </TourContext.Provider>
    </Add.Provider>
  );
}

// Until the address is verified, uploading and checking are off (the server enforces it too).
function VerifyBanner({ email, onRefresh }: { email: string; onRefresh: () => void }) {
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const resend = () => {
    setBusy(true);
    api.resendVerification().then((r) => setNote(r.message)).catch((e: Error) => setNote(e.message)).finally(() => setBusy(false));
  };
  return (
    <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-context/20 bg-context-bg px-4 py-3 text-sm text-context">
      <p className="min-w-0 flex-1 basis-72">
        <strong className="font-semibold">Verify your email to add depositions and run checks.</strong> We sent a link to {email}. {note}
      </p>
      <div className="flex gap-2">
        <button type="button" onClick={onRefresh} className="h-8 rounded-md px-2.5 font-semibold hover:bg-context/10">I've verified</button>
        <button type="button" disabled={busy} onClick={resend} className="h-8 rounded-md bg-sheet px-3 font-semibold text-ink ring-1 ring-inset ring-context/30 hover:bg-hover disabled:opacity-60">{busy ? "Sending…" : "Send a new link"}</button>
      </div>
    </div>
  );
}

// The account button at the foot of the sidebar: a small menu with the profile and sign-out.
// The public demo (guest mode): what this is, on every page, so nobody takes a hidden control for a missing feature.
function DemoBanner() {
  return (
    <div role="note" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-info/15 bg-info-bg px-4 py-2.5 text-sm text-info">
      <span className="font-semibold">Read-only demo</span>
      <span>A finished analysis of real deposition testimony. Look around freely: findings, testimony, the report. Uploading, analyzing and decisions are turned off.</span>
    </div>
  );
}

function AccountMenu({ user, rail, onSignOut, className, label }: { user: User; rail: boolean; onSignOut: () => void; className: string; label: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  const item = "flex h-9 w-full items-center gap-2.5 rounded-md px-3 text-left text-sm text-ink hover:bg-hover";
  return (
    <div ref={root} className="relative" data-tour="account">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} className={cx(className, "w-full")} title={rail ? user.email : undefined}>
        <span aria-hidden className="-mx-[3px] flex size-6 flex-none items-center justify-center rounded-full bg-slate text-[11px] font-semibold text-white">{user.name.trim().charAt(0).toUpperCase()}</span>
        <span className={cx("min-w-0 text-left leading-tight", label)}>
          <span className="block truncate text-[13px] text-white">{user.name}</span>
          <span className="block truncate text-[11px]">{user.email}</span>
        </span>
      </button>
      {open && (
        <div role="menu" className="fixed bottom-3 left-[76px] z-50 w-64 rounded-lg border border-line bg-sheet p-1.5 text-ink shadow-[0_16px_40px_-12px_rgb(19_33_58/0.4)] max-lg:bottom-16 max-lg:left-4">
          <div className="border-b border-rule px-3 pt-2 pb-2.5">
            <p className="truncate font-semibold">{user.name}</p>
            <p className="truncate text-xs text-muted">{user.email}</p>
          </div>
          <div className="pt-1.5">
            {!user.guest && <a role="menuitem" href={href.profile()} onClick={() => setOpen(false)} className={item}><UserRound aria-hidden className="size-4 text-muted" />Profile</a>}
            <button role="menuitem" type="button" onClick={() => { setOpen(false); onSignOut(); }} className={item}><LogOut aria-hidden className="size-4 text-muted" />{user.guest ? "Leave the demo" : "Sign out"}</button>
          </div>
        </div>
      )}
    </div>
  );
}

// Which check is running for this account, and whether one finished since it was last looked at.
function useRunningChecks(section: Section | null) {
  const [running, setRunning] = useState<number | null>(null);
  const [ready, setReady] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    let last: number | null = null;
    const poll = () =>
      api.cases().then(({ cases }) => {
        if (!alive) return;
        const busy = cases.find((c) => c.checking && c.lastAnalysis);
        const id = busy?.lastAnalysis?.id ?? null;
        if (last !== null && id === null) setReady(last);
        last = id;
        setRunning(id);
      }).catch(() => undefined);
    poll();
    const t = window.setInterval(poll, 8000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);
  // The tab title says so too, for someone working in another tab.
  useEffect(() => {
    const base = document.title.replace(/^(Checking… · |Analyzing… · |Findings ready · )/, "");
    document.title = running !== null ? `Analyzing… · ${base}` : ready !== null ? `Findings ready · ${base}` : base;
  }, [running, ready, section]);
  const seen = () => setReady(null);
  if (running !== null) return { state: "running" as const, analysisId: running, seen };
  if (ready !== null) return { state: "ready" as const, analysisId: ready, seen };
  return { state: "idle" as const, analysisId: 0, seen };
}
