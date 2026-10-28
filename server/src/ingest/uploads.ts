// Local storage for uploaded PDFs (DESIGN.md, Ingestion step 5). Files are named by their SHA-256,
// so the same file is stored once however often it is ingested. The storage key is the path
// relative to the uploads folder, which can become an S3 object key unchanged.
//
// A stored file is never seen half-written: each write goes to its own temporary file in the same
// folder, is flushed to disk and checked against the hash, and only then renamed into place. A
// rename within one filesystem is atomic, so readers see either no file or the complete one, and
// concurrent writers of the same file each rename an identical copy. An existing file is trusted
// only after its contents are checked against its name.

import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

export const UPLOADS_DIR = "data/uploads";

export function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

// The hash of the file at `file`, or null when there is no file.
async function hashOf(file: string): Promise<string | null> {
  try {
    return sha256(await readFile(file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function storeUpload(data: Uint8Array, dir = UPLOADS_DIR): Promise<{ fileSha256: string; storageKey: string }> {
  const fileSha256 = sha256(data);
  const storageKey = `${fileSha256}.pdf`;
  const target = path.join(dir, storageKey);
  if ((await hashOf(target)) === fileSha256) return { fileSha256, storageKey };

  // Missing, or not what its name says (a corrupted or truncated earlier write): write it again.
  await mkdir(dir, { recursive: true });
  const temp = path.join(dir, `.${storageKey}.${randomUUID()}.tmp`);
  try {
    const file = await open(temp, "wx"); // fails rather than reuse an existing temporary file
    try {
      await file.writeFile(data);
      await file.sync();
    } finally {
      await file.close();
    }
    const written = await hashOf(temp);
    if (written !== fileSha256) throw new Error(`upload ${storageKey} was not written correctly (hash ${written})`);
    await rename(temp, target);
  } finally {
    await rm(temp, { force: true }); // nothing left behind if the write or the check failed
  }
  return { fileSha256, storageKey };
}
