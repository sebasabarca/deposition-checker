// Which transcript format a file is, from its bytes (never from what the browser says), and a plain
// explanation for the formats Veridict can't read. Every readable format ends as page:line text read
// by text.ts, except PDF, which has its own geometry-based reader.

import { isDocx, isOle, isZip } from "./docx";
import { isRtf } from "./rtf";
import { decodeText } from "./text";
import { isPdf } from "./uploads";

export type SourceFormat = "pdf" | "text" | "rtf" | "docx";

const ASK_FOR_ASCII = "Ask the court reporter for the plain-text (ASCII .txt) or PDF transcript, which keep the page and line numbers.";
// Proprietary court-reporting formats. Without genuine samples and a documented way to read them,
// Veridict doesn't attempt them: a wrong reading would put wrong citations on testimony.
export const UNSUPPORTED_EXTENSIONS: Record<string, string> = {
  ptx: "E-Transcript (.ptx) files can't be read yet: it's a proprietary format. Open it in the free E-Transcript viewer and export it as ASCII (.txt), or ask the court reporter for the ASCII (.txt) or PDF transcript.",
  ptz: `E-Transcript bundles (.ptz) can't be read yet. Open the bundle in the free E-Transcript viewer and export each transcript as ASCII (.txt). ${ASK_FOR_ASCII}`,
  lef: `LiveNote (.lef) files can't be read yet. ${ASK_FOR_ASCII}`,
  ptf: `.ptf transcript files can't be read yet. ${ASK_FOR_ASCII}`,
  doc: "Word 97–2003 (.doc) files can't be read. Open it in Word and save it as a .docx, or upload the PDF.",
  wpd: `WordPerfect (.wpd) files can't be read. ${ASK_FOR_ASCII}`,
};

export const extensionOf = (filename?: string | null) => filename?.toLowerCase().match(/\.([a-z0-9]{1,5})$/)?.[1] ?? null;

export function detectFormat(data: Uint8Array, filename?: string | null): { format: SourceFormat } | { error: string } {
  const ext = extensionOf(filename);
  if (ext && ext in UNSUPPORTED_EXTENSIONS) return { error: UNSUPPORTED_EXTENSIONS[ext] };
  if (isPdf(data)) return { format: "pdf" };
  if (isRtf(data)) return { format: "rtf" };
  if (isZip(data)) return isDocx(data) ? { format: "docx" } : { error: "This file is a ZIP archive but not a Word (.docx) document. Upload the transcript itself: PDF, text (.txt, .asc), RTF or Word (.docx)." };
  if (isOle(data)) return { error: UNSUPPORTED_EXTENSIONS.doc };
  if (decodeText(data)) return { format: "text" };
  return { error: "This file isn't a transcript format Veridict can read. Upload a PDF, a text file (.txt, .asc), an RTF or a Word (.docx) document." };
}
