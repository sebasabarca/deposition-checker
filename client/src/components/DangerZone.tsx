// The last section of a deposition or case page: what deleting it removes, in words, and a
// confirmation that names it. A case also asks for its name to be typed, since it takes everything.

import { useState } from "react";
import { Trash2 } from "lucide-react";
import { Alert, Button, Dialog, inputClass } from "./ui";

export function DangerZone({ what, name, consequence, typeToConfirm, onDelete }: { what: string; name: string; consequence: string; typeToConfirm?: boolean; onDelete: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmed = !typeToConfirm || typed.trim() === name.trim();
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await onDelete();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <section className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-conflict/25 bg-sheet px-5 py-4">
      <div className="min-w-0 flex-1 basis-72">
        <h2 className="font-semibold">Delete this {what}</h2>
        <p className="mt-0.5 text-sm text-muted">{consequence}</p>
      </div>
      <Button variant="danger" onClick={() => setOpen(true)}><Trash2 aria-hidden className="size-4" />Delete {what}</Button>
      <Dialog open={open} onClose={() => { setOpen(false); setTyped(""); }} title={`Delete “${name}”?`}>
        <div className="space-y-4 px-6 py-5">
          <p className="leading-6">{consequence} This can't be undone.</p>
          {typeToConfirm && (
            <label className="block text-sm">
              <span>Type <strong className="font-semibold">{name}</strong> to confirm.</span>
              <input className={`${inputClass} mt-1.5`} value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
            </label>
          )}
          {error && <Alert>{error}</Alert>}
        </div>
        <div className="flex justify-end gap-2 border-t border-rule px-6 py-3.5">
          <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
          <button type="button" disabled={!confirmed || busy} onClick={() => void run()} className="inline-flex h-8 items-center gap-1.5 rounded-md bg-conflict px-3 text-sm font-semibold text-white hover:bg-[#7f1d1d] disabled:cursor-not-allowed disabled:bg-control disabled:text-muted">
            {busy ? "Deleting…" : `Delete ${what}`}
          </button>
        </div>
      </Dialog>
    </section>
  );
}
