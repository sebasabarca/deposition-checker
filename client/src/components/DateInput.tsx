// A date as three boxes, year, month and day, that move on to the next box as each is filled;
// Backspace in an empty box goes back. A pasted date (2023-03-14, 03/14/2023) fills all three. The
// value is "YYYY-MM-DD" once the date is complete and real, and "" otherwise.

import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { cx } from "./ui";

type Parts = { y: string; m: string; d: string };
const SIZES = { y: 4, m: 2, d: 2 } as const;
const ORDER = ["y", "m", "d"] as const;

const valid = ({ y, m, d }: Parts) => {
  if (y.length !== 4 || m.length < 1 || d.length < 1) return false;
  const date = new Date(Number(y), Number(m) - 1, Number(d));
  return date.getFullYear() === Number(y) && date.getMonth() === Number(m) - 1 && date.getDate() === Number(d);
};
const iso = (p: Parts) => (valid(p) ? `${p.y}-${p.m.padStart(2, "0")}-${p.d.padStart(2, "0")}` : "");
const split = (value: string): Parts => {
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? { y: m[1], m: m[2], d: m[3] } : { y: "", m: "", d: "" };
};

// Reads a pasted date: ISO (2023-03-14) or US order (03/14/2023, 3-14-23 is not guessed).
function parsePaste(text: string): Parts | null {
  const t = text.trim();
  let m = t.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) return { y: m[1], m: m[2], d: m[3] };
  m = t.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (m) return { y: m[3], m: m[1], d: m[2] };
  return null;
}

export function DateInput({ id, value, onChange, describedBy }: { id?: string; value: string; onChange: (iso: string) => void; describedBy?: string }) {
  const [parts, setParts] = useState<Parts>(() => split(value));
  const refs = { y: useRef<HTMLInputElement>(null), m: useRef<HTMLInputElement>(null), d: useRef<HTMLInputElement>(null) };
  useEffect(() => {
    if (value && value !== iso(parts)) setParts(split(value));
    // Only an outside change of value resets the boxes; typing is handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const update = (next: Parts) => {
    setParts(next);
    onChange(iso(next));
  };
  const type = (k: keyof Parts, raw: string) => {
    const digits = raw.replace(/\D/g, "").slice(0, SIZES[k]);
    update({ ...parts, [k]: digits });
    const i = ORDER.indexOf(k);
    // Move on once the box is full, or once a month or day can't take a second digit (4 to 9).
    const done = digits.length === SIZES[k] || (k !== "y" && digits.length === 1 && Number(digits) > (k === "m" ? 1 : 3));
    if (done && i < ORDER.length - 1) refs[ORDER[i + 1]].current?.focus();
  };
  const back = (k: keyof Parts, e: KeyboardEvent<HTMLInputElement>) => {
    const i = ORDER.indexOf(k);
    if (e.key === "Backspace" && parts[k] === "" && i > 0) refs[ORDER[i - 1]].current?.focus();
    if (e.key === "ArrowLeft" && e.currentTarget.selectionStart === 0 && i > 0) refs[ORDER[i - 1]].current?.focus();
    if (e.key === "ArrowRight" && e.currentTarget.selectionStart === parts[k].length && i < 2) refs[ORDER[i + 1]].current?.focus();
  };
  const paste = (e: ClipboardEvent<HTMLInputElement>) => {
    const p = parsePaste(e.clipboardData.getData("text"));
    if (!p) return;
    e.preventDefault();
    update(p);
    refs.d.current?.focus();
  };

  const box = (k: keyof Parts, label: string, placeholder: string, width: string) => (
    <input
      ref={refs[k]}
      id={k === "y" ? id : undefined}
      aria-label={label}
      aria-describedby={describedBy}
      inputMode="numeric"
      autoComplete="off"
      placeholder={placeholder}
      maxLength={SIZES[k]}
      value={parts[k]}
      onChange={(e) => type(k, e.target.value)}
      onKeyDown={(e) => back(k, e)}
      onPaste={paste}
      onFocus={(e) => e.target.select()}
      className={cx("h-full bg-transparent text-center tabular-nums outline-none placeholder:text-faint", width)}
    />
  );
  const partial = parts.y + parts.m + parts.d !== "" && !valid(parts) && parts.y.length === 4 && parts.m.length > 0 && parts.d.length > 0;
  return (
    <div className={cx("flex h-9 w-full items-center rounded-md border bg-sheet px-2 text-base focus-within:border-slate focus-within:outline-2 focus-within:outline-slate/30", partial ? "border-conflict" : "border-control")}>
      {box("y", "Year", "YYYY", "w-12")}
      <span aria-hidden className="px-0.5 text-faint">-</span>
      {box("m", "Month", "MM", "w-8")}
      <span aria-hidden className="px-0.5 text-faint">-</span>
      {box("d", "Day", "DD", "w-8")}
      {partial && <span className="ml-auto text-xs text-conflict">Not a real date</span>}
    </div>
  );
}
