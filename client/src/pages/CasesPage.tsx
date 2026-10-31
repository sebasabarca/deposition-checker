import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Alert, Badge, Button, Card, CardHeader, cx, Empty, Field, inputClass, Loading, PageHeader, tdClass, thClass } from "../components/ui";
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
    <>
      <PageHeader title="Cases" description="Each case holds the witnesses, deposition sessions and analyses for one matter." />
      <div className="grid grid-cols-1 gap-space-lg lg:grid-cols-[minmax(0,1fr)_20rem]">
        <Card className="overflow-hidden">
          {error && <div className="p-space-md"><Alert>{error}</Alert></div>}
          {!cases && !error && <Loading />}
          {cases && cases.length === 0 && <div className="p-space-md"><Empty title="No cases yet">Create a case to upload depositions.</Empty></div>}
          {cases && cases.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[40rem] border-collapse text-left">
                <thead className="bg-surface-container-low text-on-surface-variant">
                  <tr>{["Case", "Witnesses", "Depositions", "Findings", "Latest analysis"].map((h) => <th key={h} className={thClass}>{h}</th>)}</tr>
                </thead>
                <tbody>
                  {cases.map((c) => {
                    const s = c.lastAnalysis && ANALYSIS_STATUS[c.lastAnalysis.status];
                    return (
                      <tr key={c.id} className="group transition-colors hover:bg-surface-container-low/70">
                        <td className={tdClass}><a href={href.case(c.id)} className="font-semibold group-hover:text-secondary">{c.name}</a></td>
                        <td className={cx(tdClass, "tabular-nums")}>{c.witnesses}</td>
                        <td className={cx(tdClass, "tabular-nums")}>{c.depositions}</td>
                        <td className={cx(tdClass, "tabular-nums")}>{c.lastAnalysis ? c.findings : "—"}</td>
                        <td className={tdClass}>{s ? <Badge tone={s.tone} dot>{s.label}</Badge> : <Badge>No analysis yet</Badge>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <NewCase onCreated={(id) => (window.location.hash = href.case(id))} />
      </div>
    </>
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
      <form onSubmit={submit} className="space-y-4 px-space-lg pb-space-lg">
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
