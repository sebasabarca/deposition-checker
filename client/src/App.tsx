import { useEffect, useState } from "react";
import { FindingCard } from "./FindingCard";
import type { AnalyzeResponse } from "./types";

export default function App() {
  const [transcript1, setTranscript1] = useState("");
  const [transcript2, setTranscript2] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AnalyzeResponse | null>(null);

  useEffect(() => {
    fetch("/api/samples")
      .then((res) => res.json())
      .then((data) => {
        setTranscript1(data.transcript1);
        setTranscript2(data.transcript2);
      })
      .catch(() =>
        setError(
          "Could not load the sample transcripts. Is the server running?",
        ),
      );
  }, []);

  async function analyze() {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript1, transcript2 }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "The analysis failed.");
      setResult(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The analysis failed.");
    } finally {
      setLoading(false);
    }
  }

  const findings = result?.findings ?? [];
  const contradictions = findings.filter(
    (f) => f.status === "verified" && f.type !== "false_positive",
  );
  const falsePositives = findings.filter(
    (f) => f.status === "verified" && f.type === "false_positive",
  );
  const unverified = findings.filter((f) => f.status === "unverified");

  return (
    <main>
      <h1>Deposition Contradiction Detector</h1>
      <p className="subtitle">
        Claude proposes possible contradictions. This app verifies every quote,
        compares times and scores each finding with its own rules.
      </p>

      <div className="inputs">
        <label>
          Transcript 1 (earlier)
          <textarea
            value={transcript1}
            onChange={(e) => setTranscript1(e.target.value)}
          />
        </label>
        <label>
          Transcript 2 (later)
          <textarea
            value={transcript2}
            onChange={(e) => setTranscript2(e.target.value)}
          />
        </label>
      </div>

      <button
        onClick={analyze}
        disabled={loading || !transcript1.trim() || !transcript2.trim()}
      >
        {loading ? "Analyzing..." : "Find contradictions"}
      </button>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {result && (
        <>
          <section className="legend" aria-label="Legend">
            <span className="chip chip-direct">Direct</span> explicitly opposite
            statements
            <span className="chip chip-inferential">Inferential</span> both
            cannot be true
            <span className="chip chip-false_positive">
              False positive
            </span>{" "}
            imprecise language, not a change
            <p className="note">
              Confidence is a heuristic score from this app’s rules, not a
              probability.
            </p>
          </section>

          <h2>Contradictions ({contradictions.length})</h2>
          {contradictions.length === 0 && (
            <p className="empty">No verified contradictions found.</p>
          )}
          {contradictions.map((f) => (
            <FindingCard
              key={`${f.t1_id}-${f.t2_id}`}
              finding={f}
              t1={result.t1}
              t2={result.t2}
            />
          ))}

          {unverified.length > 0 && (
            <>
              <h2>Unverified evidence ({unverified.length})</h2>
              <p className="note">
                Claude cited quotes this app could not find in the transcripts.
                Check these manually before relying on them.
              </p>
              {unverified.map((f) => (
                <FindingCard
                  key={`${f.t1_id}-${f.t2_id}`}
                  finding={f}
                  t1={result.t1}
                  t2={result.t2}
                />
              ))}
            </>
          )}

          {falsePositives.length > 0 && (
            <details className="false-positives">
              <summary>
                Considered and rejected as false positives (
                {falsePositives.length})
              </summary>
              {falsePositives.map((f) => (
                <FindingCard
                  key={`${f.t1_id}-${f.t2_id}`}
                  finding={f}
                  t1={result.t1}
                  t2={result.t2}
                />
              ))}
            </details>
          )}
        </>
      )}
    </main>
  );
}
