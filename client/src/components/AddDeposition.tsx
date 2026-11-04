// Add depositions from anywhere: one or more files (PDF, or a court reporter's text, RTF or Word
// export) into one drop zone, or text pasted in. The case is shared by the batch; each file has its
// own witness (guessed from its name when it matches a witness in the case) and may carry its date.
// A date left empty is looked for on the transcript's cover and confirmed in the case before any check.

import { useEffect, useId, useMemo, useRef, useState, type DragEvent, type FormEvent } from "react";
import { ClipboardPaste, FileText, RotateCw, UploadCloud, X } from "lucide-react";
import { api } from "../lib/api";
import { guessWitness, needsWitness, runLimited, type UploadState } from "../lib/bulkUpload";
import { describeText } from "../lib/textTranscript";
import { href } from "../lib/router";
import { useUser } from "../lib/session";
import type { CaseSummary } from "../types";
import { Alert, Badge, Button, cx, Dialog, Field, fieldClass, inputClass, selectClass, type Tone } from "./ui";
import { DateInput } from "./DateInput";

const MAX_UPLOAD_MB = 50; // server/src/api/depositions.ts
const NEW_CASE = "new";
const CONCURRENT_UPLOADS = 3;
const PLAIN = /\.(txt|text|asc)$/i; // read here to preview its shape
const SUPPORTED = /\.(pdf|txt|text|asc|rtf|docx)$/i;
const PROPRIETARY = /\.(ptx|ptz|lef|ptf)$/i; // server/src/ingest/formats.ts
const ACCEPT = "application/pdf,.pdf,text/plain,.txt,.asc,.rtf,application/rtf,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document";

type Item = { key: string; file: File; witness: string; takenOn: string; shape: ReturnType<typeof describeText> | null; state: UploadState; error?: string };

// Why a file can't be sent, in plain words; null when it can.
function problemOf(f: File): string | null {
  if (PROPRIETARY.test(f.name)) return "E-Transcript (.ptx, .ptz), LiveNote (.lef) and .ptf files are proprietary. Export the transcript as plain text (.txt) from the free E-Transcript viewer, or ask the court reporter for the text or PDF transcript.";
  if (!SUPPORTED.test(f.name) && f.type !== "application/pdf" && !f.type.startsWith("text/")) return "Not a transcript file Veridict can read. Use a PDF, .txt, .asc, .rtf or .docx file.";
  if (f.size > MAX_UPLOAD_MB * 1024 * 1024) return `Larger than ${MAX_UPLOAD_MB} MB.`;
  return null;
}

export function AddDeposition({ open, caseId, onClose }: { open: boolean; caseId?: number; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title="Add depositions" description="One or more sessions, of one witness or several. Veridict reads each into page and line references before they can be checked." size="xl">
      <Form presetCase={caseId} onClose={onClose} />
    </Dialog>
  );
}

function Form({ presetCase, onClose }: { presetCase?: number; onClose: () => void }) {
  const ids = useId();
  const [cases, setCases] = useState<CaseSummary[] | null>(null);
  const [caseChoice, setCaseChoice] = useState<string>(presetCase ? String(presetCase) : "");
  const [newCase, setNewCase] = useState("");
  const [witnesses, setWitnesses] = useState<string[]>([]);
  const [witness, setWitness] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState("");
  const [pastedDate, setPastedDate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [doneCase, setDoneCase] = useState<number | null>(null);

  useEffect(() => {
    api.cases().then((r) => {
      setCases(r.cases);
      if (!presetCase) setCaseChoice(r.cases.length ? String(r.cases[0].id) : NEW_CASE);
    }).catch((e: Error) => setError(e.message));
  }, [presetCase]);
  useEffect(() => {
    if (!/^\d+$/.test(caseChoice)) return setWitnesses([]);
    api.case(Number(caseChoice)).then((d) => {
      const names = d.witnesses.map((w) => w.name);
      setWitnesses(names);
      // Only a case with one witness pre-fills the batch witness; with several, each file is matched by name.
      setWitness((w) => w || (names.length === 1 ? names[0] : ""));
      setItems((all) => all.map((i) => (i.witness || i.state === "added" ? i : { ...i, witness: guessWitness(i.file.name, names) })));
    }).catch(() => setWitnesses([]));
  }, [caseChoice]);

  const update = (key: string, change: Partial<Item>) => setItems((all) => all.map((i) => (i.key === key ? { ...i, ...change } : i)));
  const addFiles = (files: File[]) => {
    setError(null);
    setDoneCase(null);
    const added = files.map((file): Item => ({ key: `${file.name}-${file.size}-${file.lastModified}-${Math.random()}`, file, witness: guessWitness(file.name, witnesses) || witness.trim(), takenOn: "", shape: null, state: "waiting" }));
    setItems((all) => [...all.filter((i) => i.state !== "added"), ...added]);
    for (const item of added) if (PLAIN.test(item.file.name)) item.file.text().then((t) => update(item.key, { shape: describeText(t) })).catch(() => undefined);
  };
  const remove = (key: string) => setItems((all) => all.filter((i) => i.key !== key));
  const applyWitness = (onlyEmpty: boolean) => setItems((all) => all.map((i) => (i.state === "added" || (onlyEmpty && i.witness.trim()) ? i : { ...i, witness: witness.trim() })));

  const pastedShape = useMemo(() => (pasting && pasted.trim() ? describeText(pasted) : null), [pasting, pasted]);
  const sendableItems = items.filter((i) => !problemOf(i.file));
  const pending = sendableItems.filter((i) => i.state !== "added");
  const missing = pending.filter(needsWitness).length;
  const addedCount = sendableItems.length - pending.length;
  const failedCount = pending.filter((i) => i.state === "failed").length;
  const sendable = pasting ? (pasted.trim() ? 1 : 0) : pending.length;
  const caseReady = caseChoice === NEW_CASE ? newCase.trim().length > 0 : /^\d+$/.test(caseChoice);
  const verified = useUser()?.emailVerified ?? false;
  const ready = verified && sendable > 0 && caseReady && (pasting ? witness.trim().length > 0 : missing === 0) && !busy;

  // Creates the new case once, so a retry adds to the case just made.
  const targetCase = async () => {
    if (caseChoice !== NEW_CASE) return Number(caseChoice);
    const id = (await api.createCase(newCase.trim())).case.id;
    setCaseChoice(String(id));
    return id;
  };
  const send = async (target: number, item: Item): Promise<number | null> => {
    update(item.key, { state: "sending", error: undefined });
    try {
      const { deposition } = await api.upload(target, item.file, item.witness.trim(), item.takenOn || undefined);
      update(item.key, { state: "added" });
      return deposition.id;
    } catch (err) {
      update(item.key, { state: "failed", error: (err as Error).message });
      return null;
    }
  };
  const retry = async (item: Item) => {
    if (!/^\d+$/.test(caseChoice) || needsWitness(item)) return;
    setBusy(true);
    if ((await send(Number(caseChoice), item)) !== null && pending.length === 1) setDoneCase(Number(caseChoice));
    setBusy(false);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const target = await targetCase();
      if (pasting) {
        const name = witness.trim();
        const body = new File([pasted], `Pasted transcript, ${name}${pastedDate ? ` ${pastedDate}` : ""}.txt`, { type: "text/plain" });
        const { deposition } = await api.upload(target, body, name, pastedDate || undefined);
        onClose();
        window.location.hash = href.deposition(deposition.id);
        return;
      }
      // A few at a time; a failure is reported against its file and the rest still go through.
      const queue = pending;
      const added: number[] = [];
      await runLimited(queue, CONCURRENT_UPLOADS, async (item) => {
        const id = await send(target, item);
        if (id !== null) added.push(id);
      });
      if (added.length === queue.length && addedCount === 0) {
        onClose();
        window.location.hash = added.length === 1 ? href.deposition(added[0]) : href.case(target);
        return;
      }
      if (added.length === queue.length) setDoneCase(target);
      setBusy(false);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  const openCase = (id: number) => {
    onClose();
    window.location.hash = href.case(id);
  };

  const status = busy && !pasting && sendableItems.length > 0
    ? `Sending… ${addedCount} of ${sendableItems.length} added`
    : !pasting && failedCount > 0
      ? `${addedCount} of ${sendableItems.length} added. ${failedCount} ${failedCount === 1 ? "file" : "files"} failed: try again, or remove ${failedCount === 1 ? "it" : "them"}.`
      : !pasting && missing > 0
        ? `${missing} ${missing === 1 ? "file needs" : "files need"} a witness before you can add ${missing === 1 ? "it" : "them"}.`
        : "The original is stored exactly as uploaded. Nothing is sent to a model until you start a check.";

  return (
    <form onSubmit={submit} className="flex max-h-[calc(100dvh-8rem)] flex-col">
      <div className="grid min-h-0 flex-1 overflow-y-auto md:grid-cols-[17rem_1fr]">
        <div className="space-y-4 border-rule bg-well px-6 py-5 max-md:border-b md:border-r">
          <Field label="Case" htmlFor={`${ids}-case`}>
            <select id={`${ids}-case`} className={cx(selectClass, "w-full")} value={caseChoice} onChange={(e) => setCaseChoice(e.target.value)} disabled={!cases || busy}>
              {!cases && <option>Loading cases…</option>}
              {cases?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              <option value={NEW_CASE}>New case…</option>
            </select>
          </Field>
          {caseChoice === NEW_CASE && (
            <Field label="New case name" htmlFor={`${ids}-newcase`}>
              <input id={`${ids}-newcase`} className={inputClass} value={newCase} onChange={(e) => setNewCase(e.target.value)} maxLength={200} placeholder="Webb v. Harlow Logistics" />
            </Field>
          )}
          <Field
            label="Witness"
            htmlFor={`${ids}-witness`}
            hint={pasting
              ? `${witnesses.length ? "Pick a witness in this case or type a new name. " : ""}The pasted text is a session of this witness.`
              : "New files get this witness unless their name matches another witness in the case. Each file's witness can be changed in its row."}
          >
            <input id={`${ids}-witness`} autoFocus className={inputClass} list={`${ids}-witnesses`} value={witness} onChange={(e) => setWitness(e.target.value)} required={pasting} maxLength={200} placeholder="Marcus Webb" disabled={busy} />
            <datalist id={`${ids}-witnesses`}>{witnesses.map((w) => <option key={w} value={w} />)}</datalist>
          </Field>
          {!pasting && items.length > 0 && (
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              <button type="button" onClick={() => applyWitness(true)} disabled={busy || !witness.trim()} className="text-sm font-medium text-info hover:underline disabled:opacity-50 disabled:hover:no-underline">Fill empty rows</button>
              <button type="button" onClick={() => applyWitness(false)} disabled={busy || !witness.trim()} className="text-sm font-medium text-info hover:underline disabled:opacity-50 disabled:hover:no-underline">Use for every file</button>
            </div>
          )}
          <p className="text-xs leading-5 text-muted">Leave a date empty and Veridict reads it from the transcript's cover. You confirm it on the case page before running a check. You can change the date, witness or case later from the deposition's page.</p>
        </div>

        <div className="min-w-0 space-y-4 px-6 py-5">
          {pasting ? (
            <>
              <div className="flex items-center justify-between gap-3">
                <label htmlFor={`${ids}-paste`} className="text-sm font-medium">Transcript text</label>
                <button type="button" onClick={() => setPasting(false)} className="text-sm font-medium text-info hover:underline">Upload files instead</button>
              </div>
              <textarea
                id={`${ids}-paste`}
                value={pasted}
                onChange={(e) => setPasted(e.target.value)}
                rows={12}
                spellCheck={false}
                placeholder={"12   Q.  Where were you on the morning of June 4th?\n13   A.  At the depot on Kerr Street, from about six."}
                className={cx(fieldClass, "w-full resize-y py-2.5 font-mono text-[13px] leading-6 whitespace-pre")}
              />
              <Field label="Date taken" htmlFor={`${ids}-pasted-date`} hint="Optional. Used to order the sessions and in citations.">
                <DateInput id={`${ids}-pasted-date`} value={pastedDate} onChange={setPastedDate} />
              </Field>
              {pastedShape && <TextShape shape={pastedShape} />}
            </>
          ) : (
            <>
              <DropZone onFiles={addFiles} compact={items.length > 0} disabled={busy} />
              {items.length > 0 && (
                <ul className="divide-y divide-rule rounded-lg border border-line" aria-label="Files to add">
                  {items.map((item) => (
                    <FileRow key={item.key} item={item} witnessList={`${ids}-witnesses`} disabled={busy}
                      onChange={(change) => update(item.key, change)} onRemove={() => remove(item.key)} onRetry={() => retry(item)} />
                  ))}
                </ul>
              )}
              <button type="button" onClick={() => setPasting(true)} disabled={busy} className="flex items-center gap-1.5 text-sm font-medium text-info hover:underline disabled:opacity-50">
                <ClipboardPaste aria-hidden className="size-4" />Paste the transcript text instead
              </button>
            </>
          )}

          {!verified && <Alert tone="warn" title="Verify your email first">Open the link we emailed you, then add depositions. You can send a new link from the banner at the top of the page.</Alert>}
          {error && <Alert>{error}</Alert>}
          {!pasting && !busy && doneCase !== null && pending.length === 0 && (
            <Alert tone="info" title={`${addedCount} of ${sendableItems.length} added`} action={<Button variant="secondary" onClick={() => openCase(doneCase)}>Open the case</Button>}>
              Confirm any dates read from the transcripts on the case page, then start a check.
            </Alert>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-rule px-6 py-3.5">
        <p aria-live="polite" className={cx("text-xs tabular-nums", missing > 0 || failedCount > 0 ? "text-ink" : "text-faint")}>{status}</p>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={onClose}>{doneCase !== null && pending.length === 0 ? "Close" : "Cancel"}</Button>
          <Button type="submit" disabled={!ready}>{busy ? "Adding…" : sendable > 1 ? `Add ${sendable} depositions` : "Add deposition"}</Button>
        </div>
      </div>
    </form>
  );
}

const STATUS: Record<UploadState, { tone: Tone; label: string }> = {
  waiting: { tone: "neutral", label: "Waiting" },
  sending: { tone: "active", label: "Sending" },
  added: { tone: "good", label: "Added" },
  failed: { tone: "bad", label: "Failed" },
};

function FileRow({ item, witnessList, disabled, onChange, onRemove, onRetry }: { item: Item; witnessList: string; disabled: boolean; onChange: (change: Partial<Item>) => void; onRemove: () => void; onRetry: () => void }) {
  const id = useId();
  const problem = problemOf(item.file);
  const size = item.file.size / 1024 / 1024;
  const editable = !problem && (item.state === "waiting" || item.state === "failed");
  const missing = !problem && needsWitness(item);
  const status = STATUS[item.state];
  return (
    <li className="px-4 py-3">
      <div className="flex items-start gap-3">
        <FileText aria-hidden className="mt-0.5 size-4 flex-none text-slate" strokeWidth={1.75} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium" title={item.file.name}>{item.file.name}</p>
          <p className="text-xs text-muted tabular-nums">
            {size.toFixed(size < 1 ? 2 : 1)} MB
            {item.shape && item.shape.lines > 0 && (item.shape.numbered ? " · page and line numbers found" : " · no page and line numbers: cited by line")}
          </p>
        </div>
        {problem ? <Badge tone="warn">Can't add</Badge> : <Badge tone={status.tone} dot={item.state === "sending"}>{status.label}</Badge>}
        {item.state === "failed" && !missing && (
          <Button variant="secondary" disabled={disabled} onClick={onRetry} aria-label={`Try again: ${item.file.name}`}>
            <RotateCw aria-hidden className="size-3.5" />Try again
          </Button>
        )}
        {item.state !== "sending" && item.state !== "added" && (
          <button type="button" onClick={onRemove} disabled={disabled} aria-label={`Remove ${item.file.name}`} className="-mr-1.5 flex size-7 flex-none items-center justify-center rounded-md text-muted hover:bg-hover hover:text-ink disabled:opacity-50">
            <X aria-hidden className="size-4" />
          </button>
        )}
      </div>
      {editable && (
        <div className="mt-2.5 grid gap-x-3 gap-y-2 pl-7 sm:grid-cols-[minmax(0,1fr)_10.5rem]">
          <div className="text-sm">
            <label htmlFor={`${id}-witness`} className="text-xs text-muted">Witness</label>
            <input id={`${id}-witness`} className={cx(inputClass, "mt-1")} list={witnessList} value={item.witness} maxLength={200} disabled={disabled}
              onChange={(e) => onChange({ witness: e.target.value })} aria-invalid={missing} aria-describedby={missing ? `${id}-missing` : undefined} />
            {missing && <p id={`${id}-missing`} className="mt-1 text-xs text-context">Add the witness for this file.</p>}
          </div>
          <div className="text-sm">
            <label htmlFor={`${id}-date`} className="text-xs text-muted">Date taken <span className="text-faint">(optional)</span></label>
            <div className="mt-1"><DateInput id={`${id}-date`} value={item.takenOn} onChange={(d) => onChange({ takenOn: d })} /></div>
          </div>
        </div>
      )}
      {!problem && !editable && (
        <p className="mt-1 pl-7 text-xs text-muted">{item.witness.trim()} · {item.takenOn || "date read from the transcript"}</p>
      )}
      {problem && <p className="mt-2 pl-7 text-sm text-context">{problem}</p>}
      {item.error && <p className="mt-2 pl-7 text-sm text-conflict">{item.error}</p>}
    </li>
  );
}

function DropZone({ onFiles, compact, disabled }: { onFiles: (files: File[]) => void; compact: boolean; disabled: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const drop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    if (!disabled) onFiles([...(e.dataTransfer.files ?? [])]);
  };
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={drop}
      className={cx("flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-6 text-center transition-colors", compact ? "py-5" : "min-h-56 py-8", over ? "border-slate bg-info-bg" : "border-control bg-well")}
    >
      {!compact && <UploadCloud aria-hidden className="size-7 text-slate" strokeWidth={1.5} />}
      <div>
        <p className="font-medium">{compact ? "Drop more files here" : "Drop deposition files here"}</p>
        <p className="mt-0.5 text-sm text-muted">PDF (typed or scanned), .txt, .asc, .rtf or .docx. Up to {MAX_UPLOAD_MB} MB each.</p>
      </div>
      <Button variant="secondary" disabled={disabled} onClick={() => input.current?.click()}>{compact ? "Choose more files" : "Choose files"}</Button>
      <input ref={input} type="file" multiple className="sr-only" tabIndex={-1} accept={ACCEPT} onChange={(e) => { onFiles([...(e.target.files ?? [])]); e.target.value = ""; }} />
    </div>
  );
}

function TextShape({ shape }: { shape: ReturnType<typeof describeText> }) {
  if (shape.lines === 0) return null;
  return shape.numbered ? (
    <Alert tone="info" title="Page and line numbers found">
      About {shape.pages} {shape.pages === 1 ? "page" : "pages"} and {shape.lines.toLocaleString()} lines. Findings will cite the transcript's own page:line.
    </Alert>
  ) : (
    <Alert tone="warn" title="No page and line numbers found">
      {shape.lines.toLocaleString()} lines. Findings will cite the line of this text (for example “Line 240”), which is not an official citation, and they are held at Needs context.
    </Alert>
  );
}
