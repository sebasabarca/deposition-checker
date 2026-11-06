// The downloadable report of one whole-case analysis: the findings a reviewer kept, as a PDF. Each finding carries
// its pinpoint citation, the cited testimony verbatim, Veridict's analysis (labelled), and the reviewer's decision
// and note.

import { Router } from "express";
import PDFDocument from "pdfkit";
import { z } from "zod";
import type { Database } from "../db/client";
import { findingDetail } from "./findings";
import { caseDetail } from "./cases";
import { asc, eq } from "drizzle-orm";
import { candidates, findings } from "../db/schema";
import { standingOf } from "../evidence/correction";
import { caseRunReport, caseRunSetOf } from "../jobs/caseRun";

type Detail = NonNullable<Awaited<ReturnType<typeof findingDetail>>>;
type Side = Detail["a"];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (iso: string | Date | null) => {
  if (!iso) return "date not stated";
  const [y, m, d] = (iso instanceof Date ? iso.toISOString() : iso).slice(0, 10).split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
};
// Text transcripts without page numbers are stored on page 0 and cited by line.
const displayRef = (r: string | null) => r && r.replace(/\b0:0*(\d+)\s*[–-]\s*0:0*(\d+)/g, "Lines $1–$2").replace(/\b0:0*(\d+)/g, "Line $1");
const PHYSICAL = "line counted on the page, not an official line number";
const cite = (s: Side) => `${s.deposition.witness.split(" ").at(-1)} Dep. ${displayRef(s.range) ?? "(no page:line reference)"} (${day(s.deposition.takenOn)})${s.lines.some((l) => l.pageInferred) ? " [page number inferred; verify against the scan]" : ""}${s.deposition.physicalLines ? ` [${PHYSICAL}]` : ""}`;
// A whole-case finding stores its sides in retrieval order and may pair two witnesses without a cross-witness
// reading: both are told from the testimony itself, the earlier session first.
const across = (f: Detail) => f.a.deposition.witness !== f.b.deposition.witness;
const inOrder = (f: Detail) => ((f.b.deposition.takenOn ?? "") < (f.a.deposition.takenOn ?? "") ? [f.b, f.a] : [f.a, f.b]);
const headline = (f: Detail) => (f.group === "contradictions" ? (across(f) ? "Potential conflict between witnesses" : f.classification === "direct" ? "Potential direct contradiction" : "Potential inferential contradiction") : f.groupLabel);

// One whole-case run's report: the findings the reviewer kept from it (and, with withContext, those marked Needs
// context), in retrieval order. A finding set aside by a transcript correction is never reported. The run's unread
// testimony is stated, so the report never reads as covering more than was read.
export async function caseRunReportData(db: Database, runId: number, withContext: boolean) {
  const run = await caseRunReport(db, runId);
  if (!run) return null;
  const detail = await caseDetail(db, run.caseId);
  if (!detail) return null;
  const rows = await db.select({ id: findings.id, reviewState: findings.reviewState }).from(findings).innerJoin(candidates, eq(candidates.id, findings.candidateId)).where(eq(candidates.candidateSet, caseRunSetOf(runId))).orderBy(asc(candidates.mergedRank), asc(findings.id));
  const standing = await standingOf(db, rows.map((r) => r.id));
  const current = rows.filter((r) => standing.get(r.id)?.state !== "quarantined");
  const kept = current.filter((r) => r.reviewState === "confirmed").length;
  const context = current.filter((r) => r.reviewState === "needs_context").length;
  const chosen = current.filter((r) => r.reviewState === "confirmed" || (withContext && r.reviewState === "needs_context"));
  const entries = (await Promise.all(chosen.map((r) => findingDetail(db, r.id)))).filter((f) => f !== null);
  const sessions = run.scope && run.scope.kind === "depositions" ? `${run.scope.depositionIds.length} selected depositions` : `the whole case, ${detail.depositions.filter((d) => d.status === "ready").length} sessions`;
  const covered = [`${run.name ?? "Whole-case analysis"} (${day(run.createdAt)}): ${sessions}`];
  return { name: detail.case.name, witnesses: detail.witnesses.map((w) => w.name), covered, gaps: run.incompleteReasons, kept, context, withContext, entries };
}

export type Report = NonNullable<Awaited<ReturnType<typeof caseRunReportData>>>;

// The case's witnesses in the header: the first few by name, then a count, so a large case fits its column.
export const witnessSummary = (names: string[], shown = 3) => (names.length === 0 ? "None" : names.length <= shown + 1 ? names.join(", ") : `${names.slice(0, shown).join(", ")} and ${names.length - shown} more`);

const NAVY = "#13213a";
const INK = "#1b2230";
const MUTED = "#5d6676";
const FAINT = "#8a92a0";
const RULE = "#dfe2e7";
const MARK = "#fbe7a1";
const WELL = "#f2f3f5";

export function renderReport(r: Report): PDFKit.PDFDocument {
  const prepared = day(new Date());
  const doc = new PDFDocument({ size: "LETTER", margins: { top: 64, bottom: 72, left: 64, right: 64 }, bufferPages: true, info: { Title: `${r.name}: findings kept for follow-up`, Creator: "Veridict" } });
  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom;
  const room = (h: number) => doc.y + h > bottom() && doc.addPage();
  const label = (text: string) => doc.font("Helvetica-Bold").fontSize(8).fillColor(FAINT).text(text.toUpperCase(), left, doc.y, { characterSpacing: 0.6 });

  doc.font("Times-Bold").fontSize(13).fillColor(NAVY).text("Veridict", left, doc.y);
  doc.moveDown(1.2);
  doc.font("Times-Bold").fontSize(24).fillColor(INK).text(r.name, { width });
  doc.font("Times-Roman").fontSize(14).fillColor(MUTED).text("Potential contradictions kept for follow-up");
  doc.moveDown(0.9);
  const meta: [string, string][] = [["Prepared", prepared], ["Witnesses", witnessSummary(r.witnesses)], ["Kept", String(r.kept)], ["Needs context", r.withContext ? String(r.context) : `${r.context} (not included)`]];
  const metaY = doc.y;
  let metaBottom = metaY;
  meta.forEach(([k, v], i) => {
    const x = left + (width / 4) * i;
    doc.font("Helvetica").fontSize(8).fillColor(FAINT).text(k, x, metaY, { width: width / 4 - 8 });
    doc.font("Helvetica-Bold").fontSize(10).fillColor(INK).text(v, x, metaY + 12, { width: width / 4 - 8 });
    metaBottom = Math.max(metaBottom, doc.y);
  });
  doc.y = Math.max(metaY + 40, metaBottom + 14); // a value that wraps pushes what follows down, never under it
  doc.font("Helvetica").fontSize(8).fillColor(FAINT).text(r.covered.length === 1 ? "SESSIONS COMPARED" : `ANALYSES INCLUDED (${r.covered.length})`, left, doc.y, { characterSpacing: 0.6 });
  doc.font("Helvetica").fontSize(10).fillColor(INK).text(r.covered.join("\n") || "None", { width });
  if (r.gaps.length > 0) {
    doc.moveDown(0.6);
    doc.font("Helvetica").fontSize(8).fillColor(FAINT).text("TESTIMONY NOT CHECKED", left, doc.y, { characterSpacing: 0.6 });
    doc.font("Helvetica").fontSize(10).fillColor(INK).text(r.gaps.join("\n"), { width });
  }
  doc.moveDown(0.8);
  doc.moveTo(left, doc.y).lineTo(left + width, doc.y).lineWidth(2).strokeColor(NAVY).stroke();
  doc.moveDown(1);
  // Who wrote each explanation: a prepared example (written by hand, origin "fixture") or Veridict's analysis.
  const handWritten = (f: Report["entries"][number]) => f.source?.kind === "fixture";
  const hand = r.entries.filter(handWritten).length;
  const authorship = r.entries.length > 0 && hand === r.entries.length
    ? "The explanations are prepared examples written by hand for this demonstration; Veridict's model was not used."
    : hand > 0 ? "The explanations were written by Veridict's analysis, an AI system, except those marked as prepared examples, which were written by hand; each is labelled."
    : "The explanations were written by Veridict's analysis, an AI system, and are labelled as such.";
  doc.font("Helvetica").fontSize(9).fillColor(MUTED).text(`Each finding below is a lead for review, not a conclusion that any witness testified falsely. Testimony is quoted verbatim from the stored transcript at the cited page and line. ${authorship} Decisions and notes are the reviewer's.`, { width, lineGap: 2 });

  if (r.entries.length === 0) {
    doc.moveDown(2);
    doc.font("Helvetica").fontSize(11).fillColor(MUTED).text("No findings are marked Keep yet. Open an analysis and choose Keep on the findings to include them here.", { width, align: "center" });
  }

  r.entries.forEach((f, i) => {
    doc.moveDown(1.6);
    room(150);
    if (i > 0) {
      doc.moveTo(left, doc.y).lineTo(left + width, doc.y).lineWidth(0.5).strokeColor(RULE).stroke();
      doc.moveDown(1);
    }
    const top = doc.y;
    doc.font("Times-Roman").fontSize(15).fillColor(FAINT).text(`${i + 1}.`, left, top, { width: 24 });
    doc.font("Times-Bold").fontSize(15).fillColor(INK).text(headline(f), left + 26, top, { width: width - 26 });
    const decision = f.reviewState === "confirmed" ? "Kept" : "Needs more context";
    doc.font("Helvetica").fontSize(9).fillColor(MUTED).text(`${headline(f)} · ${across(f) ? `${inOrder(f)[0].deposition.witness} and ${inOrder(f)[1].deposition.witness}` : f.a.deposition.witness} · ${decision}${f.reviewedAt ? `, ${day(f.reviewedAt)}` : ""}`, left + 26, doc.y + 2, { width: width - 26 });
    doc.moveDown(0.7);
    doc.font("Courier").fontSize(9).fillColor(INK).text(`${cite(inOrder(f)[0])}; compare ${cite(inOrder(f)[1])}.`, left, doc.y, { width });

    for (const [name, s] of [["Earlier session", inOrder(f)[0]], ["Later session", inOrder(f)[1]]] as const) {
      doc.moveDown(0.9);
      room(60);
      label(`${name} · ${day(s.deposition.takenOn)} · ${displayRef(s.range) ?? "no reference"}${s.deposition.physicalLines ? ` (${PHYSICAL})` : ""}`);
      doc.moveDown(0.3);
      const cited = s.lines.filter((l) => l.highlighted);
      for (const l of cited.length ? cited : s.lines) {
        doc.font("Courier").fontSize(9.5);
        const h = doc.heightOfString(l.text || " ", { width: width - 60 });
        room(h + 4);
        const y = doc.y;
        if (l.highlighted) doc.rect(left + 52, y - 1.5, width - 52, h + 3).fill(MARK);
        doc.fillColor(FAINT).text(displayRef(l.ref) ?? "", left, y, { width: 46, align: "right" });
        doc.fillColor(INK).text(l.text || " ", left + 58, y, { width: width - 60 });
        doc.y = y + h + 3;
      }
    }

    const section = (title: string, body: string) => {
      doc.moveDown(0.9);
      room(40);
      label(title);
      doc.moveDown(0.2);
      doc.font("Helvetica").fontSize(10).fillColor(INK).text(body, left, doc.y, { width, lineGap: 2 });
    };
    const source = handWritten(f) ? "prepared example, not Veridict's model's output" : "Veridict's analysis";
    section(`Why the statements may conflict (${source})`, f.assessment.explanation);
    if (f.assessment.alternativeExplanation) section(`The innocent explanation (${source})`, f.assessment.alternativeExplanation);
    if (f.reviewNote) {
      doc.moveDown(0.9);
      doc.font("Helvetica").fontSize(10);
      const h = doc.heightOfString(f.reviewNote, { width: width - 24, lineGap: 2 }) + 30;
      room(h);
      const y = doc.y;
      doc.roundedRect(left, y, width, h, 4).fill(WELL);
      doc.font("Helvetica-Bold").fontSize(8).fillColor(FAINT).text("REVIEWER'S NOTE", left + 12, y + 9, { characterSpacing: 0.6 });
      doc.font("Helvetica").fontSize(10).fillColor(INK).text(f.reviewNote, left + 12, y + 22, { width: width - 24, lineGap: 2 });
      doc.y = y + h;
    }
  });

  // Every page: what this is, and where it stands.
  const pages = doc.bufferedPageRange();
  for (let p = 0; p < pages.count; p++) {
    doc.switchToPage(p);
    doc.page.margins.bottom = 0; // writing inside the bottom margin would otherwise start a new page
    const y = doc.page.height - 48;
    doc.font("Helvetica").fontSize(7.5).fillColor(FAINT);
    doc.text(`Prepared with Veridict on ${prepared}. Verify every citation against the certified transcript before relying on it.`, left, y, { width: width - 60, lineBreak: false, height: 12 });
    doc.text(`${p + 1} of ${pages.count}`, left + width - 60, y, { width: 60, align: "right", lineBreak: false, height: 12 });
  }
  doc.end();
  return doc;
}

const Query = z.object({
  context: z.enum(["0", "1"]).optional(),
});

export function reportRoutes({ db }: { db: Database }): Router {
  const router = Router();

  // One whole-case run's report (caseRunReportData); ?context=1 adds the findings marked Needs context.
  router.get("/case-runs/:id/report.pdf", async (req, res) => {
    const id = z.coerce.number().int().positive().safeParse(req.params.id);
    const q = Query.safeParse(req.query);
    if (!id.success || !q.success) return res.status(400).json({ error: "Invalid report request." });
    const data = await caseRunReportData(db, id.data, q.data.context === "1");
    if (!data) return res.status(404).json({ error: "That analysis wasn't found." });
    const file = `Veridict report - ${data.name} - ${data.covered[0].split(" (")[0]}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${file.replace(/[^\w .,()-]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(file)}`);
    renderReport(data).pipe(res);
  });

  return router;
}
