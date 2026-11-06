// Every case, most recently active first, with what each needs next.

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Pencil, Plus } from "lucide-react";
import { Alert, Badge, Button, Card, cx, Dialog, Empty, Field, inputClass, Loading, PageHeader, rowClass, Search, tdClass, thClass, type Tone } from "../components/ui";
import { RenameCase } from "../components/RenameCase";
import { api } from "../lib/api";
import { relativeTime } from "../lib/insights";
import { href, usePoll } from "../lib/router";
import type { CaseSummary } from "../types";

function statusOf(c: CaseSummary): { label: string; tone: Tone } {
  if (c.checking) return { label: "Analyzing", tone: "active" };
  if (c.needsReview > 0) return { label: `${c.needsReview} to decide`, tone: "contradiction" };
  if (c.depositions === 0) return { label: "No depositions yet", tone: "neutral" };
  if (c.reports === 0) return { label: "Ready to analyze", tone: "neutral" };
  return { label: "All decided", tone: "good" };
}

export function CasesPage() {
  const [cases, setCases] = useState<CaseSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<CaseSummary | null>(null);
  const [q, setQ] = useState("");
  const load = useCallback(() => {
    api.cases().then((r) => setCases(r.cases)).catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);
  usePoll(!!cases?.some((c) => c.checking), 5000, load);
  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (cases ?? []).filter((c) => !term || [c.name, ...c.witnessNames].some((s) => s.toLowerCase().includes(term)));
  }, [cases, q]);
  const now = Date.now();

  return (
    <>
      <PageHeader title="Cases" description={cases ? `${cases.length} ${cases.length === 1 ? "case" : "cases"}, most recently active first.` : undefined} actions={<Button onClick={() => setCreating(true)}><Plus aria-hidden className="size-4" />New case</Button>} />
      {error && <Alert title="Your cases couldn't be loaded">{error}</Alert>}
      {!cases && !error && <Loading label="Loading cases" />}
      {cases?.length === 0 && <Empty title="No cases yet" action={<Button onClick={() => setCreating(true)}>New case</Button>}>A case holds the depositions of one matter. Create one, then add its depositions.</Empty>}
      {cases && cases.length > 0 && (
        <Card className="overflow-hidden">
          <div className="border-b border-rule px-5 py-3"><Search value={q} onChange={setQ} label="Search cases or witnesses" className="max-w-sm" /></div>
          {shown.length === 0 ? <p className="px-5 py-6 text-sm text-muted">No case or witness matches “{q}”.</p> : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[46rem] text-sm">
                <thead><tr><th className={thClass}>Case</th><th className={thClass}>Witnesses</th><th className={cx(thClass, "text-right")}>Depositions</th><th className={cx(thClass, "text-right")}>Analyses</th><th className={thClass}>Next</th><th className={cx(thClass, "text-right")}>Last activity</th></tr></thead>
                <tbody>
                  {shown.map((c) => {
                    const s = statusOf(c);
                    return (
                      <tr key={c.id} className={cx(rowClass, "cursor-pointer")} onClick={(e) => !(e.target as HTMLElement).closest("a, button") && (window.location.hash = href.case(c.id))}>
                        <td className={tdClass}>
                          <span className="flex items-center gap-1">
                            <a href={href.case(c.id)} className="font-semibold hover:underline">{c.name}</a>
                            <button type="button" onClick={() => setRenaming(c)} aria-label={`Rename ${c.name}`} title="Rename" className="-my-1 inline-flex size-7 flex-none items-center justify-center rounded-md text-faint transition-colors hover:bg-rule hover:text-ink">
                              <Pencil aria-hidden className="size-3.5" />
                            </button>
                          </span>
                        </td>
                        <td className={cx(tdClass, "text-muted")}>{c.witnessNames.join(", ") || "–"}</td>
                        <td className={cx(tdClass, "text-right tabular-nums")}>{c.depositions}</td>
                        <td className={cx(tdClass, "text-right tabular-nums")}>{c.reports}</td>
                        <td className={tdClass}><Badge tone={s.tone} dot>{s.label}</Badge></td>
                        <td className={cx(tdClass, "text-right text-muted tabular-nums")}>{relativeTime(c.lastActivity, now)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
      {renaming && <RenameCase caseId={renaming.id} name={renaming.name} open onClose={() => setRenaming(null)} onRenamed={(name) => { setCases((cs) => cs && cs.map((x) => (x.id === renaming.id ? { ...x, name } : x))); setRenaming(null); }} />}
      <Dialog open={creating} onClose={() => setCreating(false)} title="New case" description="A case holds the depositions of one matter."><NewCase onCancel={() => setCreating(false)} /></Dialog>
    </>
  );
}

function NewCase({ onCancel }: { onCancel: () => void }) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const detail = await api.createCase(name.trim());
      window.location.hash = href.case(detail.case.id);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit}>
      <div className="space-y-4 px-6 py-5">
        <Field label="Case name" htmlFor="case-name"><input id="case-name" className={inputClass} value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} data-autofocus placeholder="Webb v. Harlow Logistics" /></Field>
        {error && <Alert>{error}</Alert>}
      </div>
      <div className="flex justify-end gap-2 border-t border-rule px-6 py-3.5">
        <Button variant="secondary" onClick={onCancel}>Cancel</Button>
        <Button type="submit" disabled={busy || !name.trim()}>{busy ? "Creating…" : "Create case"}</Button>
      </div>
    </form>
  );
}
