import { Card, CardHeader, HumanMark, ModelMark, OcrMark, PageHeader, TestimonyMark, VerifiedMark } from "../components/ui";

const CATEGORIES = [
  ["Potential contradictions", "Direct or inferential conflicts whose citations passed verification. Each still needs your judgement."],
  ["Likely compatible", "Passages that look related but can both be true. Their score is support for “compatible”."],
  ["Insufficient evidence", "The two passages alone don't allow a judgement."],
  ["Needs review", "An unverified citation, a self-contradictory assessment, or missing context. These have no score."],
];
const COVERAGE = [
  ["Assessed", "The pair has a verdict: from a model call, a stored earlier run, or a prepared example."],
  ["Unassessed", "The pair was selected but has no verdict, because the run stopped, a call failed or a demo had nothing stored."],
  ["Deferred", "A lower-ranked pair held back by the candidate limit. It is counted, never dropped."],
];

export function HelpPage() {
  return (
    <>
      <PageHeader title="Help" description="How to read what this application shows." />
      <div className="grid gap-space-lg lg:grid-cols-2">
        <Card>
          <CardHeader title="What each mark means" />
          <dl className="space-y-space-md px-space-lg pb-space-lg">
            <div><dt><TestimonyMark /></dt><dd className="mt-1 text-body-sm text-on-surface-variant">Stored transcript lines, verbatim, with their page:line.</dd></div>
            <div><dt><OcrMark /></dt><dd className="mt-1 text-body-sm text-on-surface-variant">Text read from a scan by OCR. It may differ from the scan, so it isn't exact testimony. Each line shows its OCR confidence; check the original scan before quoting.</dd></div>
            <div><dt><ModelMark /></dt><dd className="mt-1 text-body-sm text-on-surface-variant">Written by the model. It is not testimony and not a legal conclusion.</dd></div>
            <div><dt><VerifiedMark /></dt><dd className="mt-1 text-body-sm text-on-surface-variant">Code found the cited words in the stored transcript. This says the citation is real, not that the contradiction is.</dd></div>
            <div><dt><HumanMark>Review status</HumanMark></dt><dd className="mt-1 text-body-sm text-on-surface-variant">What a person decided. Decisions stay in this browser until the review service is available.</dd></div>
          </dl>
        </Card>
        <Card>
          <CardHeader title="Finding categories" />
          <dl className="space-y-space-md px-space-lg pb-space-lg">
            {CATEGORIES.map(([t, d]) => <div key={t}><dt className="font-semibold">{t}</dt><dd className="text-body-sm text-on-surface-variant">{d}</dd></div>)}
          </dl>
        </Card>
        <Card>
          <CardHeader title="Candidate pairs" />
          <dl className="space-y-space-md px-space-lg pb-space-lg">
            {COVERAGE.map(([t, d]) => <div key={t}><dt className="font-semibold">{t}</dt><dd className="text-body-sm text-on-surface-variant">{d}</dd></div>)}
          </dl>
        </Card>
        <Card>
          <CardHeader title="Scores and data" />
          <div className="space-y-space-md px-space-lg pb-space-lg text-body-sm text-on-surface-variant">
            <p>A score is calculated by code from a fixed rubric. It shows how well the checks support the proposed classification. It is not a probability.</p>
            <p>PDFs and results are stored by the server running this application. Live analyses send the selected passages to the model provider's API; demo analyses make no model calls.</p>
            <p>This application makes no certification or compliance claim. A qualified person must confirm any use of a finding.</p>
          </div>
        </Card>
      </div>
    </>
  );
}
