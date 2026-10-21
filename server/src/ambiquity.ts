const HEDGED_TOLERANCE = 30;
const EXACT_TOLERANCE = 5;

const SAME_MOMENT_GAP = 60;
const DAY = 24 * 60;

const HEDGES = [
  "around",
  "about",
  "maybe",
  "approximately",
  "roughly",
  "probably",
  "or so",
  "ish",
];
const PRECISE = ["exactly", "precisely", "sharp"];
const TIME_CUES = [
  "at",
  "around",
  "about",
  "by",
  "until",
  "after",
  "before",
  "approximately",
  "roughly",
  "maybe",
];

export type TimeCheck = {
  status: "no_times" | "compatible" | "incompatible" | "uncertain";
  detail: string;
};

type TimeMention = { minutes: number[]; hedged: boolean };
type Interval = [number, number];

function wordsAround(text: string, start: number, end: number): string {
  const before = text.slice(0, start).split(/\s+/).slice(-3).join(" ");
  const after = text.slice(end).split(/\s+/).slice(0, 3).join(" ");
  return `${before} ${after}`;
}

function hasWord(text: string, words: string[]): boolean {
  return words.some((word) => new RegExp(`\\b${word}\\b`).test(text));
}

function isHedgedNear(text: string, start: number, end: number): boolean {
  const nearby = wordsAround(text, start, end);
  if (hasWord(nearby, PRECISE)) return false;
  return hasWord(nearby, HEDGES);
}

export function findTimes(text: string): TimeMention[] {
  const lower = text.toLowerCase();
  const mentions: TimeMention[] = [];

  for (const match of lower.matchAll(/\b(midnight|noon)\b/g)) {
    const minutes = match[1] === "midnight" ? 0 : 12 * 60;
    const end = match.index + match[0].length;
    mentions.push({
      minutes: [minutes],
      hedged: isHedgedNear(lower, match.index, end),
    });
  }

  const pattern =
    /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?(?=[\s.,;!?]|$)/g;
  for (const match of lower.matchAll(pattern)) {
    const [fullMatch, hourText, minuteText, suffix] = match;
    const hour = Number(hourText);
    const minutes = Number(minuteText ?? 0);
    if (hour < 1 || hour > 12 || minutes > 59) continue;

    const start = match.index;
    const end = start + fullMatch.length;
    const previousWord = lower.slice(0, start).trim().split(/\s+/).pop() ?? "";
    const nextWord = lower.slice(end).trim().split(/\s+/)[0] ?? "";
    const followedByNoun =
      /^[a-z]/.test(nextWord) &&
      !["and", "or", "but", "maybe", "o'clock"].includes(
        nextWord.replace(/[.,;!?]$/, ""),
      );

    const isExplicit = Boolean(suffix || minuteText);
    const isCued = TIME_CUES.includes(previousWord) && !followedByNoun;
    if (!isExplicit && !isCued) continue;

    const base = (hour % 12) * 60 + minutes;
    const readings = suffix?.startsWith("a")
      ? [base]
      : suffix?.startsWith("p")
        ? [base + 12 * 60]
        : [base, base + 12 * 60];
    mentions.push({
      minutes: readings,
      hedged: isHedgedNear(lower, start, end),
    });
  }

  return mentions;
}

function circularGap(a: number, b: number): number {
  const diff = Math.abs(a - b) % DAY;
  return Math.min(diff, DAY - diff);
}

function combineMentions(
  mentions: TimeMention[],
): { readings: Interval[] } | null {
  const tolerance = mentions.some((m) => m.hedged)
    ? HEDGED_TOLERANCE
    : EXACT_TOLERANCE;
  const readingSets = mentions.reduce<number[][]>(
    (sets, mention) =>
      sets.flatMap((set) => mention.minutes.map((m) => [...set, m])),
    [[]],
  );

  const readings: Interval[] = [];
  for (const set of readingSets) {
    const anchor = set[0];
    const close = set.every((m) => circularGap(m, anchor) <= SAME_MOMENT_GAP);
    if (!close) continue;
    const unwrapped = set.map((m) =>
      m - anchor > DAY / 2 ? m - DAY : anchor - m > DAY / 2 ? m + DAY : m,
    );
    readings.push([
      Math.min(...unwrapped) - tolerance,
      Math.max(...unwrapped) + tolerance,
    ]);
  }

  return readings.length > 0 ? { readings } : null;
}

function overlapsOnClock(a: Interval, b: Interval): boolean {
  return [-DAY, 0, DAY].some(
    (shift) => a[0] <= b[1] + shift && b[0] + shift <= a[1],
  );
}

function format(minutes: number): string {
  const total = ((minutes % DAY) + DAY) % DAY;
  return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, "0")}`;
}

function describe(a: Interval, b: Interval): string {
  return `${format(a[0])}–${format(a[1])} vs ${format(b[0])}–${format(b[1])}`;
}

export function compareTimes(quote1: string, quote2: string): TimeCheck {
  const mentions1 = findTimes(quote1);
  const mentions2 = findTimes(quote2);
  if (mentions1.length === 0 || mentions2.length === 0) {
    return {
      status: "no_times",
      detail: "No reliably identifiable time in one or both quotes.",
    };
  }

  const combined1 = combineMentions(mentions1);
  const combined2 = combineMentions(mentions2);
  if (!combined1 || !combined2) {
    return {
      status: "uncertain",
      detail:
        "A quote mentions several unrelated times, so they cannot be compared safely.",
    };
  }

  for (const a of combined1.readings) {
    for (const b of combined2.readings) {
      if (overlapsOnClock(a, b)) {
        return {
          status: "compatible",
          detail: `Times can overlap (${describe(a, b)}), so the difference may be imprecise language.`,
        };
      }
    }
  }

  const a = combined1.readings[0];
  const b = combined2.readings[0];
  return {
    status: "incompatible",
    detail: `Times do not overlap under any reading (${describe(a, b)}).`,
  };
}
