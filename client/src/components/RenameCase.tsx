// Renaming a case, from the case page or the cases list. Only the name changes: depositions, analyses and findings
// stay as they are.

import { useState, type FormEvent } from "react";
import { api } from "../lib/api";
import { Alert, Button, Dialog, Field, inputClass } from "./ui";

export function RenameCase({ caseId, name, open, onClose, onRenamed }: { caseId: number; name: string; open: boolean; onClose: () => void; onRenamed: (name: string) => void }) {
  return (
    <Dialog open={open} onClose={onClose} title="Rename case" description="Only the name changes. Depositions, analyses and findings stay as they are.">
      <RenameForm caseId={caseId} name={name} onCancel={onClose} onRenamed={onRenamed} />
    </Dialog>
  );
}

// Mounted only while the dialog is open (Dialog renders its children then), so it starts from the current name.
function RenameForm({ caseId, name, onCancel, onRenamed }: { caseId: number; name: string; onCancel: () => void; onRenamed: (name: string) => void }) {
  const [value, setValue] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const next = value.trim();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!next || next === name) return onCancel();
    setBusy(true);
    setError(null);
    try {
      const detail = await api.renameCase(caseId, next);
      onRenamed(detail.case.name);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit}>
      <div className="space-y-4 px-6 py-5">
        <Field label="Case name" htmlFor={`rename-${caseId}`}>
          <input id={`rename-${caseId}`} className={inputClass} value={value} onChange={(e) => setValue(e.target.value)} required maxLength={200} data-autofocus onFocus={(e) => e.currentTarget.select()} />
        </Field>
        {error && <Alert>{error}</Alert>}
      </div>
      <div className="flex justify-end gap-2 border-t border-rule px-6 py-3.5">
        <Button variant="secondary" onClick={onCancel}>Cancel</Button>
        <Button type="submit" disabled={busy || !next}>{busy ? "Saving…" : "Save name"}</Button>
      </div>
    </form>
  );
}
