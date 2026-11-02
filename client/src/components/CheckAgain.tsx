// Starting a check, and the confirmation before paying for the same comparison again.

import { useState } from "react";
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
      <Button variant={variant} className="h-10" onClick={() => setOpen(true)}>Check again</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Check these depositions again?">
        <div className="space-y-4 p-space-lg">
          <p className="text-body-sm">This runs a new paid check of about $1–2. Your earlier report stays. A new check may find different results. Decisions you've made carry over wherever a finding cites the same passages.</p>
          {error && <Alert>{error}</Alert>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button disabled={busy} onClick={() => void start(a, b)}>{busy ? "Starting…" : "Check again"}</Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
