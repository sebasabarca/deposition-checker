// Add depositions from anywhere: one or more files (PDF, or a court reporter's text, RTF or Word
// export) into one drop zone, or text pasted in. Case and witness are shared by the batch; each file
// may carry its date, and a date left empty is looked for on the transcript's cover and confirmed in
// the case before any check.

import { useEffect, useId, useMemo, useRef, useState, type DragEvent, type FormEvent } from "react";
import { ClipboardPaste, FileText, UploadCloud, X } from "lucide-react";
import { api } from "../lib/api";
import { describeText } from "../lib/textTranscript";
import { href } from "../lib/router";
import { useUser } from "../lib/session";
import type { CaseSummary } from "../types";
import { Alert, Button, cx, Dialog, Field, fieldClass, inputClass, selectClass } from "./ui";
import { DateInput } from "./DateInput";

const MAX_UPLOAD_MB = 50; // server/src/api/depositions.ts
const NEW_CASE = "new";
const PLAIN = /\.(txt|text|asc)$/i; // read here to preview its shape
const SUPPORTED = /\.(pdf|txt|text|asc|rtf|docx)$/i;
const PROPRIETARY = /\.(ptx|ptz|lef|ptf)$/i; // server/src/ingest/formats.ts
const ACCEPT = "application/pdf,.pdf,text/plain,.txt,.asc,.rtf,application/rtf,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document";

type Item = { key: string; file: File; takenOn: string; shape: ReturnType<typeof describeText> | null; state: "waiting" | "sending" | "added" | "failed"; error?: string };

// Why a file can't be sent, in plain words; null when it can.
function problemOf(f: File): string | null {
  if (PROPRIETARY.test(f.name)) return "E-Transcript (.ptx, .ptz), LiveNote (.lef) and .ptf files are proprietary. Export the transcript as plain text (.txt) from the free E-Transcript viewer, or ask the court reporter for the text or PDF transcript.";
  if (!SUPPORTED.test(f.name) && f.type !== "application/pdf" && !f.type.startsWith("text/")) return "Not a transcript file Veridict can read. Use a PDF, .txt, .asc, .rtf or .docx file.";
  if (f.size > MAX_UPLOAD_MB * 1024 * 1024) return `Larger than ${MAX_UPLOAD_MB} MB.`;
  return null;
}

export function AddDeposition({ open, caseId, onClose }: { open: boolean; caseId?: number; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title="Add depositions" description="One or more sessions of one witness. Veridict reads each into page and line references before they can be checked." size="xl">
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
      setWitness((w) => w || names[0] || "");
    }).catch(() => setWitnesses([]));
  }, [caseChoice]);

  const update = (key: string, change: Partial<Item>) => setItems((all) => all.map((i) => (i.key === key ? { ...i, ...change } : i)));
  const addFiles = (files: File[]) => {
    setError(null);
    const added = files.map((file): Item => ({ key: `${file.name}-${file.size}-${file.lastModified}-${Math.random()}`, file, takenOn: "", shape: null, state: "waiting" }));
    setItems((all) => [...all.filter((i) => i.state !== "added"), ...added]);
    for (const item of added) if (PLAIN.test(item.file.name)) item.file.text().then((t) => update(item.key, { shape: describeText(t) })).catch(() => undefined);
  };
  const remove = (key: string) => setItems((all) => all.filter((i) => i.key !== key));

  const pastedShape = useMemo(() => (pasting && pasted.trim() ? describeText(pasted) : null), [pasting, pasted]);
  const sendable = pasting ? (pasted.trim() ? 1 : 0) : items.filter((i) => i.state !== "added" && !problemOf(i.file)).length;
  const caseReady = caseChoice === NEW_CASE ? newCase.trim().length > 0 : /^\d+$/.test(caseChoice);
  const verified = useUser()?.emailVerified ?? false;
  const ready = verified && sendable > 0 && caseReady && witness.trim().length > 0 && !busy;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const target = caseChoice === NEW_CASE ? (await api.createCase(newCase.trim())).case.id : Number(caseChoice);
      if (caseChoice === NEW_CASE) setCaseChoice(String(target)); // a retry adds to the case just made
      const name = witness.trim();
      if (pasting) {
        const body = new File([pasted], `Pasted transcript, ${name}${pastedDate ? ` ${pastedDate}` : ""}.txt`, { type: "text/plain" });
        const { deposition } = await api.upload(target, body, name, pastedDate || undefined);
        onClose();
        window.location.hash = href.deposition(deposition.id);
        return;
      }
      // One at a time, so a failure is reported against its file and the rest still go through.
      const queue = items.filter((i) => i.state !== "added" && !problemOf(i.file));
      const added: number[] = [];
      for (const item of queue) {
        update(item.key, { state: "sending", error: undefined });
        try {
          const { deposition } = await api.upload(target, item.file, name, item.takenOn || undefined);
          added.push(deposition.id);
          update(item.key, { state: "added" });
        } catch (err) {
          update(item.key, { state: "failed", error: (err as Error).message });
        }
      }
      if (added.length === queue.length) {
        onClose();
        window.location.hash = added.length === 1 ? href.deposition(added[0]) : href.case(target);
      } else setBusy(false);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

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
          <Field label="Witness" htmlFor={`${ids}-witness`} hint={`${witnesses.length ? "Pick a witness in this case or type a new name. " : ""}Every file you add here is a session of this witness.`}>
            <input id={`${ids}-witness`} autoFocus className={inputClass} list={`${ids}-witnesses`} value={witness} onChange={(e) => setWitness(e.target.value)} required maxLength={200} placeholder="Marcus Webb" disabled={busy} />
            <datalist id={`${ids}-witnesses`}>{witnesses.map((w) => <option key={w} value={w} />)}</datalist>
          </Field>
          <p className="text-xs leading-5 text-muted">Leave a date empty and Veridict looks for it on the transcript's cover. You confirm it in the case before running a check. You can change the date, witness or case later from the deposition's page.</p>
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
                  {items.map((item) => <FileRow key={item.key} item={item} disabled={busy} onDate={(d) => update(item.key, { takenOn: d })} onRemove={() => remove(item.key)} />)}
                </ul>
              )}
              <button type="button" onClick={() => setPasting(true)} disabled={busy} className="flex items-center gap-1.5 text-sm font-medium text-info hover:underline disabled:opacity-50">
                <ClipboardPaste aria-hidden className="size-4" />Paste the transcript text instead
              </button>
            </>
          )}

          {!verified && <Alert tone="warn" title="Verify your email first">Open the link we emailed you, then add depositions. You can send a new link from the banner at the top of the page.</Alert>}
          {error && <Alert>{error}</Alert>}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-rule px-6 py-3.5">
        <p className="text-xs text-faint">The original is stored exactly as uploaded. Nothing is sent to a model until you start a check.</p>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={!ready}>{busy ? "Adding…" : sendable > 1 ? `Add ${sendable} depositions` : "Add deposition"}</Button>
        </div>
      </div>
    </form>
  );
}

function FileRow({ item, disabled, onDate, onRemove }: { item: Item; disabled: boolean; onDate: (iso: string) => void; onRemove: () => void }) {
  const id = useId();
  const problem = problemOf(item.file);
  const size = item.file.size / 1024 / 1024;
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <FileText aria-hidden className="mt-0.5 size-4 flex-none text-slate" strokeWidth={1.75} />
        <div className="min-w-0 flex-1 basis-48">
          <p className="truncate font-medium" title={item.file.name}>{item.file.name}</p>
          <p className="text-xs text-muted tabular-nums">
            {size.toFixed(size < 1 ? 2 : 1)} MB
            {item.shape && item.shape.lines > 0 && (item.shape.numbered ? " · page and line numbers found" : " · no page and line numbers: cited by line")}
            {item.state === "sending" && " · sending…"}
            {item.state === "added" && " · added"}
          </p>
        </div>
        {!problem && item.state !== "added" && (
          <div className="flex flex-none items-center gap-2">
            <label htmlFor={id} className="text-xs text-muted">Date taken</label>
            <DateInput id={id} value={item.takenOn} onChange={onDate} />
          </div>
        )}
        {item.state !== "sending" && item.state !== "added" && (
          <button type="button" onClick={onRemove} disabled={disabled} aria-label={`Remove ${item.file.name}`} className="flex size-7 flex-none items-center justify-center rounded-md text-muted hover:bg-hover hover:text-ink disabled:opacity-50">
            <X aria-hidden className="size-4" />
          </button>
        )}
      </div>
      {problem && <p className="mt-2 text-sm text-context">{problem}</p>}
      {item.error && <p className="mt-2 text-sm text-conflict">{item.error}</p>}
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
