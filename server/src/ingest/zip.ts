// Reads named entries from a ZIP archive (a .docx is one), with Node's own inflate. Handles stored
// and deflated entries from the central directory; refuses encrypted and ZIP64 archives, which a
// transcript export doesn't need, with a reason instead of a guess.

import { inflateRawSync } from "node:zlib";

export class ZipError extends Error {}

const MAX_ENTRY_BYTES = 200 * 1024 * 1024; // a document.xml is a few MB; anything near this is a zip bomb

export function readZip(data: Uint8Array): Map<string, () => Uint8Array> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  // The end-of-central-directory record is in the last 64 KB + 22 bytes (it may end with a comment).
  let eocd = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError("the file is not a complete ZIP archive (it may be truncated)");
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  if (count === 0xffff || at === 0xffffffff) throw new ZipError("the archive uses ZIP64, which isn't supported");
  const entries = new Map<string, () => Uint8Array>();
  for (let n = 0; n < count; n++) {
    if (at + 46 > data.length || view.getUint32(at, true) !== 0x02014b50) throw new ZipError("the archive's directory is damaged");
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const compressed = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(data.subarray(at + 46, at + 46 + nameLength));
    entries.set(name, () => {
      if (flags & 1) throw new ZipError("the document is password-protected");
      if (local + 30 > data.length || view.getUint32(local, true) !== 0x04034b50) throw new ZipError(`the archive entry ${name} is damaged`);
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      const raw = data.subarray(start, start + compressed);
      if (raw.length < compressed) throw new ZipError(`the archive entry ${name} is truncated`);
      if (method === 0) return raw;
      if (method !== 8) throw new ZipError(`the archive entry ${name} uses an unsupported compression method`);
      if (size > MAX_ENTRY_BYTES) throw new ZipError(`the archive entry ${name} is too large`);
      try {
        return new Uint8Array(inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES }));
      } catch (e) {
        throw new ZipError(`the archive entry ${name} can't be decompressed (${(e as Error).message})`);
      }
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
