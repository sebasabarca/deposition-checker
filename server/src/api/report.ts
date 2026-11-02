// The downloadable report: the findings a reviewer kept, from one analysis or several of a case, as
// a PDF. Each finding carries its pinpoint citation, the cited testimony verbatim, Veridict's analysis
// (labelled), and the reviewer's decision and note. A finding checked more than once appears once,
// from its latest analysis. The report page in the browser shows the same thing.

import { Router } from "express";
import PDFDocument from "pdfkit";
import { z } from "zod";
import type { Database } from "../db/client";
import { analysisFindings, findingDetail } from "./analyses";
import { caseDetail } from "./cases";

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
const cite = (s: Side) => `${s.deposition.witness.split(" ").at(-1)} Dep. ${displayRef(s.range) ?? "(no page:line reference)"} (${day(s.deposition.takenOn)})${s.lines.some((l) => l.pageInferred) ? " [page number inferred; verify against the scan]" : ""}`;
const headline = (f: Detail) => (f.group === "contradictions" ? (f.classification === "direct" ? "Potential direct contradiction" : "Potential inferential contradiction") : f.groupLabel);

export async function reportData(db: Database, caseId: number, analysisIds: number[] | null, withContext: boolean) {
  const detail = await caseDetail(db, caseId);
  if (!detail) return null;
  const done = detail.analyses.filter((a) => a.status === "completed" && (analysisIds === null || analysisIds.includes(a.id)));
  if (analysisIds !== null && done.length !== new Set(analysisIds).size) return null;
  // Newest analysis first, so the first copy of a re-checked finding is its latest.
  const all = (await Promise.all(done.map((a) => analysisFindings(db, a.id)))).flatMap((r) => r.groups.flatMap((g) => g.findings));
  const seen = new Set<string>();
  const unique = all.filter((f) => {
    const key = f.direct?.evidenceKey ?? `id:${f.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const kept = unique.filter((f) => f.reviewState === "confirmed").length;
  const context = unique.filter((f) => f.reviewState === "needs_context").length;
  const chosen = unique.filter((f) => f.reviewState === "confirmed" || (withContext && f.reviewState === "needs_context"));
  const entries = (await Promise.all(chosen.map((f) => findingDetail(db, f.id)))).filter((f) => f !== null);
  const witness = new Map(detail.witnesses.map((w) => [w.id, w.name]));
  const taken = new Map(detail.depositions.map((d) => [d.id, d.takenOn]));
  const covered = done.map((a) => `${witness.get(a.witnessId) ?? "Witness"}: ${day(taken.get(a.depositionA) ?? null)} and ${day(taken.get(a.depositionB) ?? null)}`);
  return { name: detail.case.name, witnesses: detail.witnesses.map((w) => w.name), covered, kept, context, withContext, entries };
}

type Report = NonNullable<Awaited<ReturnType<typeof reportData>>>;

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
  const meta: [string, string][] = [["Prepared", prepared], ["Witnesses", r.witnesses.join(", ") || "None"], ["Kept", String(r.kept)], ["Needs context", r.withContext ? String(r.context) : `${r.context} (not included)`]];
  const metaY = doc.y;
  meta.forEach(([k, v], i) => {
    const x = left + (width / 4) * i;
    doc.font("Helvetica").fontSize(8).fillColor(FAINT).text(k, x, metaY, { width: width / 4 - 8 });
    doc.font("Helvetica-Bold").fontSize(10).fillColor(INK).text(v, x, metaY + 12, { width: width / 4 - 8 });
  });
  doc.y = metaY + 40;
  doc.font("Helvetica").fontSize(8).fillColor(FAINT).text(r.covered.length === 1 ? "SESSIONS COMPARED" : `ANALYSES INCLUDED (${r.covered.length})`, left, doc.y, { characterSpacing: 0.6 });
  doc.font("Helvetica").fontSize(10).fillColor(INK).text(r.covered.join("\n") || "None", { width });
  doc.moveDown(0.8);
  doc.moveTo(left, doc.y).lineTo(left + width, doc.y).lineWidth(2).strokeColor(NAVY).stroke();
  doc.moveDown(1);
  doc.font("Helvetica").fontSize(9).fillColor(MUTED).text("Each finding below is a lead for review, not a conclusion that the witness testified falsely. Testimony is quoted verbatim from the stored transcript at the cited page and line. The explanations were written by Veridict's analysis, an AI system, and are labelled as such. Decisions and notes are the reviewer's.", { width, lineGap: 2 });

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
    doc.font("Times-Bold").fontSize(15).fillColor(INK).text(f.direct?.sharedSubject ?? headline(f), left + 26, top, { width: width - 26 });
    const decision = f.reviewState === "confirmed" ? "Kept" : "Needs more context";
    doc.font("Helvetica").fontSize(9).fillColor(MUTED).text(`${headline(f)} · ${f.a.deposition.witness} · ${decision}${f.reviewedAt ? `, ${day(f.reviewedAt)}` : ""}`, left + 26, doc.y + 2, { width: width - 26 });
    doc.moveDown(0.7);
    doc.font("Courier").fontSize(9).fillColor(INK).text(`${cite(f.a)}; compare ${cite(f.b)}.`, left, doc.y, { width });

    for (const [name, s] of [["Earlier session", f.a], ["Later session", f.b]] as const) {
      doc.moveDown(0.9);
      room(60);
      label(`${name} · ${day(s.deposition.takenOn)} · ${displayRef(s.range) ?? "no reference"}`);
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
    section("Why the statements may conflict (Veridict's analysis)", f.assessment.explanation);
    if (f.assessment.alternativeExplanation) section("The innocent explanation (Veridict's analysis)", f.assessment.alternativeExplanation);
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
  analyses: z.string().regex(/^\d+(,\d+)*$/).optional(),
  context: z.enum(["0", "1"]).optional(),
});

export function reportRoutes({ db }: { db: Database }): Router {
  const router = Router();

  // ?analyses=3,5 limits the report to those finished analyses of the case (all of them when absent);
  // ?context=1 adds the findings marked Needs context.
  router.get("/cases/:id/report.pdf", async (req, res) => {
    const caseId = z.coerce.number().int().positive().safeParse(req.params.id);
    const q = Query.safeParse(req.query);
    if (!caseId.success || !q.success) return res.status(400).json({ error: "Invalid report request." });
    const ids = q.data.analyses ? q.data.analyses.split(",").map(Number) : null;
    const data = await reportData(db, caseId.data, ids, q.data.context === "1");
    if (!data) return res.status(404).json({ error: "That case or analysis wasn't found, or the analysis hasn't finished." });
    const file = `Veridict report - ${data.name}${data.covered.length === 1 ? ` - ${data.covered[0]}` : ""}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${file.replace(/[^\w .,()-]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(file)}`);
    renderReport(data).pipe(res);
  });

  return router;
}
