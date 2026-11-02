// The slim top bar, and nothing else: a lawyer moves down through Cases, Case, Report and Finding, and
// back up by the breadcrumb. Each page names its own place with <Crumbs>.

import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { Scale } from "lucide-react";
import { href } from "../lib/router";

const CRUMBS_ID = "breadcrumbs";

export type Crumb = { label: string; to?: string };

export function Crumbs({ items }: { items: Crumb[] }) {
  const target = document.getElementById(CRUMBS_ID);
  if (!target) return null;
  return createPortal(
    <ol className="flex min-w-0 items-center gap-2 text-label-md font-medium text-on-surface-variant">
      {items.map((c, i) => (
        <li key={`${c.label}${i}`} className="flex min-w-0 items-center gap-2">
          {i > 0 && <span aria-hidden className="text-outline-variant">/</span>}
          {c.to ? <a href={c.to} className="truncate hover:text-on-surface">{c.label}</a> : <span aria-current="page" className="truncate font-semibold text-on-surface">{c.label}</span>}
        </li>
      ))}
    </ol>,
    target,
  );
}

export function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="glass fixed inset-x-0 top-0 z-40 h-14 border-x-0 border-t-0 print:hidden">
        <div className="mx-auto flex h-full max-w-7xl items-center justify-between gap-4 px-4 sm:px-6">
          <a href={href.cases()} className="flex flex-none items-center gap-2 text-[15px] font-semibold tracking-tight">
            <span aria-hidden className="flex size-7 items-center justify-center rounded-lg bg-secondary text-white"><Scale className="size-4" /></span>
            <span className="max-sm:sr-only">Deposition Checker</span>
          </a>
          <nav id={CRUMBS_ID} aria-label="Breadcrumb" className="hidden min-w-0 flex-1 justify-center md:flex" />
          <a href={href.help()} className="flex-none text-label-md font-medium text-on-surface-variant hover:text-secondary">Help</a>
        </div>
      </header>
      <main className="mx-auto w-full max-w-7xl flex-1 space-y-space-lg px-4 pt-20 pb-12 sm:px-6">{children}</main>
    </div>
  );
}
