import type { ContradictionType, Finding, QAPair } from "./types";

export const TYPE_LABELS: Record<ContradictionType, string> = {
  direct: "Direct contradiction",
  inferential: "Inferential contradiction",
  false_positive: "Likely false positive",
};

type Props = { finding: Finding; t1: QAPair[]; t2: QAPair[] };

function Statement({ label, id, quote, pairs }: { label: string; id: string; quote: string; pairs: QAPair[] }) {
  const pair = pairs.find((p) => p.id === id);
  return (
    <div className="statement">
      <div className="statement-label">
        {label} · {id}
      </div>
      {pair && <div className="statement-question">Q: {pair.question}</div>}
      <blockquote>“{quote}”</blockquote>
    </div>
  );
}

export function FindingCard({ finding, t1, t2 }: Props) {
  const verified = finding.status === "verified";
  const chipClass = verified ? `chip chip-${finding.type}` : "chip chip-unverified";

  return (
    <article className={`card card-${verified ? finding.type : "unverified"}`}>
      <header className="card-header">
        <span className={chipClass}>{verified ? TYPE_LABELS[finding.type] : "Unverified evidence"}</span>
        {verified && finding.band ? (
          <span className={`confidence confidence-${finding.band}`}>
            {finding.band.charAt(0).toUpperCase() + finding.band.slice(1)} confidence · {finding.confidence}/100
          </span>
        ) : (
          <span className="confidence confidence-none">Check manually · Claude suggested: {TYPE_LABELS[finding.type]}</span>
        )}
      </header>

      <div className="statements">
        <Statement label="Transcript 1" id={finding.t1_id} quote={finding.t1_quote} pairs={t1} />
        <Statement label="Transcript 2" id={finding.t2_id} quote={finding.t2_quote} pairs={t2} />
      </div>

      <p className="explanation">
        <strong>Claude’s explanation:</strong> {finding.explanation}
      </p>

      <details>
        <summary>Why this score</summary>
        <ul>
          {finding.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      </details>
    </article>
  );
}
