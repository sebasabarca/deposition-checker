// Add a deposition from anywhere: a PDF, a .txt file, or text pasted in. Text with page and line
// numbers keeps them; text without is still accepted and cited by its line in the file.

import { useEffect, useId, useMemo, useRef, useState, type DragEvent, type FormEvent } from "react";
import { ClipboardPaste, FileText, FileType2, UploadCloud } from "lucide-react";
import { api } from "../lib/api";
import { describeText } from "../lib/textTranscript";
import { href } from "../lib/router";
import { useUser } from "../lib/session";
import type { CaseSummary } from "../types";
import { Alert, Button, cx, Dialog, Field, fieldClass, inputClass, selectClass } from "./ui";
import { DateInput } from "./DateInput";

const MAX_UPLOAD_MB = 50; // server/src/api/depositions.ts
type Source = "pdf" | "txt" | "paste";
const SOURCES: { id: Source; label: string; icon: typeof FileText; note: string }[] = [
  { id: "pdf", label: "PDF", icon: FileType2, note: "A transcript PDF, typeset or scanned." },
  { id: "txt", label: "Text file", icon: FileText, note: "A .txt transcript, as the court reporter sent it." },
  { id: "paste", label: "Paste text", icon: ClipboardPaste, note: "Copy the transcript from anywhere and paste it here." },
];
const NEW_CASE = "new";

export function AddDeposition({ open, caseId, onClose }: { open: boolean; caseId?: number; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title="Add deposition" description="One session of one witness. Veridict reads it into page and line references before it can be checked." size="xl">
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
  const [takenOn, setTakenOn] = useState("");
  const [source, setSource] = useState<Source>("pdf");
  const [file, setFile] = useState<File | null>(null);
  const [pasted, setPasted] = useState("");
  const [fileText, setFileText] = useState<string | null>(null);
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

  const pickFile = (f: File | null) => {
    setError(null);
    setFile(f);
    setFileText(null);
    if (f && source === "txt") f.text().then(setFileText).catch(() => setFileText(null));
  };
  const switchSource = (s: Source) => {
    setSource(s);
    setFile(null);
    setFileText(null);
    setError(null);
  };

  const text = source === "paste" ? pasted : source === "txt" ? fileText : null;
  const shape = useMemo(() => (text ? describeText(text) : null), [text]);
  const tooBig = !!file && file.size > MAX_UPLOAD_MB * 1024 * 1024;
  const wrongType = !!file && (source === "pdf" ? !/\.pdf$/i.test(file.name) && file.type !== "application/pdf" : !/\.(txt|text)$/i.test(file.name) && !file.type.startsWith("text/"));
  const hasSource = source === "paste" ? pasted.trim().length > 0 : !!file && !tooBig && !wrongType;
  const caseReady = caseChoice === NEW_CASE ? newCase.trim().length > 0 : /^\d+$/.test(caseChoice);
  const verified = useUser()?.emailVerified ?? false;
  const ready = verified && hasSource && caseReady && witness.trim().length > 0 && !busy;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const target = caseChoice === NEW_CASE ? (await api.createCase(newCase.trim())).case.id : Number(caseChoice);
      const body = source === "paste"
        ? new File([pasted], `Pasted transcript, ${witness.trim()}${takenOn ? ` ${takenOn}` : ""}.txt`, { type: "text/plain" })
        : file!;
      const { deposition } = await api.upload(target, body, witness.trim(), takenOn || undefined);
      onClose();
      window.location.hash = href.deposition(deposition.id);
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
            <select id={`${ids}-case`} className={cx(selectClass, "w-full")} value={caseChoice} onChange={(e) => setCaseChoice(e.target.value)} disabled={!cases}>
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
          <Field label="Witness" htmlFor={`${ids}-witness`} hint={witnesses.length ? "Pick a witness in this case or type a new name." : "The person deposed, as you want them named in citations."}>
            <input id={`${ids}-witness`} autoFocus className={inputClass} list={`${ids}-witnesses`} value={witness} onChange={(e) => setWitness(e.target.value)} required maxLength={200} placeholder="Marcus Webb" />
            <datalist id={`${ids}-witnesses`}>{witnesses.map((w) => <option key={w} value={w} />)}</datalist>
          </Field>
          <Field label="Date taken" htmlFor={`${ids}-date`} hint="Used to order the sessions and in citations.">
            <DateInput id={`${ids}-date`} value={takenOn} onChange={setTakenOn} />
          </Field>
        </div>

        <div className="min-w-0 space-y-4 px-6 py-5">
          <div role="radiogroup" aria-label="Source" className="grid grid-cols-3 gap-1 rounded-lg bg-rule p-1">
            {SOURCES.map((s) => (
              <button key={s.id} type="button" role="radio" aria-checked={source === s.id} onClick={() => switchSource(s.id)} className={cx("flex h-9 items-center justify-center gap-2 rounded-md text-sm font-medium transition-colors", source === s.id ? "bg-sheet text-ink ring-1 ring-line" : "text-muted hover:text-ink")}>
                <s.icon aria-hidden className="size-4" strokeWidth={1.75} />
                <span className="max-sm:sr-only">{s.label}</span>
              </button>
            ))}
          </div>
          <p className="text-sm text-muted">{SOURCES.find((s) => s.id === source)!.note}</p>

          {source === "paste" ? (
            <div>
              <label htmlFor={`${ids}-paste`} className="sr-only">Transcript text</label>
              <textarea
                id={`${ids}-paste`}
                value={pasted}
                onChange={(e) => setPasted(e.target.value)}
                rows={14}
                spellCheck={false}
                placeholder={"12   Q.  Where were you on the morning of June 4th?\n13   A.  At the depot on Kerr Street, from about six."}
                className={cx(fieldClass, "w-full resize-y py-2.5 font-mono text-[13px] leading-6 whitespace-pre")}
              />
            </div>
          ) : (
            <DropZone source={source} file={file} onFile={pickFile} />
          )}

          {shape && <TextShape shape={shape} />}
          {tooBig && <Alert tone="warn">This file is larger than {MAX_UPLOAD_MB} MB.</Alert>}
          {wrongType && <Alert tone="warn">{source === "pdf" ? "This isn't a PDF. Choose “Text file” for a .txt transcript." : "This isn't a .txt file. Choose “PDF” for a PDF."}</Alert>}
          {!verified && <Alert tone="warn" title="Verify your email first">Open the link we emailed you, then add depositions. You can send a new link from the banner at the top of the page.</Alert>}
          {error && <Alert>{error}</Alert>}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-rule px-6 py-3.5">
        <p className="text-xs text-faint">The original is stored exactly as uploaded. Nothing is sent to a model until you start a check.</p>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={!ready}>{busy ? "Adding…" : "Add deposition"}</Button>
        </div>
      </div>
    </form>
  );
}

function DropZone({ source, file, onFile }: { source: Source; file: File | null; onFile: (f: File | null) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const drop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    onFile(e.dataTransfer.files?.[0] ?? null);
  };
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={drop}
      className={cx("flex min-h-56 flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-6 py-8 text-center transition-colors", over ? "border-slate bg-info-bg" : "border-control bg-well")}
    >
      <UploadCloud aria-hidden className="size-7 text-slate" strokeWidth={1.5} />
      {file ? (
        <div>
          <p className="font-medium break-all">{file.name}</p>
          <p className="mt-0.5 text-sm text-muted tabular-nums">{(file.size / 1024 / 1024).toFixed(file.size < 1024 * 1024 ? 2 : 1)} MB</p>
        </div>
      ) : (
        <div>
          <p className="font-medium">Drop the {source === "pdf" ? "PDF" : ".txt file"} here</p>
          <p className="mt-0.5 text-sm text-muted">{source === "pdf" ? `Up to ${MAX_UPLOAD_MB} MB. Scans are read by OCR.` : "Plain text, any length."}</p>
        </div>
      )}
      <Button variant="secondary" onClick={() => input.current?.click()}>{file ? "Choose another file" : "Choose file"}</Button>
      <input ref={input} type="file" className="sr-only" tabIndex={-1} accept={source === "pdf" ? "application/pdf,.pdf" : "text/plain,.txt"} onChange={(e) => onFile(e.target.files?.[0] ?? null)} />
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
