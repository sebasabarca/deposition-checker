// Starting a check, and the confirmation before paying for the same comparison again.

import { useState } from "react";
import { RotateCcw } from "lucide-react";
import { api } from "../lib/api";
import { href } from "../lib/router";
import { Alert, Button, Dialog } from "./ui";

export const CHECK_ESTIMATE = "About 10 minutes · about $1–2";

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

export function CheckAgain({ caseId, a, b, variant = "secondary" }: { caseId: number; a: number; b: number; variant?: "primary" | "secondary" }) {
  const [open, setOpen] = useState(false);
  const { start, error, busy } = useStartCheck(caseId);
  return (
    <>
      <Button variant={variant} onClick={() => setOpen(true)}><RotateCcw aria-hidden className="size-3.5" />Check again</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Check these sessions again?">
        <div className="space-y-4 px-6 py-5">
          <p className="text-base leading-6">This runs a new paid check, usually about $1–2. The earlier analysis stays, and a new check may find different results. Your decisions carry over wherever a finding cites the same passages.</p>
          {error && <Alert>{error}</Alert>}
        </div>
        <div className="flex justify-end gap-2 border-t border-rule px-6 py-3.5">
          <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
          <Button disabled={busy} onClick={() => void start(a, b)}>{busy ? "Starting…" : "Start paid check"}</Button>
        </div>
      </Dialog>
    </>
  );
}
