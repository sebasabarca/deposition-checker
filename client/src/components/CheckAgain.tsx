// Starting a check, and the confirmation before paying for the same comparison again.

import { useEffect, useState } from "react";
import { RotateCcw } from "lucide-react";
import { api, type CheckEstimate } from "../lib/api";
import { href } from "../lib/router";
import { useUser } from "../lib/session";
import { Alert, Button, Dialog } from "./ui";

// The cost estimate for two sessions, from the server, or null while it loads or if it failed.
export function useEstimate(caseId: number, a: number | null, b: number | null) {
  const [estimate, setEstimate] = useState<CheckEstimate | null>(null);
  useEffect(() => {
    setEstimate(null);
    if (a === null || b === null) return;
    api.estimate(caseId, a, b).then((r) => setEstimate(r.estimate)).catch(() => setEstimate(null));
  }, [caseId, a, b]);
  return estimate;
}

const usd = (n: number) => `$${n < 10 ? n.toFixed(2) : Math.round(n)}`;
export function estimateText(e: CheckEstimate | null) {
  if (!e) return "Estimating the cost…";
  if (!e.fits) return "This testimony is too long to check in one request. Nothing would be sent.";
  // One request's worst case isn't the ceiling (a backup model may run), so the budget is named instead.
  return `Estimated ${usd(e.typicalUsd)}, never more than the ${usd(e.budgetUsd)} budget · about 10 minutes`;
}

export const NO_ACCESS = "Paid checks aren't enabled for this account yet. Veridict is in early access; contact us to turn them on.";

export function useStartCheck(caseId: number) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const start = async (depositionA: number, depositionB: number) => {
    setBusy(true);
    setError(null);
    try {
      const { analysis } = await api.startAnalysis(caseId, { depositionA, depositionB, mode: "live" });
      window.location.hash = href.analysis(analysis.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { start, error, busy };
}

// a, b: two sessions, of one witness or (cross) of two.
export function CheckAgain({ caseId, a, b, cross = false, variant = "secondary" }: { caseId: number; a: number; b: number; cross?: boolean; variant?: "primary" | "secondary" }) {
  const [open, setOpen] = useState(false);
  const { start, error, busy } = useStartCheck(caseId);
  const estimate = useEstimate(caseId, open ? a : null, open ? b : null);
  const access = useUser()?.analysisAccess ?? false;
  return (
    <>
      <Button variant={variant} onClick={() => setOpen(true)}><RotateCcw aria-hidden className="size-3.5" />Check again</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={cross ? "Compare these witnesses again?" : "Check these sessions again?"}>
        <div className="space-y-4 px-6 py-5">
          <p className="text-base leading-6">This runs a new paid check. The earlier analysis stays, and a new check may find different results. Your decisions carry over wherever a finding cites the same passages.</p>
          <p className="rounded-md bg-well px-4 py-3 text-sm tabular-nums">{estimateText(estimate)}.</p>
          {!access && <Alert tone="warn">{NO_ACCESS}</Alert>}
          {error && <Alert>{error}</Alert>}
        </div>
        <div className="flex justify-end gap-2 border-t border-rule px-6 py-3.5">
          <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
          <Button disabled={busy || !access || estimate?.fits === false} onClick={() => void start(a, b)}>{busy ? "Starting…" : "Start paid check"}</Button>
        </div>
      </Dialog>
    </>
  );
}
