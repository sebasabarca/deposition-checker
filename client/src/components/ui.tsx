// Shared components, written with Tailwind directly. White sheets with a 1px edge on the grey
// canvas, a navy primary, pale status pairs; no shadows except on what floats.

import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { BadgeCheck, ChevronRight, CircleCheck, ScanText, Sparkles, UserRoundCheck, X, type LucideIcon } from "lucide-react";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

export type Tone = "neutral" | "active" | "good" | "warn" | "bad" | "accent" | "contradiction" | "compatible";
const TONES: Record<Tone, string> = {
  neutral: "bg-well text-muted ring-line",
  active: "bg-info-bg text-info ring-info/15",
  good: "bg-ok-bg text-ok ring-ok/15",
  warn: "bg-context-bg text-context ring-context/15",
  bad: "bg-conflict-bg text-conflict ring-conflict/15",
  accent: "bg-info-bg text-info ring-info/15",
  contradiction: "bg-conflict-bg text-conflict ring-conflict/15",
  compatible: "bg-well text-muted ring-line",
};
const DOTS: Record<Tone, string> = {
  neutral: "bg-faint",
  active: "bg-slate",
  good: "bg-ok",
  warn: "bg-context",
  bad: "bg-conflict",
  accent: "bg-slate",
  contradiction: "bg-conflict",
  compatible: "bg-faint",
};

export function Badge({ tone = "neutral", dot, icon: Icon, children, title }: { tone?: Tone; dot?: boolean; icon?: LucideIcon; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={cx("inline-flex h-[22px] w-fit flex-none items-center gap-1.5 whitespace-nowrap rounded px-2 text-xs font-medium ring-1 ring-inset", TONES[tone])}>
      {dot && <span aria-hidden className={cx("size-1.5 rounded-full", DOTS[tone], tone === "active" && "animate-pulse")} />}
      {Icon && <Icon aria-hidden className="size-3.5" strokeWidth={1.75} />}
      {children}
    </span>
  );
}

// The four kinds of statement the interface must never blur, each with its own mark.
export const ModelMark = ({ children = "Veridict's analysis" }: { children?: ReactNode }) => (
  <Badge tone="accent" icon={Sparkles} title="Written by Veridict's analysis. Not testimony and not a legal conclusion.">{children}</Badge>
);
export const TestimonyMark = () => <Badge tone="neutral" icon={BadgeCheck} title="Shown verbatim from the stored transcript lines">Verbatim testimony</Badge>;
export const OcrMark = () => <Badge tone="warn" icon={ScanText} title="Read from a picture of the page. A word may be misread: compare with the page image before quoting.">Scanned copy</Badge>;
export const VerifiedMark = ({ children = "Citation verified" }: { children?: ReactNode }) => <Badge tone="good" icon={CircleCheck} title="Checked by code against the stored transcript">{children}</Badge>;
export const HumanMark = ({ children }: { children: ReactNode }) => <Badge tone="neutral" icon={UserRoundCheck} title="A person's decision, not the model's">{children}</Badge>;

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export function buttonClass(variant: ButtonVariant = "primary", className?: string) {
  const styles = {
    primary: "bg-navy text-white hover:bg-navy-3 active:bg-navy-2 disabled:bg-control disabled:text-muted",
    secondary: "bg-sheet text-ink ring-1 ring-inset ring-control hover:bg-hover active:bg-rule disabled:text-faint",
    ghost: "text-ink hover:bg-rule active:bg-line disabled:text-faint",
    danger: "bg-sheet text-conflict ring-1 ring-inset ring-conflict/40 hover:bg-conflict-bg",
  }[variant];
  return cx("inline-flex h-8 flex-none items-center justify-center gap-1.5 rounded-md px-3 text-sm font-semibold whitespace-nowrap transition-colors duration-150 disabled:cursor-not-allowed", styles, className);
}

export function Button({ variant, className, type = "button", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return <button type={type} {...props} className={buttonClass(variant, className)} />;
}

export function Card({ children, className, as: Tag = "section" }: { children: ReactNode; className?: string; as?: "section" | "div" | "aside" }) {
  return <Tag className={cx("min-w-0 rounded-lg border border-line bg-sheet", className)}>{children}</Tag>;
}

export function CardHeader({ title, description, action, count }: { title: ReactNode; description?: ReactNode; action?: ReactNode; count?: number }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-rule px-5 py-3.5">
      <div className="min-w-0">
        <h2 className="flex items-baseline gap-2 text-md font-semibold">
          {title}
          {count !== undefined && <span className="text-sm font-normal text-faint tabular-nums">{count}</span>}
        </h2>
        {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export function PageHeader({ title, description, actions, above }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; above?: ReactNode }) {
  return (
    <header className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
      <div className="min-w-0">
        {above}
        <h1 className="font-serif text-xl font-semibold tracking-[-0.01em]">{title}</h1>
        {description && <p className="mt-1 max-w-3xl text-base text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

// The way back up, above a page's title: each level above this page as a link, in navy and underlined
// so it reads as navigation at a glance.
export function Breadcrumbs({ items }: { items: { label: string; href: string }[] }) {
  return (
    <nav aria-label="Breadcrumb" className="mb-2">
      <ol className="flex flex-wrap items-center gap-1 text-sm font-medium">
        {items.map((item, i) => (
          <li key={item.href} className="flex min-w-0 items-center gap-1">
            {i > 0 && <ChevronRight aria-hidden className="size-3.5 flex-none text-muted" />}
            <a href={item.href} className="-mx-1 max-w-80 truncate rounded px-1 py-0.5 text-navy-3 underline decoration-navy-3/30 underline-offset-4 transition-colors hover:bg-hover hover:text-navy hover:decoration-navy">{item.label}</a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

// Underline tabs on one rule, with each tab's count beside its label.
export function Tabs<T extends string>({ value, onChange, items, label }: { value: T; onChange: (v: T) => void; items: { id: T; label: string; count?: number }[]; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="flex gap-5 overflow-x-auto border-b border-line">
      {items.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={cx("-mb-px flex h-10 flex-none items-center gap-1.5 border-b-2 text-sm font-medium transition-colors", value === t.id ? "border-navy text-ink" : "border-transparent text-muted hover:text-ink")}
        >
          {t.label}
          {t.count !== undefined && <span className={cx("rounded px-1.5 text-xs tabular-nums", value === t.id ? "bg-navy text-white" : "bg-rule text-muted")}>{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

// A native <dialog>: the browser traps focus, closes on Escape and returns focus afterwards.
export function Dialog({ open, onClose, title, description, wide, size, children }: { open: boolean; onClose: () => void; title: string; description?: string; wide?: boolean; size?: "md" | "lg" | "xl"; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open) ref.current?.showModal();
    else ref.current?.close();
  }, [open]);
  const width = wide ? "max-w-7xl" : { md: "max-w-md", lg: "max-w-2xl", xl: "max-w-4xl" }[size ?? "md"];
  return (
    <dialog ref={ref} onClose={onClose} aria-label={title} className={cx("m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] rounded-xl bg-sheet font-sans text-ink shadow-[0_24px_64px_-12px_rgb(19_33_58/0.35)]", width)}>
      <div className="flex items-start justify-between gap-3 border-b border-rule px-6 py-4">
        <div className="min-w-0">
          <h2 className="font-serif text-lg font-semibold">{title}</h2>
          {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
        </div>
        <button type="button" onClick={onClose} aria-label="Close" className="-mr-1.5 rounded-md p-1.5 text-muted hover:bg-rule hover:text-ink">
          <X aria-hidden className="size-5" />
        </button>
      </div>
      {open && children}
    </dialog>
  );
}

export function Alert({ tone = "bad", title, children, action }: { tone?: "bad" | "warn" | "info"; title?: string; children: ReactNode; action?: ReactNode }) {
  const styles = { bad: "bg-conflict-bg text-conflict border-conflict/20", warn: "bg-context-bg text-context border-context/20", info: "bg-info-bg text-info border-info/15" }[tone];
  return (
    <div role={tone === "bad" ? "alert" : "status"} className={cx("flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3 text-sm", styles)}>
      <div className="min-w-0 flex-1 basis-64">
        {title && <p className="font-semibold">{title}</p>}
        <div className={title ? "mt-0.5" : ""}>{children}</div>
      </div>
      {action}
    </div>
  );
}

// An empty block keeps its frame and says the next step in one sentence.
export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-control px-6 py-8 text-center">
      <p className="font-semibold">{title}</p>
      {children && <div className="mx-auto mt-1 max-w-md text-sm text-muted">{children}</div>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

export function Field({ label, hint, children, htmlFor }: { label: string; hint?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="block text-sm">
      <label htmlFor={htmlFor} className="font-medium">{label}</label>
      <div className="mt-1.5">{children}</div>
      {hint && <p className="mt-1.5 text-xs text-faint">{hint}</p>}
    </div>
  );
}

// Width and height are left to the caller (no tailwind-merge here, so two widths would fight).
const controlClass = "block rounded-md border border-control bg-sheet px-3 text-base text-ink placeholder:text-faint focus:border-slate focus:outline-2 focus:outline-offset-0 focus:outline-slate/30";
export const inputClass = cx(controlClass, "h-9 w-full");
export const fieldClass = controlClass;
export const selectClass = cx(controlClass, "h-9 appearance-none bg-[url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' fill='none' stroke='%234f5866' stroke-width='1.5'%3E%3Cpath d='m4 6 4 4 4-4'/%3E%3C/svg%3E\")] bg-[right_0.6rem_center] bg-no-repeat pr-8");

// Loading keeps the final shape: grey bars where the rows will land.
export function Loading({ label = "Loading", rows = 4 }: { label?: string; rows?: number }) {
  return (
    <div aria-live="polite" aria-busy className="space-y-3 py-2">
      <span className="sr-only">{label}…</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-11 rounded-md bg-rule" style={{ opacity: 1 - i * 0.18 }} />
      ))}
    </div>
  );
}

export function Search({ value, onChange, label, className }: { value: string; onChange: (v: string) => void; label: string; className?: string }) {
  return (
    <div className={cx("relative", className)}>
      <svg aria-hidden viewBox="0 0 16 16" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 fill-none stroke-faint" strokeWidth="1.5"><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3" /></svg>
      <input type="search" value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} placeholder={label} className={cx(inputClass, "pl-9")} />
    </div>
  );
}

export const thClass = "h-9 whitespace-nowrap px-4 text-left text-xs font-medium text-faint first:pl-5 last:pr-5";
export const tdClass = "px-4 py-3 first:pl-5 last:pr-5";
export const rowClass = "border-t border-rule transition-colors hover:bg-hover";

export function Stat({ label, value, note, tone }: { label: string; value: ReactNode; note?: ReactNode; tone?: "bad" }) {
  return (
    <div className="min-w-0 px-5 py-4">
      <p className="text-xs text-faint">{label}</p>
      <p className={cx("mt-1 text-lg font-semibold tabular-nums", tone === "bad" && "text-conflict")}>{value}</p>
      {note && <p className="mt-0.5 truncate text-xs text-muted">{note}</p>}
    </div>
  );
}

// Evidence strength, out of 100, where a finding has one. Its meaning is explained on the finding.
export function Strength({ score, size = "sm" }: { score: number | null; size?: "sm" | "lg" }) {
  if (score === null) return null;
  const tone = score >= 75 ? "text-ink" : score >= 50 ? "text-muted" : "text-faint";
  return size === "lg" ? (
    <div className="flex-none text-right" title="Evidence strength: how well the cited testimony supports review, from fixed checks. Not a probability.">
      <p className="text-xs text-faint">Evidence strength</p>
      <p className={cx("text-xl font-semibold tabular-nums", tone)}>{score}<span className="text-sm font-normal text-faint"> / 100</span></p>
    </div>
  ) : (
    <span className={cx("font-sans text-[12px] font-semibold tabular-nums", tone)} title="Evidence strength, out of 100">{score}<span className="font-normal text-faint">/100</span></span>
  );
}

export type { LucideIcon };
export { cx };
