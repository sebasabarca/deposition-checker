import { useEffect, useState } from "react";
import { Alert, Empty, Loading, PageHeader } from "../components/ui";
import { api } from "../lib/api";
import { href } from "../lib/router";

// Depositions live inside a case, so this opens the most recent one; its page has a case picker.
export function DepositionsPage() {
  const [none, setNone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.cases()
      .then(({ cases }) => {
        const latest = cases.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        if (latest) window.location.replace(href.case(latest.id));
        else setNone(true);
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  return (
    <>
      <PageHeader title="Depositions" />
      {error && <Alert title="Depositions couldn't be loaded">{error}</Alert>}
      {none && <Empty title="No cases yet">Depositions belong to a case. <a className="font-semibold text-secondary" href={href.cases()}>Create one first</a>.</Empty>}
      {!none && !error && <Loading />}
    </>
  );
}
