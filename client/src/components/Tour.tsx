// The first-run tour: the screen dims, one part of it is lit at a time, and a note beside it says what
// it's for, with an arrow pointing at it. Next, Back, Skip, and the arrow keys or Escape. A step whose
// target isn't on screen (a phone, where the sidebar is folded away) shows its note in the middle.

import { useCallback, useEffect, useLayoutEffect, useState } from "react";
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

const PAD = 6;

export function Tour({ steps, onDone }: { steps: TourStep[]; onDone: () => void }) {
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const step = steps[i];
  const last = i === steps.length - 1;

  const measure = useCallback(() => {
    const el = step.target ? document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`) : null;
    const r = el?.getBoundingClientRect();
    setRect(r && r.width > 0 && r.height > 0 ? r : null);
  }, [step.target]);
  // The sidebar widens when the tour starts, so measure again once it has.
  useLayoutEffect(() => {
    measure();
    const t = window.setTimeout(measure, 260);
    window.addEventListener("resize", measure);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("resize", measure);
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

  // The note sits to the right of its target, level with it, kept on screen.
  const noteWidth = 320;
  const note = rect
    ? { left: Math.min(rect.right + 22, window.innerWidth - noteWidth - 16), top: Math.max(16, Math.min(rect.top + rect.height / 2 - 70, window.innerHeight - 220)) }
    : null;

  return (
    <div className="fixed inset-0 z-[60]" role="dialog" aria-modal aria-labelledby="tour-title">
      {/* The light: a clear box over the target, with everything around it dimmed by its shadow. */}
      {rect ? (
        <div aria-hidden className="pointer-events-none fixed rounded-lg ring-2 ring-white transition-all duration-300 ease-out" style={{ left: rect.left - PAD, top: rect.top - PAD, width: rect.width + PAD * 2, height: rect.height + PAD * 2, boxShadow: "0 0 0 9999px rgb(10 18 32 / 0.62)" }} />
      ) : (
        <div aria-hidden className="fixed inset-0 bg-[rgb(10_18_32/0.62)]" />
      )}
      <div
        className={cx("fixed w-[min(320px,calc(100vw-32px))] rounded-xl bg-sheet p-5 text-ink shadow-[0_24px_60px_-16px_rgb(0_0_0/0.5)] transition-all duration-300 ease-out", !note && "top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2")}
        style={note ?? undefined}
      >
        {note && rect && <span aria-hidden className="absolute -left-[7px] size-3.5 rotate-45 bg-sheet" style={{ top: Math.max(14, Math.min(rect.top + rect.height / 2 - note.top - 7, 180)) }} />}
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
