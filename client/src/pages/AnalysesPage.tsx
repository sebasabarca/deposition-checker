import { AnalysesTable } from "../components/AnalysesTable";
import { Alert, Card, Loading, PageHeader } from "../components/ui";
import { useWorkspace } from "../lib/workspace";

export function AnalysesPage() {
  const { data, error } = useWorkspace();
  return (
    <>
      <PageHeader title="Analyses" description="Each analysis compares two sessions of one witness." />
      {error && <Alert title="Analyses couldn't be loaded">{error}</Alert>}
      {!data && !error && <Loading />}
      {data && <Card className="overflow-hidden"><AnalysesTable analyses={data.analyses} details={data.details} /></Card>}
    </>
  );
}
