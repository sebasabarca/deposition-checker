// The findings of one report: four categories as tabs, then one row per finding with both passages
// side by side. Each row shows stored lines, fetched per visible row because the list has no text.

import { useEffect, useMemo, useState } from "react";
import { ChevronRight, Search } from "lucide-react";
import { api } from "../lib/api";
import { evidenceStrength, findingHeadline, GROUP_HELP, GROUP_LABEL, PRIORITY, priorityTone } from "../lib/labels";
import { href } from "../lib/router";
import { decisionOf, REVIEW_LABEL } from "../lib/review";
import type { EvidenceSide, FindingDetail, FindingGroup, FindingSummary, ReviewDecision } from "../types";
import { Badge, cx, Empty } from "./ui";

const GROUPS: FindingGroup[] = ["contradictions", "needs_context", "compatible", "unverified"];
const FILTERS: (ReviewDecision | "unreviewed" | "all")[] = ["all", "unreviewed", "confirmed", "needs_context", "dismissed"];
const EMPTY: Record<FindingGroup, string> = {
  contradictions: "None found. That is the model's reading of these sessions, not proof that they agree.",
  needs_context: "Nothing in this category.",
  compatible: "Nothing in this category.",
  unverified: "Nothing in this category.",
};

export function FindingRegister({ findings, analysisId }: { findings: FindingSummary[]; analysisId: number }) {
  const [group, setGroup] = useState<FindingGroup>("contradictions");
  const [decision, setDecision] = useState<(typeof FILTERS)[number]>("all");
  const [q, setQ] = useState("");
  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    return findings.filter((f) => f.group === group && (decision === "all" || decisionOf(f.reviewState) === decision) && (!term || [f.a.ref, f.b.ref, f.subject, f.explanation].some((s) => s?.toLowerCase().includes(term))));
  }, [findings, group, decision, q]);

  return (
    <section className="space-y-space-md">
      <div role="tablist" aria-label="Finding categories" className="grid gap-space-sm sm:grid-cols-2 lg:grid-cols-4">
        {GROUPS.map((g) => (
          <button key={g} type="button" role="tab" aria-selected={group === g} onClick={() => setGroup(g)} className={cx("glass flex items-center justify-between gap-2 rounded-2xl p-space-md text-left transition-colors", group === g ? "bg-white/90 ring-2 ring-secondary" : "hover:bg-white/80")}>
            <span className={cx("text-body-md", group === g ? "font-semibold" : "font-medium text-on-surface-variant")}>{GROUP_LABEL[g]}</span>
            <span className="text-headline-md tabular-nums">{findings.filter((f) => f.group === g).length}</span>
          </button>
        ))}
      </div>
      <p className="text-body-sm text-on-surface-variant">{GROUP_HELP[group]}</p>

      <div className="glass flex flex-col justify-between gap-3 rounded-2xl p-space-sm lg:flex-row lg:items-center">
        <div className="relative w-full lg:max-w-md">
          <Search aria-hidden className="absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-on-surface-variant" />
          <input value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search findings" placeholder="Search by page:line or wording" className="h-10 w-full rounded-xl bg-white/60 pr-4 pl-10 text-body-sm" />
        </div>
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Filter by decision">
          {FILTERS.map((d) => (
            <button key={d} type="button" aria-pressed={decision === d} onClick={() => setDecision(d)} className={cx("rounded-full px-3 py-1.5 text-label-md transition-colors", decision === d ? "bg-secondary text-white" : "text-on-surface-variant hover:bg-white/70")}>
              {d === "all" ? "All" : REVIEW_LABEL[d]}
            </button>
          ))}
        </div>
      </div>

      {shown.length === 0 ? (
        <Empty title={findings.some((f) => f.group === group) ? "No findings match this filter" : EMPTY[group]} />
      ) : (
        <ul className="space-y-space-md">{shown.map((f) => <Row key={f.id} f={f} analysisId={analysisId} />)}</ul>
      )}
    </section>
  );
}

function Row({ f, analysisId }: { f: FindingSummary; analysisId: number }) {
  const decided = decisionOf(f.reviewState);
  return (
    <li>
      <a href={href.analysis(analysisId, f.id)} className="glass group block rounded-2xl p-space-lg transition-colors hover:bg-white/85">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <span className="min-w-0">
            <span className="block text-headline-md group-hover:text-secondary">{f.subject ?? findingHeadline(f)}</span>
            <span className="mt-1 flex flex-wrap items-center gap-1.5">
              <Badge tone={f.group === "contradictions" ? "contradiction" : f.group === "unverified" ? "bad" : "neutral"} dot>{findingHeadline(f)}</Badge>
              {f.group !== "needs_context" && f.group !== "unverified" && <Badge tone={priorityTone(f.priority)}>{PRIORITY[f.priority]}</Badge>}
              {f.source !== "model" && <Badge tone="accent">{f.source === "fixture" ? "Prepared example" : "Stored assessment"}</Badge>}
            </span>
          </span>
          <span className="flex flex-none items-center gap-1">
            <Badge tone={decided === "confirmed" ? "good" : "neutral"}>{REVIEW_LABEL[decided]}</Badge>
            <ChevronRight aria-hidden className="size-5 text-on-surface-variant" />
          </span>
        </div>
        <Quotes id={f.id} />
        <div className="mt-3 flex flex-wrap items-center gap-2 text-label-md text-on-surface-variant">
          {f.group !== "compatible" && <span className="font-semibold text-on-surface tabular-nums">{evidenceStrength(f)}</span>}
          {f.direct?.ocrRead && <Badge tone="warn">{f.direct.lowOcrLines.length ? `Low OCR confidence: ${f.direct.lowOcrLines.join(", ")}` : "OCR text: check the scan"}</Badge>}
          {(f.direct?.duplicates ?? 0) > 0 && <span>{f.direct!.duplicates + 1} proposals merged</span>}
        </div>
      </a>
    </li>
  );
}

function Quotes({ id }: { id: number }) {
  const [f, setF] = useState<FindingDetail | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    api.finding(id).then((r) => setF(r.finding)).catch(() => setFailed(true));
  }, [id]);
  if (failed) return <p className="mt-3 text-body-sm text-on-surface-variant">Testimony couldn't be loaded. Open the finding to retry.</p>;
  if (!f) return <p className="mt-3 text-body-sm text-on-surface-variant">Loading testimony…</p>;
  return (
    <div className="mt-3 grid grid-cols-1 gap-space-sm md:grid-cols-2">
      <Quote side={f.a} />
      <Quote side={f.b} />
    </div>
  );
}

function Quote({ side }: { side: EvidenceSide }) {
  const cited = side.lines.filter((l) => l.highlighted);
  return (
    <blockquote className="rounded-xl bg-white p-3">
      <span className="block text-label-md text-secondary tabular-nums">{new Date(`${side.deposition.takenOn ?? "1970-01-01"}T12:00:00`).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })} · {side.range ?? "no reference"}</span>
      <span className="mt-1 line-clamp-4 block text-body-sm">{(cited.length ? cited : side.lines).map((l) => l.text.trim()).join(" ")}</span>
    </blockquote>
  );
}
