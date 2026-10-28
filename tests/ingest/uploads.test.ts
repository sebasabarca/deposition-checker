import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256, storeUpload } from "../../server/src/ingest/uploads";

const pdf = (text: string) => new TextEncoder().encode(`%PDF-1.4\n${text}\n%%EOF\n`);

describe("storeUpload", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "uploads-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const stored = (key: string) => new Uint8Array(readFileSync(path.join(dir, key)));

  it("stores the file under its SHA-256 and leaves no temporary files", async () => {
    const data = pdf("deposition");
    const { fileSha256, storageKey } = await storeUpload(data, dir);
    expect(fileSha256).toBe(sha256(data));
    expect(storageKey).toBe(`${fileSha256}.pdf`);
    expect(stored(storageKey)).toEqual(data);
    expect(readdirSync(dir)).toEqual([storageKey]);
  });

  it("keeps an existing file whose contents match, without rewriting it", async () => {
    const data = pdf("deposition");
    const { storageKey } = await storeUpload(data, dir);
    const before = statSync(path.join(dir, storageKey)).ino;
    await storeUpload(data, dir);
    expect(statSync(path.join(dir, storageKey)).ino).toBe(before);
  });

  it("replaces an existing file whose contents don't match its name (truncated or corrupted)", async () => {
    const data = pdf("deposition");
    const key = `${sha256(data)}.pdf`;
    writeFileSync(path.join(dir, key), data.subarray(0, 10)); // a write that stopped partway
    await storeUpload(data, dir);
    expect(stored(key)).toEqual(data);
    expect(readdirSync(dir)).toEqual([key]);
  });

  it("a write interrupted before it was renamed leaves no stored file, and doesn't block the next write", async () => {
    const data = pdf("deposition");
    const key = `${sha256(data)}.pdf`;
    writeFileSync(path.join(dir, `.${key}.crashed.tmp`), data.subarray(0, 10)); // a process died mid-write
    await storeUpload(data, dir);
    expect(stored(key)).toEqual(data);
  });

  it("concurrent writers of the same file all succeed and leave one complete copy", async () => {
    const data = pdf("x".repeat(2_000_000));
    const results = await Promise.all(Array.from({ length: 8 }, () => storeUpload(data, dir)));
    expect(new Set(results.map((r) => r.storageKey)).size).toBe(1);
    expect(sha256(stored(results[0].storageKey))).toBe(results[0].fileSha256);
    expect(readdirSync(dir)).toEqual([results[0].storageKey]);
  });

  it("creates the uploads folder when it doesn't exist", async () => {
    const nested = path.join(dir, "a/b");
    const { storageKey } = await storeUpload(pdf("deposition"), nested);
    expect(existsSync(path.join(nested, storageKey))).toBe(true);
  });
});
