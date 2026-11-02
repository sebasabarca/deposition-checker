// The public landing page, for visitors who aren't signed in. It demonstrates the product as you
// scroll: the app rising into view, a stack of transcript pages narrowing to one line, two sessions
// sliding together with the conflicting lines highlighted, and the review, step by step. Every
// picture is the real app on a synthetic deposition; no figures, customers or quotes are invented.

import { useEffect, useRef, type ReactNode } from "react";
import { ArrowRight, Check, FileText, Lock, ReceiptText, ShieldCheck } from "lucide-react";
import { Mark } from "../components/Shell";
import { cx } from "../components/ui";
import { href } from "../lib/router";
import "./landing.css";

// Scroll progress through a scene, written to --p on the element once per frame. Only on wide
// screens that allow motion; elsewhere the scene keeps --p: 1, its finished state. Progress starts
// as the scene enters from the bottom of the screen (not when it reaches the top), so nothing scrolls
// into view still invisible; the hero, already on screen, counts from the top.
function useScene<T extends HTMLElement>(onProgress?: (el: T) => void, { fromTop = false } = {}) {
  const ref = useRef<T>(null);
  const progress = useRef(onProgress);
  progress.current = onProgress;
  useEffect(() => {
    const el = ref.current;
    const motion = window.matchMedia("(min-width: 900px) and (prefers-reduced-motion: no-preference)");
    if (!el) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      if (!motion.matches) return void el.style.removeProperty("--p");
      const r = el.getBoundingClientRect();
      const stage = el.firstElementChild as HTMLElement;
      const pinTop = parseFloat(getComputedStyle(stage).top) || 0;
      const start = fromTop ? 0 : window.innerHeight; // where the scene's top is when progress is 0
      // Progress ends as the pin releases: when the scene's bottom reaches the stage's bottom.
      const total = start + r.height - stage.offsetHeight - pinTop;
      el.style.setProperty("--p", (total > 0 ? Math.min(1, Math.max(0, (start - r.top) / total)) : 1).toFixed(4));
      progress.current?.(el);
    };
    const queue = () => void (frame ||= requestAnimationFrame(update));
    update();
    window.addEventListener("scroll", queue, { passive: true });
    window.addEventListener("resize", queue);
    motion.addEventListener("change", queue);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", queue);
      window.removeEventListener("resize", queue);
      motion.removeEventListener("change", queue);
    };
  }, [fromTop]);
  return ref;
}

const seg = (from: number, span: number) => ({ "--from": from, "--span": span }) as React.CSSProperties;

// The synthetic Webb testimony, exactly as the app stores it (page:line, one row per line).
const EARLIER = [
  ["11:13", "phase b together in July."],
  ["11:14", "Q. Where were you on the evening of November 3rd?"],
  ["11:15", "A. I was at home all evening. I ordered pizza around 7pm", true],
  ["11:16", "and watched TV.", true],
  ["11:17", "Q. Who handled the warehouse lease phase c in April?"],
] as const;
const LATER = [
  ["41:12", "month."],
  ["41:13", "Q. Walk me through the evening of November 3rd again."],
  ["41:14", "A. I was home. I think I went out briefly to get some", true],
  ["41:15", "groceries, maybe around 7:30, but came right back.", true],
  ["41:16", "Q. Who handled the warehouse lease phase c in April?"],
] as const;
const CITATION = "Webb Dep. 11:15–11:16 (Mar. 14, 2023); compare Webb Dep. 41:14–41:15 (Sept. 9, 2023).";

export function LandingPage() {
  useEffect(() => {
    document.title = "Veridict: catch the contradiction before trial";
    return () => void (document.title = "Veridict");
  }, []);
  return (
    <div className="bg-canvas text-ink">
      <Nav />
      <Hero />
      <Problem />
      <SideBySide />
      <Proof />
      <HowItWorks />
      <Trust />
      <Close />
    </div>
  );
}

function Nav() {
  return (
    <header className="fixed inset-x-0 top-0 z-40 bg-navy/95 print:hidden">
      <div className="mx-auto flex h-14 max-w-[1240px] items-center justify-between gap-2 px-4 sm:gap-4 sm:px-8">
        <a href={href.overview()} className="flex items-center gap-2 text-white">
          <Mark className="size-6 text-white" />
          <span className="font-serif text-xl font-semibold">Veridict</span>
          <span className="ml-1 hidden rounded-sm border border-white/25 px-1.5 py-px text-[11px] text-navy-ink sm:inline">Early access</span>
        </a>
        <nav className="flex items-center gap-1 text-sm">
          <a href="#how" onClick={(e) => { e.preventDefault(); document.getElementById("how")?.scrollIntoView({ behavior: "smooth" }); }} className="hidden h-9 items-center rounded-md px-3 text-navy-ink hover:text-white md:flex">How it works</a>
          <a href="#trust" onClick={(e) => { e.preventDefault(); document.getElementById("trust")?.scrollIntoView({ behavior: "smooth" }); }} className="hidden h-9 items-center rounded-md px-3 text-navy-ink hover:text-white md:flex">Security</a>
          <a href={href.signin()} className="flex h-9 items-center rounded-md px-2.5 text-white hover:bg-navy-2 sm:px-3">Sign in</a>
          <a href={href.register()} className="ml-1 flex h-9 items-center rounded-md bg-white px-3 font-semibold text-navy hover:bg-[#e6ebf3] sm:px-3.5">Get started</a>
        </nav>
      </div>
    </header>
  );
}

function Hero() {
  // The product rises to just under the navigation as the headline fades, so no empty band opens up.
  const shot = useRef<HTMLDivElement>(null);
  const ref = useScene<HTMLElement>(() => {
    const el = shot.current;
    if (el) el.style.setProperty("--rise-to", `${Math.max(0, el.offsetTop - 80)}px`);
  }, { fromTop: true });
  return (
    <section ref={ref} className="scene bg-navy text-white" style={{ "--length": "170vh" } as React.CSSProperties}>
      <div className="stage full flex flex-col items-center px-5 pt-28 pb-16 sm:px-8 min-[900px]:pt-[14vh] min-[900px]:pb-0">
        <div className="seg hero-copy w-full max-w-[1100px] text-center" style={seg(0, 0.55)}>
          <h1 className="mx-auto max-w-[15ch] font-serif text-[clamp(44px,7.4vw,96px)] leading-[0.98] font-semibold tracking-[-0.025em]">
            Catch the <em className="font-medium text-[#f4d77a]">contradiction</em> before trial.
          </h1>
          <p className="mx-auto mt-6 max-w-[38rem] text-[clamp(17px,1.5vw,20px)] leading-relaxed text-navy-ink">
            Veridict reads every session of a witness's deposition and puts the testimony that may conflict side by side, cited to page and line.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <a href={href.register()} className="flex h-12 items-center gap-2 rounded-md bg-white px-5 text-[15px] font-semibold text-navy transition-colors hover:bg-[#e6ebf3]">Get started<ArrowRight aria-hidden className="size-4" /></a>
            <a href={href.signin()} className="flex h-12 items-center rounded-md px-5 text-[15px] font-semibold text-white ring-1 ring-white/30 ring-inset hover:bg-navy-2">Sign in</a>
          </div>
        </div>
        <div ref={shot} className="seg hero-shot mt-12 w-full max-w-[1180px] min-[900px]:mt-[7vh]" style={seg(0, 0.9)}>
          <img src="/landing/hero-analysis.png" width={2880} height={1800} alt="The Veridict analysis screen: two sessions of Marcus Webb's deposition side by side, the lines that may conflict highlighted, with a pinpoint citation." className="w-full rounded-xl shadow-[0_40px_80px_-30px_rgb(0_0_0/0.6)] ring-1 ring-white/10" fetchPriority="high" />
        </div>
      </div>
    </section>
  );
}

// Grey lines standing in for a page of transcript, at transcript proportions.
function Page({ lines = 18, highlight, className, style }: { lines?: number; highlight?: number; className?: string; style?: React.CSSProperties }) {
  return (
    <div className={cx("sheet absolute w-[min(330px,38vw)] rounded-md border border-line bg-sheet px-6 py-5 shadow-[0_18px_40px_-20px_rgb(19_33_58/0.35)]", className)} style={style}>
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="flex h-[17px] items-center gap-3">
          <span className="w-4 text-right font-mono text-[9px] text-faint">{i + 1}</span>
          <span className={cx("h-[5px] rounded-full", i === highlight ? "bg-[#e9c64a]" : "bg-rule")} style={{ width: `${55 + ((i * 37) % 40)}%` }} />
        </div>
      ))}
    </div>
  );
}

function Problem() {
  const ref = useScene<HTMLElement>();
  const pages = [
    { x: "4%", y: "6%", tilt: -6, rise: 260 },
    { x: "30%", y: "0%", tilt: 3, rise: 380 },
    { x: "56%", y: "10%", tilt: -2, rise: 300 },
    { x: "14%", y: "40%", tilt: 4, rise: 420 },
    { x: "44%", y: "36%", tilt: -4, rise: 340, highlight: 11 },
    { x: "68%", y: "44%", tilt: 5, rise: 460 },
  ];
  return (
    <section ref={ref} className="scene" style={{ "--length": "150vh" } as React.CSSProperties}>
      <div className="stage mx-auto grid max-w-[1240px] items-center gap-10 px-5 py-24 sm:px-8 min-[900px]:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] min-[900px]:py-10">
        <div className="seg reveal" style={seg(0.1, 0.3)}>
          <h2 className="font-serif text-[clamp(34px,4.4vw,58px)] leading-[1.02] font-semibold tracking-[-0.02em]">Two sessions. Hundreds of pages. One line that matters.</h2>
          <p className="mt-6 max-w-[30rem] text-[18px] leading-relaxed text-muted">A witness rarely contradicts themselves on the same page. It happens months apart, in answers to differently worded questions, buried in transcripts nobody has time to read twice.</p>
        </div>
        <div className="relative h-[440px] overflow-hidden min-[900px]:h-[70vh] min-[900px]:overflow-visible" aria-hidden>
          {pages.map((pg, i) => (
            <Page key={i} highlight={pg.highlight} className={cx("seg", pg.highlight === undefined && "dim-out")} style={{ left: pg.x, top: pg.y, "--tilt": `${pg.tilt}deg`, "--rise": `${pg.rise}px`, ...seg(0.05, 0.75), ...(pg.highlight === undefined ? {} : { zIndex: 2 }) } as React.CSSProperties} />
          ))}
        </div>
      </div>
    </section>
  );
}

function TranscriptCard({ title, cite, rows, className, style }: { title: string; cite: string; rows: readonly (readonly [string, string] | readonly [string, string, boolean])[]; className?: string; style?: React.CSSProperties }) {
  return (
    <figure className={cx("seg overflow-hidden rounded-lg border border-line bg-sheet shadow-[0_24px_60px_-28px_rgb(19_33_58/0.45)]", className)} style={style}>
      <figcaption className="flex items-baseline justify-between gap-3 border-b border-rule px-5 py-3 text-xs text-faint">
        <span>{title}</span>
        <span className="font-mono text-sm font-bold text-ink">{cite}</span>
      </figcaption>
      <ol className="py-3 font-mono text-[clamp(11px,0.95vw,14px)] leading-[2.1]">
        {rows.map(([ref, text, hl]) => (
          <li key={ref} className="grid grid-cols-[3.8rem_1fr]">
            <span className={cx("pr-3 text-right text-[0.8em] tabular-nums", hl ? "font-bold text-mark-ink" : "text-faint")}>{ref}</span>
            <span className="border-l-[3px] border-double border-margin pr-4 pl-4 min-[900px]:whitespace-nowrap">
              {hl ? <span className="seg mark-sweep" style={seg(0.48, 0.18)}>{text}</span> : text}
            </span>
          </li>
        ))}
      </ol>
    </figure>
  );
}

function SideBySide() {
  const ref = useScene<HTMLElement>();
  return (
    <section ref={ref} className="scene bg-sheet" style={{ "--length": "190vh" } as React.CSSProperties}>
      <div className="stage mx-auto flex max-w-[1240px] flex-col justify-center px-5 py-24 sm:px-8 min-[900px]:py-10">
        <div className="seg reveal max-w-[44rem]" style={seg(0.08, 0.22)}>
          <h2 className="font-serif text-[clamp(34px,4.4vw,58px)] leading-[1.02] font-semibold tracking-[-0.02em]">Side by side, at page and line.</h2>
          <p className="mt-5 text-[18px] leading-relaxed text-muted">When two answers may not agree, Veridict shows both exactly as the court reporter recorded them, with the cited lines highlighted and a pinpoint citation ready to copy.</p>
        </div>
        <div className="mt-10 grid gap-5 min-[900px]:grid-cols-2">
          <TranscriptCard className="slide-left" style={seg(0.15, 0.3)} title="Earlier session · Mar. 14, 2023" cite="11:15–11:16" rows={EARLIER} />
          <TranscriptCard className="slide-right" style={seg(0.15, 0.3)} title="Later session · Sept. 9, 2023" cite="41:14–41:15" rows={LATER} />
        </div>
        <div className="mt-6 flex flex-wrap items-baseline justify-between gap-3">
          <p className="min-w-0 font-mono text-[clamp(12px,1.05vw,15px)] text-ink">
            <span className="seg typed" style={seg(0.66, 0.24)}>{CITATION}</span>
          </p>
          <p className="text-xs text-faint">Example testimony from a synthetic deposition.</p>
        </div>
      </div>
    </section>
  );
}

const PROOF = [
  { icon: ShieldCheck, title: "Verified", text: "Code checks every quotation against the stored transcript, at the cited page and line, before you see it. A citation that doesn't match is set aside, never repaired." },
  { icon: FileText, title: "Labelled", text: "Veridict's analysis is always marked as analysis, never mixed with testimony, and the most plausible innocent explanation sits beside it. The app never says a witness lied." },
  { icon: Check, title: "Decided by you", text: "Keep, Needs context or Dismiss, with a note for the file. Nothing is a conclusion until you make it one." },
];

function Proof() {
  const ref = useScene<HTMLElement>();
  return (
    <section ref={ref} className="scene" style={{ "--length": "170vh" } as React.CSSProperties}>
      <div className="stage mx-auto grid max-w-[1240px] items-center gap-12 px-5 py-24 sm:px-8 min-[900px]:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] min-[900px]:py-10">
        <div>
          <h2 className="font-serif text-[clamp(34px,4.4vw,58px)] leading-[1.02] font-semibold tracking-[-0.02em]">Evidence, not verdicts.</h2>
          <ul className="mt-8 space-y-7">
            {PROOF.map((p, i) => (
              <li key={p.title} className="seg reveal grid grid-cols-[2.25rem_1fr] gap-x-4" style={seg(0.12 + i * 0.2, 0.18)}>
                <span className="flex size-9 items-center justify-center rounded-full bg-navy text-white"><p.icon aria-hidden className="size-[18px]" strokeWidth={1.75} /></span>
                <div>
                  <h3 className="text-lg font-semibold">{p.title}</h3>
                  <p className="mt-1 text-[16px] leading-relaxed text-muted">{p.text}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
        <div className="seg pin" style={seg(0.05, 0.4)}>
          <img src="/landing/finding-detail.png" width={2400} height={1600} loading="lazy" alt="A finding in Veridict: the analysis of why two answers may conflict, the innocent explanation, and the reviewer's decision, Keep, with a note: Ask about the grocery trip; compare with card statement." className="w-full rounded-xl shadow-[0_30px_70px_-30px_rgb(19_33_58/0.5)] ring-1 ring-line" />
        </div>
      </div>
    </section>
  );
}

const STEPS: { title: string; text: string; picture: ReactNode }[] = [
  { title: "Add the depositions", text: "Upload a PDF, a text file, or paste the transcript. Scans are read by OCR, and every line keeps its page and line.", picture: <img src="/landing/add-deposition.png" width={2000} height={1400} loading="lazy" alt="The Add deposition dialog with a pasted transcript and the note: Page and line numbers found." className="w-full rounded-lg ring-1 ring-line" /> },
  { title: "Check two sessions", text: "Pick two sessions of one witness. You see the estimated cost before anything is sent, and a check never spends more than its budget.", picture: <EstimateCard /> },
  { title: "Review each finding", text: "Work through the findings with the testimony on screen, one keystroke apart. Your decisions stay with the case.", picture: <img src="/landing/hero-analysis.png" width={2880} height={1800} loading="lazy" alt="" className="w-full rounded-lg ring-1 ring-line" /> },
  { title: "Export what you kept", text: "Download the findings you kept as a PDF, with pinpoint citations, the testimony and your notes, for one analysis or several at once.", picture: <ReportTray /> },
];

// The case screen at the moment of starting a check, drawn from the app's own parts.
function EstimateCard() {
  const rows = [["Mar 14, 2023", "Webb, first session.pdf", "11"], ["Sep 9, 2023", "Webb, second session.pdf", "11"]];
  return (
    <div className="flex aspect-[10/7] flex-col justify-between overflow-hidden rounded-lg bg-canvas p-5 ring-1 ring-line">
      <div className="rounded-md border border-line bg-sheet">
        <p className="border-b border-rule px-4 py-2.5 text-[13px] font-semibold">Marcus Webb <span className="font-normal text-faint">2</span></p>
        {rows.map(([date, file, pages]) => (
          <div key={date} className="grid grid-cols-[1.5rem_6.5rem_1fr_2rem] items-center gap-2 border-t border-rule bg-info-bg px-4 py-2.5 text-[12px] first-of-type:border-t-0">
            <span className="flex size-3.5 items-center justify-center rounded-[3px] bg-navy text-white"><Check aria-hidden className="size-2.5" strokeWidth={3} /></span>
            <span className="font-medium tabular-nums">{date}</span>
            <span className="truncate text-muted">{file}</span>
            <span className="text-right tabular-nums">{pages}</span>
          </div>
        ))}
      </div>
      <div className="rounded-md bg-navy px-4 py-3 text-white shadow-[0_12px_28px_-10px_rgb(19_33_58/0.5)]">
        <p className="text-[13px] font-semibold">Marcus Webb: Mar 14, 2023 and Sep 9, 2023</p>
        <p className="mt-0.5 text-[12px] text-navy-ink">Estimated $0.85, never more than the $6.00 budget · about 10 minutes. Nothing is charged until you start.</p>
        <span className="mt-2.5 inline-flex h-7 items-center rounded-md bg-white px-3 text-[12px] font-semibold text-navy">Check these sessions</span>
      </div>
    </div>
  );
}

function ReportTray() {
  return (
    <div className="relative aspect-[10/7] overflow-hidden rounded-lg bg-rule ring-1 ring-line">
      <img src="/landing/report-page.png" width={1700} height={2200} loading="lazy" alt="Page one of a Veridict report: the kept finding with both passages, the pinpoint citation and Veridict's analysis." className="seg lift absolute top-6 left-1/2 w-[58%] -translate-x-1/2 rounded-sm shadow-[0_20px_40px_-18px_rgb(19_33_58/0.45)]" style={seg(0.8, 0.15)} />
    </div>
  );
}

function HowItWorks() {
  const track = useRef<HTMLOListElement>(null);
  // The track travels exactly its overflow, so the last step ends flush with the page's edge.
  const ref = useScene<HTMLElement>(() => {
    const t = track.current;
    if (t) t.style.setProperty("--travel", `${Math.max(0, t.scrollWidth - t.parentElement!.clientWidth)}px`);
  });
  return (
    <section id="how" ref={ref} className="scene bg-sheet" style={{ "--length": "250vh" } as React.CSSProperties}>
      <div className="stage flex flex-col justify-center py-24 min-[900px]:py-10">
        <div className="mx-auto w-full max-w-[1240px] px-5 sm:px-8">
          <h2 className="font-serif text-[clamp(34px,4.4vw,58px)] leading-[1.02] font-semibold tracking-[-0.02em]">From transcript to trial binder.</h2>
        </div>
        <div className="mx-auto mt-10 w-full max-w-[1240px] px-5 sm:px-8 min-[900px]:overflow-visible">
          <ol ref={track} style={seg(0.38, 0.55)} className="seg track flex flex-col gap-8 min-[900px]:w-max min-[900px]:flex-row min-[900px]:gap-10">
            {STEPS.map((s, i) => (
              <li key={s.title} className="min-[900px]:w-[min(560px,46vw)]">
                {s.picture}
                <h3 className="mt-5 flex items-baseline gap-2 text-xl font-semibold"><span className="font-serif text-faint">{i + 1}.</span>{s.title}</h3>
                <p className="mt-2 max-w-[30rem] text-[16px] leading-relaxed text-muted">{s.text}</p>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}

const TRUST = [
  { icon: Lock, title: "Your cases stay yours.", text: "Each account sees only its own cases, depositions and findings. Sessions live in HttpOnly cookies, and passwords and links are stored only as hashes." },
  { icon: ShieldCheck, title: "Nothing leaves until you start.", text: "Uploading and reading a transcript happen on Veridict's server. Only when you start a check are the two sessions sent to the AI model for analysis." },
  { icon: ReceiptText, title: "Every check shows its cost.", text: "An estimate before you start, the measured cost after, and a budget no check can exceed." },
  { icon: FileText, title: "Nothing third-party in the app.", text: "No trackers, ad scripts or outside fonts. The app loads only from its own server." },
];

function Trust() {
  return (
    <section id="trust" className="bg-navy text-white">
      <div className="mx-auto grid max-w-[1240px] gap-12 px-5 py-28 sm:px-8 min-[900px]:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] min-[900px]:py-36">
        <div>
          <h2 className="font-serif text-[clamp(34px,4.4vw,58px)] leading-[1.02] font-semibold tracking-[-0.02em]">Built for confidential work.</h2>
          <p className="mt-6 max-w-[28rem] text-[18px] leading-relaxed text-navy-ink">Deposition testimony is sensitive. Veridict is built so that you decide what is read, by whom, and when.</p>
        </div>
        <ul className="grid gap-x-10 gap-y-9 sm:grid-cols-2">
          {TRUST.map((t) => (
            <li key={t.title}>
              <t.icon aria-hidden className="size-6 text-[#8ea3c0]" strokeWidth={1.6} />
              <h3 className="mt-4 text-lg font-semibold">{t.title}</h3>
              <p className="mt-2 text-[15px] leading-relaxed text-navy-ink">{t.text}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function Close() {
  return (
    <section className="bg-canvas">
      <div className="mx-auto max-w-[1240px] px-5 pt-28 pb-10 sm:px-8 min-[900px]:pt-36">
        <div className="grid items-center gap-12 min-[900px]:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
          <div>
            <h2 className="max-w-[18ch] font-serif text-[clamp(36px,5vw,68px)] leading-[1.02] font-semibold tracking-[-0.02em]">Find it before opposing counsel does.</h2>
            <p className="mt-6 max-w-[34rem] text-[18px] leading-relaxed text-muted">Veridict is in early access. Create an account, add two sessions, and read your first findings side by side. Checks that use the AI model are turned on per account.</p>
            <div className="mt-8 flex flex-wrap gap-3">
              <a href={href.register()} className="flex h-12 items-center gap-2 rounded-md bg-navy px-5 text-[15px] font-semibold text-white hover:bg-navy-3">Get started<ArrowRight aria-hidden className="size-4" /></a>
              <a href={href.signin()} className="flex h-12 items-center rounded-md px-5 text-[15px] font-semibold text-ink ring-1 ring-control ring-inset hover:bg-hover">Sign in</a>
            </div>
          </div>
          <img src="/landing/report-page.png" width={1700} height={2200} loading="lazy" alt="Page one of a Veridict report of kept findings." className="mx-auto w-[min(380px,80%)] rotate-[2deg] rounded-sm shadow-[0_30px_60px_-24px_rgb(19_33_58/0.45)] ring-1 ring-line" />
        </div>
        <p aria-hidden className="mt-24 font-serif text-[clamp(72px,19vw,260px)] leading-[0.8] font-semibold tracking-[-0.04em] text-navy select-none">Veridict</p>
        <footer className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-6 text-sm text-muted">
          <span>Veridict finds potential contradictions for review. It doesn't give legal advice or decide what testimony means.</span>
          <span className="flex gap-5"><a href={href.signin()} className="hover:text-ink">Sign in</a><a href={href.register()} className="hover:text-ink">Create account</a></span>
        </footer>
      </div>
    </section>
  );
}
