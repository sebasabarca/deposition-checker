import { FindingRegister } from "../components/FindingRegister";
import { Alert, Loading, PageHeader } from "../components/ui";
import { reviewOf, useReviews } from "../lib/review";
import { useWorkspace, useWorkspaceFindings } from "../lib/workspace";

export function FindingsPage({ reviewQueue }: { reviewQueue?: boolean }) {
  const { data, error } = useWorkspace();
  const { findings, error: findingsError } = useWorkspaceFindings(data);
  const reviews = useReviews();
  const rows = (findings ?? []).filter((f) => !reviewQueue || reviewOf(f.id, f.reviewState, reviews) === "unreviewed").map((f) => ({ ...f, analysisId: f.analysis.id }));
  const failure = error ?? findingsError;
  return (
    <>
      <PageHeader
        title={reviewQueue ? "Review queue" : "Findings"}
        description={reviewQueue ? "Findings no person has decided yet, across every analysis. Decisions are saved in this browser until the review service is available." : "Every finding across every analysis, grouped the same way as a single analysis."}
      />
      {failure && <Alert title="Findings couldn't be loaded">{failure}</Alert>}
      {!findings && !failure && <Loading />}
      {findings && <FindingRegister key={String(reviewQueue)} findings={rows} emptyTitle={reviewQueue ? "Nothing is waiting for review" : "No findings yet"} />}
    </>
  );
}
