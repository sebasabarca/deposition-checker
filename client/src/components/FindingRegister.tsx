// The findings of one analysis, or of many: four category cards that filter a table. Each row shows
// the stored lines behind the finding, fetched per visible row because the list endpoint has no text.

import { useEffect, useMemo, useState } from "react";
import { ArrowRight, ExternalLink, Filter } from "lucide-react";
import { api } from "../lib/api";
import { CLASSIFICATION, EVIDENCE_STATUS, evidenceStrength, findingHeadline, GROUP_HELP, GROUP_LABEL, priorityTone, PRIORITY } from "../lib/labels";
import { href } from "../lib/router";
import { reviewOf, REVIEW_LABEL, useReviews } from "../lib/review";
import type { EvidenceSide, FindingDetail, FindingGroup, FindingSummary } from "../types";
import { Badge, Button, Card, cx, Empty, HumanMark, tdClass, TabButton, thClass, VerifiedMark } from "./ui";

export type RegisterFinding = FindingSummary & { analysisId: number; caseName?: string };

const PAGE_SIZE = 10;
const GROUPS: { group: FindingGroup; label: string; tone: string }[] = [
  { group: "contradictions", label: GROUP_LABEL.contradictions, tone: "text-error" },
  { group: "needs_context", label: GROUP_LABEL.needs_context, tone: "text-secondary" },
  { group: "compatible", label: GROUP_LABEL.compatible, tone: "text-on-surface" },
  { group: "unverified", label: GROUP_LABEL.unverified, tone: "text-on-surface" },
];

export function FindingRegister({ findings, emptyTitle }: { findings: RegisterFinding[]; emptyTitle: string }) {
  const [group, setGroup] = useState<FindingGroup | "all">("all");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  const count = (g: FindingGroup) => findings.filter((f) => f.group === g).length;
  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    return findings.filter((f) => (group === "all" || f.group === group) && (!term || [f.a.ref, f.b.ref, f.explanation, f.caseName, findingHeadline(f), CLASSIFICATION[f.classification]].some((s) => s?.toLowerCase().includes(term))));
  }, [findings, group, q]);
  const pages = Math.max(Math.ceil(shown.length / PAGE_SIZE), 1);
  const current = Math.min(page, pages - 1);
  const pick = (g: FindingGroup | "all") => {
    setGroup(g);
    setPage(0);
  };

  return (
    <div className="space-y-space-lg">
      <div className="grid gap-space-md sm:grid-cols-2 xl:grid-cols-4">
        {GROUPS.map((g) => (
          <button key={g.group} type="button" onClick={() => pick(g.group)} aria-pressed={group === g.group} className={cx("flex flex-col justify-between gap-space-sm rounded-xl bg-surface-container-lowest p-space-md text-left shadow-sm transition-shadow hover:shadow-md", group === g.group && "ring-2 ring-secondary")}>
            <span className="flex items-start justify-between gap-2">
              <span className="text-headline-md">{g.label}</span>
              <span className={cx("text-stat-metric tabular-nums", g.tone)}>{count(g.group)}</span>
            </span>
            <span className="text-body-sm text-on-surface-variant">{GROUP_HELP[g.group]}</span>
            <span className="flex justify-end text-on-surface-variant"><ArrowRight aria-hidden className="size-4" /></span>
          </button>
        ))}
      </div>

      <Card>
        <div className="flex flex-col justify-between gap-space-md p-space-md lg:flex-row lg:items-center">
          <div className="flex flex-wrap items-center gap-space-xs">
            <TabButton active={group === "all"} onClick={() => pick("all")} count={findings.length}>All findings</TabButton>
            {GROUPS.map((g) => (
              <TabButton key={g.group} active={group === g.group} onClick={() => pick(g.group)} count={count(g.group)}>{g.label}</TabButton>
            ))}
          </div>
          <div className="relative w-full lg:w-72">
            <Filter aria-hidden className="absolute top-2.5 left-3 size-4 text-on-surface-variant" />
            <input value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} aria-label="Filter findings" placeholder="Filter by page:line or wording" className="h-9 w-full rounded-lg bg-surface pr-space-md pl-9 text-body-sm placeholder:text-on-surface-variant" />
          </div>
        </div>
        {shown.length === 0 ? (
          <div className="p-space-md pt-0"><Empty title={findings.length === 0 ? emptyTitle : "No findings match this filter"} /></div>
        ) : (
          <table className="w-full table-fixed border-collapse text-left text-body-sm max-lg:block">
            <thead className="bg-surface-container-low text-on-surface-variant max-lg:sr-only">
              <tr>
                <th className={cx(thClass, "w-48")}>Category</th>
                <th className={cx(thClass, "w-36")}>Page:line</th>
                <th className={thClass}>Original testimony</th>
                <th className={cx(thClass, "w-48")}>Status</th>
                <th className={cx(thClass, "w-32 text-right")}><span className="sr-only">Action</span></th>
              </tr>
            </thead>
            <tbody className="max-lg:block">
              {shown.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE).map((f) => <Row key={f.id} f={f} />)}
            </tbody>
          </table>
        )}
        <div className="flex flex-wrap items-center justify-between gap-space-sm p-space-md text-label-sm text-on-surface-variant">
          <span>Showing {shown.length === 0 ? 0 : current * PAGE_SIZE + 1}–{Math.min((current + 1) * PAGE_SIZE, shown.length)} of {shown.length}</span>
          {pages > 1 && (
            <span className="flex items-center gap-space-xs">
              <Button variant="secondary" className="h-8" disabled={current === 0} onClick={() => setPage(current - 1)}>Previous</Button>
              <span className="px-1 tabular-nums">Page {current + 1} of {pages}</span>
              <Button variant="secondary" className="h-8" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>Next</Button>
            </span>
          )}
        </div>
      </Card>
    </div>
  );
}

function Row({ f }: { f: RegisterFinding }) {
  const reviews = useReviews();
  const review = reviewOf(f.id, f.reviewState, reviews, f.direct?.evidenceKey);
  const verified = f.group !== "unverified" && (f.evidenceStatus === "verified" || f.evidenceStatus === "approximate");
  return (
    <tr className="border-t border-surface-container-low align-top transition-colors hover:bg-surface/60 max-lg:block max-lg:p-space-md">
      <td className={cx(tdClass, "max-lg:block max-lg:p-0")}>
        <div className="flex flex-col gap-1">
          <span className="font-semibold">{findingHeadline(f)}</span>
          {f.group !== "needs_context" && <Badge tone={priorityTone(f.priority)}>{PRIORITY[f.priority]}</Badge>}
          {f.direct && f.group !== "compatible" && <span className="text-label-sm font-semibold tabular-nums">{evidenceStrength(f)}</span>}
          {f.direct && <span className="text-label-sm text-on-surface-variant">Proposed by {f.modelName}</span>}
          {f.source !== "model" && <Badge tone="accent">{f.source === "fixture" ? "Prepared example" : "Stored assessment"}</Badge>}
          {f.caseName && <span className="text-label-sm text-on-surface-variant">{f.caseName}</span>}
        </div>
      </td>
      <td className={cx(tdClass, "font-mono text-label-md font-normal max-lg:block max-lg:px-0 max-lg:py-2")}>
        <span className="block">A {f.a.ref ?? "no reference"}</span>
        <span className="block">B {f.b.ref ?? "no reference"}</span>
      </td>
      <td className={cx(tdClass, "max-lg:block max-lg:p-0")}><Contrast id={f.id} /></td>
      <td className={cx(tdClass, "max-lg:block max-lg:px-0 max-lg:py-2")}>
        <div className="flex flex-col gap-1">
          {verified ? <VerifiedMark>{EVIDENCE_STATUS[f.evidenceStatus]}</VerifiedMark> : <Badge tone="bad">{f.group === "unverified" && f.evidenceStatus === "verified" ? "Not the witness's words" : EVIDENCE_STATUS[f.evidenceStatus]}</Badge>}
          {f.direct?.ocrRead && <Badge tone="warn" title="Matched against OCR text, which may differ from the scan">{f.direct.lowOcrLines.length > 0 ? `Low OCR confidence: ${f.direct.lowOcrLines.join(", ")}` : "OCR text: check the scan"}</Badge>}
          {(f.direct?.duplicates ?? 0) > 0 && <span className="text-label-sm text-on-surface-variant">{f.direct!.duplicates + 1} proposals merged</span>}
          <HumanMark>{REVIEW_LABEL[review]}</HumanMark>
        </div>
      </td>
      <td className={cx(tdClass, "text-right max-lg:block max-lg:p-0 max-lg:text-left")}>
        <a href={href.analysis(f.analysisId, f.id)} className="inline-flex h-8 items-center gap-1 rounded-lg bg-secondary px-space-sm text-label-md text-white hover:bg-secondary-container">
          Open <ExternalLink aria-hidden className="size-3.5" />
        </a>
      </td>
    </tr>
  );
}

function Contrast({ id }: { id: number }) {
  const [f, setF] = useState<FindingDetail | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    api.finding(id).then((r) => setF(r.finding)).catch(() => setFailed(true));
  }, [id]);
  if (failed) return <p className="text-on-surface-variant">Testimony couldn't be loaded. Open the finding to retry.</p>;
  if (!f) return <p className="text-on-surface-variant">Loading testimony…</p>;
  return (
    <div className="flex flex-col gap-1.5">
      <Quote label="Session A" side={f.a} />
      <Quote label="Session B" side={f.b} tint={f.group === "contradictions"} />
    </div>
  );
}

function Quote({ label, side, tint }: { label: string; side: EvidenceSide; tint?: boolean }) {
  const cited = side.lines.filter((l) => l.highlighted);
  return (
    <blockquote className={cx("rounded p-2", tint ? "bg-error/5" : "bg-surface")}>
      <span className="mb-0.5 block text-label-sm font-semibold text-on-surface-variant">{label}</span>
      <span className="line-clamp-3 font-mono text-label-md font-normal">{(cited.length ? cited : side.lines).map((l) => l.text.trim()).join(" ")}</span>
    </blockquote>
  );
}
