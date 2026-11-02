// Home: every case, most recently active first, with what it needs next.

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { ChevronRight, Plus, Search } from "lucide-react";
import { Crumbs } from "../components/Shell";
import { Alert, Badge, Button, Card, Dialog, Empty, Field, inputClass, Loading, PageHeader, type Tone } from "../components/ui";
import { api } from "../lib/api";
import { formatDate } from "../lib/labels";
import { href, usePoll } from "../lib/router";
import type { CaseSummary } from "../types";

function statusOf(c: CaseSummary): { label: string; tone: Tone } {
  if (c.checking) return { label: "Checking…", tone: "active" };
  if (c.needsReview > 0) return { label: `${c.needsReview} ${c.needsReview === 1 ? "finding needs" : "findings need"} review`, tone: "contradiction" };
  if (c.depositions === 0) return { label: "No depositions yet", tone: "neutral" };
  if (c.reports === 0) return { label: "Ready to check", tone: "good" };
  return { label: "All reviewed", tone: "good" };
}

export function CasesPage() {
  const [cases, setCases] = useState<CaseSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
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

  return (
    <>
      <Crumbs items={[{ label: "Cases" }]} />
      <PageHeader title="Cases" actions={<Button className="h-10" onClick={() => setCreating(true)}><Plus aria-hidden className="size-[18px]" />New case</Button>} />
      {error && <Alert title="Your cases couldn't be loaded">{error}</Alert>}
      {!cases && !error && <Loading />}
      {cases?.length === 0 && (
        <Empty title="No cases yet">
          Create a case to upload depositions.
          <div className="mt-space-md"><Button onClick={() => setCreating(true)}>New case</Button></div>
        </Empty>
      )}
      {cases && cases.length > 0 && (
        <>
          <Card className="p-1.5">
            <div className="relative">
              <Search aria-hidden className="absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-on-surface-variant" />
              <input value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search cases or witnesses" placeholder="Search cases or witnesses" className="h-10 w-full rounded-xl bg-white/60 pr-4 pl-10 text-body-md" />
            </div>
          </Card>
          {shown.length === 0 ? <Empty title="No cases match this search" /> : (
            <ul className="space-y-space-sm">
              {shown.map((c) => {
                const s = statusOf(c);
                return (
                  <li key={c.id}>
                    <a href={href.case(c.id)} className="glass group flex flex-col justify-between gap-3 rounded-2xl p-space-lg transition-colors hover:bg-white/85 lg:flex-row lg:items-center">
                      <span className="min-w-0">
                        <span className="block text-headline-md group-hover:text-secondary">{c.name}</span>
                        <span className="mt-0.5 block text-body-sm text-on-surface-variant">
                          {c.witnessNames.length ? c.witnessNames.join(", ") : "No witnesses yet"} · {c.depositions} {c.depositions === 1 ? "deposition" : "depositions"}
                        </span>
                      </span>
                      <span className="flex flex-none items-center justify-between gap-5">
                        <Badge tone={s.tone} dot>{s.label}</Badge>
                        <span className="text-label-sm text-on-surface-variant tabular-nums">{formatDate(c.lastActivity)}</span>
                        <ChevronRight aria-hidden className="size-5 text-on-surface-variant" />
                      </span>
                    </a>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
      <Dialog open={creating} onClose={() => setCreating(false)} title="New case"><NewCase onCancel={() => setCreating(false)} /></Dialog>
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
    <form onSubmit={submit} className="space-y-4 p-space-lg">
      <Field label="Case name"><input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} autoFocus placeholder="Webb v. Harlow" /></Field>
      {error && <Alert>{error}</Alert>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button type="submit" disabled={busy || !name.trim()}>{busy ? "Creating…" : "Create case"}</Button>
      </div>
    </form>
  );
}
