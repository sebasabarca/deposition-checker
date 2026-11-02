// Deposition upload and status endpoints. Requests never parse a PDF: the upload stores the file,
// records the deposition as processing and queues a job, then answers at once. The worker process
// does the parsing, and these endpoints only read what it stored.

import express, { Router, type ErrorRequestHandler, type Response } from "express";
import { deleteCase, deleteDeposition, type Removal } from "./remove";
import { and, countDistinct, eq, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import type { Pool } from "pg";
import { z } from "zod";
import { withTransaction, type Database } from "../db/client";
import { cases, depositions, exchanges, lines, witnesses } from "../db/schema";
import { depositionLockKey, isPdf, isText, PARSER_VERSION, readUpload, storeUpload, UPLOADS_DIR } from "../ingest";
import { enqueueIngest } from "../jobs";
import { timed, timedSync } from "../timing";

export const MAX_UPLOAD_MB = 50;

export type ApiDeps = { db: Database; pool: Pool; boss: PgBoss; uploadsDir?: string };

const Id = z.coerce.number().int().positive();
const UploadQuery = z.object({
  witness: z.string().trim().min(1).max(200),
  takenOn: z.iso.date().optional(),
  // The name the file had on the user's computer, kept for display only; never used as a path.
  filename: z.string().trim().min(1).max(255).optional(),
});

// The deposition as the API shows it. Fields that only exist once the file has been read are null
// while it is processing (or if it failed before any attempt finished), never placeholders.
export async function depositionView(db: Database, id: number) {
  const [row] = await db
    .select({ deposition: depositions, witnessName: witnesses.name })
    .from(depositions)
    .innerJoin(witnesses, eq(witnesses.id, depositions.witnessId))
    .where(eq(depositions.id, id));
  if (!row) return null;
  const d = row.deposition;
  const [stored] = await db
    .select({ parts: sql<number>`count(*)::int`, exchanges: countDistinct(exchanges.groupId) })
    .from(exchanges)
    .where(eq(exchanges.depositionId, id));
  return {
    id: d.id,
    caseId: d.caseId,
    witness: { id: d.witnessId, name: row.witnessName },
    takenOn: d.takenOn,
    originalFilename: d.originalFilename,
    sourceFormat: d.sourceFormat,
    status: d.status,
    error: d.ingestError,
    ingestRun: d.ingestRun,
    parserVersion: d.parserVersion,
    pageCount: d.pageCount,
    needsOcrPages: d.needsOcrPages,
    blankPages: d.blankPages,
    validation: d.validation
      ? { layout: d.validation.layout, pages: d.validation.counts, failedPages: d.validation.failedPages, reasons: d.validation.reasons, ocr: d.validation.ocr ?? null }
      : null,
    stored: { lines: await db.$count(lines, eq(lines.depositionId, id)), exchanges: stored.exchanges, parts: stored.parts },
    createdAt: d.createdAt,
  };
}

export function depositionRoutes({ db, pool, boss, uploadsDir = UPLOADS_DIR }: ApiDeps): Router {
  const router = Router();
  // Any content type: the bytes themselves are checked, not what the client says they are.
  const pdfBody = express.raw({ type: () => true, limit: `${MAX_UPLOAD_MB}mb` });

  // Upload a deposition PDF as the request body. 202 with the new deposition (status processing);
  // 200 with the existing one when this file was already uploaded to the case, without queuing again.
  router.post("/cases/:caseId/depositions", pdfBody, async (req, res) => {
    const caseId = Id.safeParse(req.params.caseId);
    const query = UploadQuery.safeParse(req.query);
    if (!caseId.success) return res.status(400).json({ error: "The case ID must be a positive number." });
    if (!query.success) {
      return res.status(400).json({ error: "A witness name is required, and takenOn must be a date (YYYY-MM-DD)." });
    }
    // A body another parser already read (JSON, say) arrives as an object rather than bytes: not a PDF.
    const body: unknown = req.body;
    if (body === undefined || (Buffer.isBuffer(body) && body.length === 0)) {
      return res.status(400).json({ error: "Send the PDF or text file as the request body." });
    }
    // A PDF, or plain UTF-8 text (a .txt transcript or pasted text), which the worker reads as text.
    const format = Buffer.isBuffer(body) ? timedSync("upload.validate", () => (isPdf(body) ? "pdf" : isText(body) ? "text" : null)) : null;
    if (!Buffer.isBuffer(body) || !format) return res.status(415).json({ error: "The file is not a PDF or plain text." });

    const [kase] = await db.select({ id: cases.id }).from(cases).where(eq(cases.id, caseId.data));
    if (!kase) return res.status(404).json({ error: "Case not found." });

    const data = new Uint8Array(body);
    const { fileSha256, storageKey } = await timed("upload.store_file", () => storeUpload(data, uploadsDir));

    // Under the same lock as saveDeposition, so concurrent uploads of one file create one deposition
    // and one job. The job is queued in this transaction: both are committed, or neither.
    const { id, created } = await timed("upload.record", () => withTransaction(pool, async (tx, client) => {
      const lockKey = depositionLockKey(kase.id, fileSha256, PARSER_VERSION);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
      const [existing] = await tx
        .select({ id: depositions.id })
        .from(depositions)
        .where(
          and(eq(depositions.caseId, kase.id), eq(depositions.fileSha256, fileSha256), eq(depositions.parserVersion, PARSER_VERSION)),
        );
      if (existing) return { id: existing.id, created: false };

      await tx.insert(witnesses).values({ caseId: kase.id, name: query.data.witness }).onConflictDoNothing();
      const [witness] = await tx
        .select({ id: witnesses.id })
        .from(witnesses)
        .where(and(eq(witnesses.caseId, kase.id), eq(witnesses.name, query.data.witness)));
      const [deposition] = await tx
        .insert(depositions)
        .values({
          caseId: kase.id,
          witnessId: witness.id,
          takenOn: query.data.takenOn ?? null,
          fileSha256,
          storageKey,
          originalFilename: query.data.filename ? (query.data.filename.split(/[\\/]/).pop() ?? null) : null,
          sourceFormat: format,
          parserVersion: PARSER_VERSION,
          status: "processing",
        })
        .returning({ id: depositions.id, run: depositions.ingestRun });
      await enqueueIngest(boss, client, { depositionId: deposition.id, run: deposition.run });
      return { id: deposition.id, created: true };
    }));

    return res.status(created ? 202 : 200).json({ created, deposition: await depositionView(db, id) });
  });

  router.get("/depositions/:id", async (req, res) => {
    const id = Id.safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ error: "The deposition ID must be a positive number." });
    const deposition = await depositionView(db, id.data);
    if (!deposition) return res.status(404).json({ error: "Deposition not found." });
    return res.json({ deposition });
  });

  // One printed page of stored lines, for reading the transcript, and the lines matching a search.
  // The first page when none is asked for; hits are capped so a common word can't flood the reply.
  const LinesQuery = z.object({ page: z.coerce.number().int().nonnegative().optional(), q: z.string().trim().max(200).optional() });
  router.get("/depositions/:id/lines", async (req, res) => {
    const id = Id.safeParse(req.params.id);
    const query = LinesQuery.safeParse(req.query);
    if (!id.success) return res.status(400).json({ error: "The deposition ID must be a positive number." });
    if (!query.success) return res.status(400).json({ error: "page must be a whole number and q at most 200 characters." });
    const [exists] = await db.select({ id: depositions.id }).from(depositions).where(eq(depositions.id, id.data));
    if (!exists) return res.status(404).json({ error: "Deposition not found." });
    const pages = (await db.selectDistinct({ page: lines.printedPage }).from(lines).where(eq(lines.depositionId, id.data)).orderBy(lines.printedPage)).map((r) => r.page);
    const page = query.data.page !== undefined && pages.includes(query.data.page) ? query.data.page : (pages[0] ?? null);
    const columns = { id: lines.id, page: lines.printedPage, lineNo: lines.lineNo, pdfPage: lines.pdfPage, speaker: lines.speakerRole, text: lines.rawText, ocrConfidence: lines.ocrConfidence };
    const pageLines = page === null ? [] : await db.select(columns).from(lines).where(and(eq(lines.depositionId, id.data), eq(lines.printedPage, page))).orderBy(lines.lineNo);
    const term = query.data.q;
    const HIT_LIMIT = 200;
    const hits = term
      ? await db
          .select(columns)
          .from(lines)
          .where(and(eq(lines.depositionId, id.data), sql`${lines.rawText} ilike ${`%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`}`))
          .orderBy(lines.printedPage, lines.lineNo)
          .limit(HIT_LIMIT + 1)
      : [];
    return res.json({ page, pages, lines: pageLines, hits: hits.slice(0, HIT_LIMIT), moreHits: hits.length > HIT_LIMIT });
  });

  // The original file, so a reader can check OCR text against the scan. Open at #page=<pdfPage>.
  router.get("/depositions/:id/pdf", async (req, res) => {
    const id = Id.safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ error: "The deposition ID must be a positive number." });
    const [row] = await db.select({ storageKey: depositions.storageKey, format: depositions.sourceFormat }).from(depositions).where(eq(depositions.id, id.data));
    if (!row) return res.status(404).json({ error: "Deposition not found." });
    const data = await readUpload(row.storageKey, uploadsDir).catch(() => null);
    if (!data) return res.status(404).json({ error: "The original file isn't available." });
    return res.type(row.format === "text" ? "text/plain; charset=utf-8" : "application/pdf").set("Content-Disposition", "inline").send(Buffer.from(data));
  });

  // Retry a failed deposition: back to processing as a new run, with a new job queued in the same
  // transaction. Only failed depositions can be retried; the row lock makes concurrent retries
  // queue one job. Messages from earlier runs carry the old run number, so they can't touch this one.
  router.post("/depositions/:id/retry", async (req, res) => {
    const id = Id.safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ error: "The deposition ID must be a positive number." });
    const outcome = await withTransaction(pool, async (tx, client) => {
      const [row] = await tx
        .select({ status: depositions.status })
        .from(depositions)
        .where(eq(depositions.id, id.data))
        .for("update");
      if (!row) return "not_found" as const;
      if (row.status !== "failed") return row.status;
      const [retried] = await tx
        .update(depositions)
        .set({ status: "processing", ingestError: null, ingestRun: sql`${depositions.ingestRun} + 1` })
        .where(eq(depositions.id, id.data))
        .returning({ run: depositions.ingestRun });
      await enqueueIngest(boss, client, { depositionId: id.data, run: retried.run });
      return "queued" as const;
    });
    if (outcome === "not_found") return res.status(404).json({ error: "Deposition not found." });
    if (outcome !== "queued") {
      return res.status(409).json({ error: `Only failed depositions can be retried; this one is ${outcome}.` });
    }
    return res.status(202).json({ deposition: await depositionView(db, id.data) });
  });

  // Delete a deposition, with every analysis that compared it and their findings and decisions.
  // Case deletion lives here too because it removes depositions and their files the same way.
  const removed = (res: Response, outcome: Removal, what: string) => {
    if (outcome.outcome === "not_found") return res.status(404).json({ error: `${what} not found.` });
    if (outcome.outcome === "running") return res.status(409).json({ error: `${what} is being checked right now. Stop the check, or wait for it to finish, then delete it.`, analyses: outcome.analyses });
    return res.json({ deleted: { depositions: outcome.depositions, analyses: outcome.analyses } });
  };
  router.delete("/depositions/:id", async (req, res) => {
    const id = Id.safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ error: "The deposition ID must be a positive number." });
    return removed(res, await deleteDeposition(db, pool, id.data, uploadsDir), "This deposition");
  });
  router.delete("/cases/:id", async (req, res) => {
    const id = Id.safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ error: "The case ID must be a positive number." });
    return removed(res, await deleteCase(db, pool, id.data, uploadsDir), "This case");
  });

  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    if ((error as { type?: string }).type === "entity.too.large") {
      return res.status(413).json({ error: `The file is larger than ${MAX_UPLOAD_MB} MB.` });
    }
    console.error("Request failed:", error);
    return res.status(500).json({ error: "Something went wrong. Please try again." });
  };
  router.use(errors);

  return router;
}
