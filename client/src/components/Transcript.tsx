// Testimony as a transcript sheet: one row per stored line, its page:line in the number column, the text past the
// margin rule, cited lines in highlighter, and a scanned line's reading accuracy when it is low.

import { TriangleAlert } from "lucide-react";
import { displayRef, LOW_OCR_CONFIDENCE } from "../lib/insights";
import type { EvidenceLine } from "../types";
import { cx } from "./ui";

export function TranscriptRows({ lines, muted }: { lines: (Pick<EvidenceLine, "id" | "ref" | "text" | "ocrConfidence"> & { highlighted?: boolean })[]; muted?: boolean }) {
  return (
    <ol>
      {lines.map((l) => (
        <li key={l.id} data-highlighted={l.highlighted || undefined} className="grid scroll-mt-24 grid-cols-[3.6rem_1fr_auto] items-start">
          <span className={cx("pr-2.5 text-right text-[12px] select-none tabular-nums", l.highlighted ? "font-bold text-mark-ink" : "text-faint")}>{displayRef(l.ref).replace("Line ", "")}</span>
          <span className={cx("min-w-0 border-l-[3px] border-double border-margin pr-4 pl-4 break-words whitespace-pre-wrap", l.highlighted && "bg-mark text-ink [box-decoration-break:clone]", muted && !l.highlighted && "text-muted")}>{l.text || " "}</span>
          <Confidence value={l.ocrConfidence} />
        </li>
      ))}
    </ol>
  );
}

function Confidence({ value }: { value: number | null }) {
  if (value == null || value >= LOW_OCR_CONFIDENCE) return null;
  return (
    <span className="flex items-center gap-1 pr-3 font-sans text-xs whitespace-nowrap text-context tabular-nums" title="Reading accuracy for this line of the scanned page">
      <TriangleAlert aria-hidden className="size-3" />
      {value}%
    </span>
  );
}
