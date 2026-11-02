// The first-run tour: the screen dims, one part of it is lit at a time, and a note beside it says what
// it's for, with an arrow pointing at it. Next, Back, Skip, and the arrow keys or Escape. A step whose
// target isn't on screen (a phone, where the sidebar is folded away) shows its note in the middle.

import { useCallback, useEffect, useLayoutEffect, useState, type CSSProperties } from "react";
import { X } from "lucide-react";
import { Button, cx } from "./ui";

export type TourStep = { target?: string; title: string; text: string };

export const TOUR: TourStep[] = [
  { title: "Welcome to Veridict", text: "A quick look at where things are. It takes under a minute, and you can replay it from Help at any time." },
  { target: "add", title: "Add a deposition", text: "Upload a PDF, a text file, or paste the transcript. Each one is a single session of one witness." },
  { target: "nav-cases", title: "Cases", text: "A case holds a matter's witnesses and their sessions. Open one and tick two sessions of the same witness to check them against each other." },
  { target: "nav-depositions", title: "Depositions", text: "Read and search any transcript page by page, with its real page and line numbers." },
  { target: "nav-analyses", title: "Analyses", text: "Every check of two sessions, with its progress and cost. A check takes about ten minutes, and you can keep working while it runs." },
  { target: "nav-findings", title: "Findings", text: "Potential contradictions from your checks. Open one to read both passages side by side, then decide: Keep, Needs context or Dismiss." },
  { target: "nav-overview", title: "Overview", text: "Your starting point: what's waiting for your decision, and what's still running." },
  { target: "help", title: "Help", text: "How everything works, explained. Replay this tour from here whenever you like." },
  { target: "account", title: "Your account", text: "Your profile, password and sign-out." },
];

// The first time someone opens a finished analysis: how to move through its findings and decide.
export const ANALYSIS_TOUR: TourStep[] = [
  { title: "Reviewing an analysis", text: "Each finding is a pair of passages from the two sessions that may conflict. Here's how to move through them and decide." },
  { target: "finding-tabs", title: "Four categories", text: "Findings are sorted into Potential contradictions, Needs context, Compatible or dismissed, and Unverified. The number is how many each holds. Start with the first." },
  { target: "finding-chips", title: "Every finding in the category", text: "Each number is one finding, and the outlined one is open. Its colour shows your decision: white not decided, green Kept, amber Needs context, grey Dismissed. Click a number to jump to it." },
  { target: "finding-steps", title: "Previous and Next", text: "Go through them one at a time, or press j and k. After the last finding of a category, Next takes you to the next category." },
  { target: "finding-passages", title: "Both passages, side by side", text: "The testimony from each session, word for word, at its page and line. The lines the finding cites are highlighted." },
  { target: "finding-decision", title: "Your decision", text: "Keep it for follow-up, mark it Needs context, or Dismiss it, and add a note if you like. It saves at once, and the number above changes colour." },
  { target: "finding-export", title: "Download the report", text: "A PDF of the findings you kept in this analysis, with citations and your notes. Replay this guide from “How to review” in the bar." },
];

const PAD = 6;

export function Tour({ steps, onDone }: { steps: TourStep[]; onDone: () => void }) {
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const step = steps[i];
  const last = i === steps.length - 1;

  const measure = useCallback((scroll = false) => {
    const el = step.target ? document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`) : null;
    let r = el?.getBoundingClientRect();
    // A target below or above the window is scrolled to first.
    if (el && r && scroll && (r.top < 0 || r.bottom > window.innerHeight)) {
      el.scrollIntoView({ block: r.height > window.innerHeight * 0.6 ? "start" : "center" });
      r = el.getBoundingClientRect();
    }
    setRect(r && r.width > 0 && r.height > 0 ? r : null);
  }, [step.target]);
  // The sidebar widens when the tour starts, so measure again once it has.
  useLayoutEffect(() => {
    measure(true);
    const again = () => measure();
    const t = window.setTimeout(again, 260);
    window.addEventListener("resize", again);
    window.addEventListener("scroll", again);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("resize", again);
      window.removeEventListener("scroll", again);
    };
  }, [measure]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDone();
      if (e.key === "ArrowRight") (last ? onDone() : setI((n) => n + 1));
      if (e.key === "ArrowLeft") setI((n) => Math.max(0, n - 1));
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [last, onDone]);

  // The note sits to the right of its target, level with it; for a wide target, below it, else above
  // it; for a target as big as the window, in its lower corner. Always on screen.
  const noteWidth = Math.min(320, window.innerWidth - 32);
  const noteHeight = 230; // shortcut: the tallest note's height, estimated; measure the note if steps get longer
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const clampX = (x: number) => Math.max(16, Math.min(x, vw - noteWidth - 16));
  const placed: { style: CSSProperties; arrow?: CSSProperties } | null = !rect
    ? null
    : rect.right + 22 + noteWidth <= vw - 16
      ? (() => {
          const top = Math.max(16, Math.min(rect.top + rect.height / 2 - 70, vh - noteHeight));
          return { style: { left: rect.right + 22, top }, arrow: { left: -7, top: Math.max(14, Math.min(rect.top + rect.height / 2 - top - 7, 180)) } };
        })()
      : rect.bottom + 18 + noteHeight <= vh
        ? (() => {
            const left = clampX(rect.left + 24);
            return { style: { left, top: rect.bottom + 18 }, arrow: { top: -7, left: Math.max(14, Math.min(rect.left + 40 - left, noteWidth - 28)) } };
          })()
        : rect.top - 18 - noteHeight >= 0
          ? (() => {
              const left = clampX(rect.left + 24);
              return { style: { left, bottom: vh - rect.top + 18 }, arrow: { bottom: -7, left: Math.max(14, Math.min(rect.left + 40 - left, noteWidth - 28)) } };
            })()
          : { style: { right: 16, bottom: 16 } };

  return (
    <div className="fixed inset-0 z-[60]" role="dialog" aria-modal aria-labelledby="tour-title">
      {/* The light: a clear box over the target, with everything around it dimmed by its shadow. */}
      {rect ? (
        <div aria-hidden className="pointer-events-none fixed rounded-lg ring-2 ring-white transition-all duration-300 ease-out" style={{ left: rect.left - PAD, top: rect.top - PAD, width: rect.width + PAD * 2, height: rect.height + PAD * 2, boxShadow: "0 0 0 9999px rgb(10 18 32 / 0.62)" }} />
      ) : (
        <div aria-hidden className="fixed inset-0 bg-[rgb(10_18_32/0.62)]" />
      )}
      <div
        className={cx("fixed w-[min(320px,calc(100vw-32px))] rounded-xl bg-sheet p-5 text-ink shadow-[0_24px_60px_-16px_rgb(0_0_0/0.5)] transition-all duration-300 ease-out", !placed && "top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2")}
        style={placed?.style}
      >
        {placed?.arrow && <span aria-hidden className="absolute size-3.5 rotate-45 bg-sheet" style={placed.arrow} />}
        <div className="flex items-start justify-between gap-3">
          <h2 id="tour-title" className="font-serif text-lg font-semibold">{step.title}</h2>
          <button type="button" onClick={onDone} aria-label="Close the tour" className="-mt-1 -mr-1.5 rounded-md p-1 text-faint hover:bg-rule hover:text-ink"><X aria-hidden className="size-4" /></button>
        </div>
        <p className="mt-1.5 text-sm leading-6 text-muted">{step.text}</p>
        <div className="mt-4 flex items-center justify-between gap-3">
          <span className="flex gap-1" aria-label={`Step ${i + 1} of ${steps.length}`}>
            {steps.map((_, n) => <span key={n} aria-hidden className={cx("h-1.5 rounded-full transition-all", n === i ? "w-4 bg-navy" : "w-1.5 bg-control")} />)}
          </span>
          <span className="flex gap-1.5">
            {i === 0 ? <Button variant="ghost" onClick={onDone}>Skip</Button> : <Button variant="secondary" onClick={() => setI(i - 1)}>Back</Button>}
            <Button onClick={() => (last ? onDone() : setI(i + 1))} autoFocus>{last ? "Finish" : i === 0 ? "Show me around" : "Next"}</Button>
          </span>
        </div>
      </div>
    </div>
  );
}
