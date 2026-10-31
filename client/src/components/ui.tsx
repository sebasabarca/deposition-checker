// Shared components of the approved design, written with Tailwind directly (the app doesn't use
// Radix, so the shadcn generator isn't needed).

import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { BadgeCheck, CircleCheck, ScanText, Sparkles, UserRoundCheck, X, type LucideIcon } from "lucide-react";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

export type Tone = "neutral" | "active" | "good" | "warn" | "bad" | "accent" | "contradiction" | "compatible";
const TONES: Record<Tone, string> = {
  neutral: "bg-surface-container text-on-surface-variant",
  active: "bg-secondary-fixed text-on-secondary-fixed",
  good: "bg-success-container text-on-success-container",
  warn: "bg-warning-container text-on-warning-container",
  bad: "bg-error-container text-on-error-container",
  accent: "bg-surface-container-highest text-secondary",
  contradiction: "bg-error-container text-on-error-container",
  compatible: "bg-surface-container text-on-surface-variant",
};
const DOTS: Record<Tone, string> = {
  neutral: "bg-outline",
  active: "bg-secondary",
  good: "bg-success",
  warn: "bg-on-warning-container",
  bad: "bg-error",
  accent: "bg-secondary",
  contradiction: "bg-error",
  compatible: "bg-outline",
};

export function Badge({ tone = "neutral", dot, icon: Icon, children, title }: { tone?: Tone; dot?: boolean; icon?: LucideIcon; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={cx("inline-flex w-fit flex-none items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-label-sm font-semibold", TONES[tone])}>
      {dot && <span aria-hidden className={cx("size-1.5 rounded-full", DOTS[tone], tone === "active" && "animate-pulse")} />}
      {Icon && <Icon aria-hidden className="size-3.5" />}
      {children}
    </span>
  );
}

// The four kinds of statement the interface must never blur, each with its own mark.
export const ModelMark = ({ children = "Model interpretation" }: { children?: ReactNode }) => (
  <Badge tone="accent" icon={Sparkles} title="Written by the model. Not testimony and not a legal conclusion.">{children}</Badge>
);
export const TestimonyMark = () => <Badge tone="neutral" icon={BadgeCheck} title="Shown verbatim from the stored transcript lines">Original testimony</Badge>;
export const OcrMark = () => <Badge tone="warn" icon={ScanText} title="Read from a scan by OCR. The text may differ from the scan.">Read by OCR</Badge>;
export const VerifiedMark = ({ children = "Citation verified" }: { children?: ReactNode }) => <Badge tone="good" icon={CircleCheck} title="Checked by code against the stored transcript">{children}</Badge>;
export const HumanMark = ({ children }: { children: ReactNode }) => <Badge tone="neutral" icon={UserRoundCheck} title="A person's decision, not the model's">{children}</Badge>;

type ButtonVariant = "primary" | "secondary" | "ghost";
export function buttonClass(variant: ButtonVariant = "primary", className?: string) {
  const styles = {
    primary: "bg-secondary text-white shadow-sm hover:bg-secondary-container disabled:bg-outline-variant disabled:text-on-surface-variant",
    secondary: "bg-surface-container-lowest text-on-surface shadow-sm hover:bg-surface-container disabled:text-outline",
    ghost: "bg-surface-container-low text-secondary hover:bg-surface-container",
  }[variant];
  return cx("inline-flex h-9 flex-none items-center justify-center gap-1.5 rounded-lg px-3.5 text-body-sm font-semibold transition-colors disabled:cursor-not-allowed", styles, className);
}

export function Button({ variant, className, type = "button", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return <button type={type} {...props} className={buttonClass(variant, className)} />;
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cx("min-w-0 rounded-xl bg-surface-container-lowest shadow-sm", className)}>{children}</section>;
}

export function CardHeader({ title, description, action }: { title: ReactNode; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 p-space-lg pb-space-md">
      <div className="min-w-0">
        <h2 className="text-headline-md">{title}</h2>
        {description && <p className="mt-0.5 text-body-sm text-on-surface-variant">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export function PageHeader({ title, description, actions, above }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; above?: ReactNode }) {
  return (
    <div className="flex flex-col justify-between gap-space-md lg:flex-row lg:items-end">
      <div className="min-w-0 space-y-space-xs">
        {above}
        <h1 className="text-headline-lg text-balance sm:text-headline-xl">{title}</h1>
        {description && <p className="max-w-3xl text-on-surface-variant">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-space-sm">{actions}</div>}
    </div>
  );
}

export function Metric({ icon: Icon, value, label, note, tone }: { icon: LucideIcon; value: ReactNode; label: string; note?: ReactNode; tone?: "bad" }) {
  return (
    <div className="flex items-center gap-space-lg rounded-xl bg-surface-container-lowest p-space-lg shadow-sm">
      <div className={cx("flex size-12 flex-none items-center justify-center rounded-xl", tone === "bad" ? "bg-error-container/40 text-error" : "bg-surface-container-low text-secondary")}>
        <Icon aria-hidden className="size-6" strokeWidth={1.75} />
      </div>
      <div className="min-w-0">
        <p className={cx("text-stat-metric tabular-nums", tone === "bad" && "text-error")}>{value}</p>
        <p className="text-body-sm font-medium text-on-surface-variant">{label}</p>
        {note && <p className="mt-0.5 text-label-sm text-outline">{note}</p>}
      </div>
    </div>
  );
}

export function Meter({ value, label, tone }: { value: number; label: string; tone?: "bad" }) {
  const pct = Math.round(value * 100);
  return (
    <div className="flex w-28 items-center gap-space-sm">
      <div role="progressbar" aria-label={label} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} className="h-2 flex-1 overflow-hidden rounded-full bg-surface-container">
        <div className={cx("h-full rounded-full", tone === "bad" ? "bg-error" : "bg-secondary")} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-9 text-right text-label-sm font-semibold tabular-nums">{pct}%</span>
    </div>
  );
}

export function TabButton({ active, onClick, count, children }: { active: boolean; onClick: () => void; count: number; children: ReactNode }) {
  return (
    <button type="button" aria-pressed={active} onClick={onClick} className={cx("flex h-8 items-center gap-1.5 rounded-lg px-space-md text-body-sm font-semibold transition-colors", active ? "bg-on-surface text-surface shadow-sm" : "text-on-surface-variant hover:bg-surface-container hover:text-on-surface")}>
      {children}
      <span className={cx("rounded-full px-1.5 text-label-sm tabular-nums", active ? "bg-white/20" : "bg-surface-container")}>{count}</span>
    </button>
  );
}

// A native <dialog>: the browser traps focus, closes on Escape and returns focus afterwards.
export function Dialog({ open, onClose, title, wide, children }: { open: boolean; onClose: () => void; title: string; wide?: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open) ref.current?.showModal();
    else ref.current?.close();
  }, [open]);
  return (
    <dialog ref={ref} onClose={onClose} aria-label={title} className={cx("m-auto w-[calc(100%-2rem)] rounded-xl bg-surface-container-lowest font-sans text-on-surface shadow-xl", wide ? "max-w-7xl" : "max-w-md")}>
      <div className="flex items-center justify-between gap-3 p-space-lg pb-0">
        <h2 className="text-headline-md">{title}</h2>
        <button type="button" onClick={onClose} aria-label="Close" className="rounded-lg p-1 text-on-surface-variant hover:bg-surface-container">
          <X aria-hidden className="size-5" />
        </button>
      </div>
      {open && children}
    </dialog>
  );
}

export function Alert({ tone = "bad", title, children }: { tone?: "bad" | "warn" | "info"; title?: string; children: ReactNode }) {
  const styles = { bad: "bg-error-container text-on-error-container", warn: "bg-warning-container text-on-warning-container", info: "bg-surface-container text-on-surface" }[tone];
  return (
    <div role={tone === "bad" ? "alert" : "status"} className={cx("rounded-lg px-space-md py-3 text-body-sm", styles)}>
      {title && <p className="font-semibold">{title}</p>}
      <div className={title ? "mt-1" : ""}>{children}</div>
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg bg-surface-container-low px-6 py-10 text-center">
      <p className="font-semibold">{title}</p>
      {children && <div className="mt-1 text-body-sm text-on-surface-variant">{children}</div>}
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block text-body-sm">
      <span className="font-medium">{label}</span>
      <div className="mt-1">{children}</div>
      {hint && <span className="mt-1 block text-label-sm text-on-surface-variant">{hint}</span>}
    </label>
  );
}

export const inputClass = "block h-10 w-full rounded-lg bg-surface-container-low px-space-md text-body-md text-on-surface placeholder:text-on-surface-variant focus:outline-2 focus:outline-secondary";

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <p className="py-10 text-center text-body-sm text-on-surface-variant" aria-live="polite">
      {label}
    </p>
  );
}

export const thClass = "whitespace-nowrap px-space-lg py-space-md text-label-md";
export const tdClass = "px-space-lg py-space-md";

export { cx };
