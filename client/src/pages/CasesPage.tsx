import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Alert, Badge, Button, Card, CardHeader, Empty, Field, inputClass, Loading } from "../components/ui";
import { api } from "../lib/api";
import { ANALYSIS_STATUS } from "../lib/labels";
import { href } from "../lib/router";
import type { CaseSummary } from "../types";

export function CasesPage() {
  const [cases, setCases] = useState<CaseSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api.cases().then((r) => setCases(r.cases)).catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
      <Card>
        <CardHeader title="Cases" description="Each case holds the witnesses, deposition sessions and analyses for one matter." />
        <div className="p-5">
          {error && <Alert>{error}</Alert>}
          {!cases && !error && <Loading />}
          {cases && cases.length === 0 && <Empty title="No cases yet">Create a case to upload depositions.</Empty>}
          {cases && cases.length > 0 && (
            <ul className="divide-y divide-slate-100">
              {cases.map((c) => (
                <li key={c.id}>
                  <a href={href.case(c.id)} className="flex flex-wrap items-center justify-between gap-3 rounded-md px-2 py-3 hover:bg-slate-50">
                    <div className="min-w-0">
                      <p className="truncate font-medium text-slate-900">{c.name}</p>
                      <p className="text-sm text-slate-600">
                        {c.witnesses} {c.witnesses === 1 ? "witness" : "witnesses"} · {c.depositions} {c.depositions === 1 ? "deposition" : "depositions"} · {c.lastAnalysis ? `${c.findings} ${c.findings === 1 ? "finding" : "findings"} in the latest analysis` : "not analysed yet"}
                      </p>
                    </div>
                    {c.lastAnalysis ? <Badge tone={ANALYSIS_STATUS[c.lastAnalysis.status].tone === "active" ? "active" : ANALYSIS_STATUS[c.lastAnalysis.status].tone}>Last analysis: {ANALYSIS_STATUS[c.lastAnalysis.status].label}</Badge> : <Badge>No analysis yet</Badge>}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>
      <NewCase onCreated={(id) => (window.location.hash = href.case(id))} />
    </div>
  );
}

function NewCase({ onCreated }: { onCreated: (id: number) => void }) {
  const [name, setName] = useState("");
  const [witness, setWitness] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await api.createCase(name.trim(), witness.trim() || undefined);
      onCreated(created.case.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="self-start">
      <CardHeader title="New case" />
      <form onSubmit={submit} className="space-y-4 p-5">
        <Field label="Case name">
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="U.S. v. Oracle" required maxLength={200} />
        </Field>
        <Field label="First witness" hint="Optional. You can add witnesses when you upload a deposition.">
          <input className={inputClass} value={witness} onChange={(e) => setWitness(e.target.value)} placeholder="Lawrence Ellison" maxLength={200} />
        </Field>
        {error && <Alert>{error}</Alert>}
        <Button type="submit" disabled={busy || !name.trim()} className="w-full">
          {busy ? "Creating…" : "Create case"}
        </Button>
      </form>
    </Card>
  );
}
