// The version of code's checks on a verdict: Layer 1 and 2 (verify/), the consistency check, the
// context, corroboration and time checks and the inputs assess() is given. The rubric has its own
// version (findings.rubric_version). Each new finding stores this in its `checks` JSON as
// `verificationVersion`; a row stored before it existed reads as "unversioned". Change it whenever a
// change to that code can change a stored finding's checks, score, band or priority, and add a line
// below. Found by scripts/audit-findings.ts (recomputes every finding and names each difference's cause).
//
// unversioned, before Oct 29 fixes (findings #1-#12, the ellison-v1 and webb-synthetic-v1 pilots; no
//   commit history, see docs/agent-log.md, Oct 29): a bare "Yes"/"No" key phrase didn't stand for its
//   question and its evidence lines missed the answer; "maybe", "might have" weren't hedges; no
//   consistency check (inconsistent_verdict); a false positive with a context request went to
//   needs_context; a page gap was labelled "no context lines around an exchange".
// unversioned, Oct 29 to Oct 31 (until 3151264): Path A's claims fed the extraction-disagreement
//   check, worth -5 points (106 stored findings carry it; today's code always gives it no claims).
// unversioned, until 85ebc23 (Nov 1): quote matching read OCR's "|" literally, not as "I".
// unversioned, until bd8cdc8 (Nov 1): no unresolved_detail_difference consistency issue (adjudicate-v4).
// verify-2026-11-03: the code as of main 475778f; never stored (the audit's baseline).
//   + Milestone 2 (c97bf58): the answer reader ignores leading "A:", "A." and bare "A" turn markers.
// verify-2026-11-04 (Milestone 2.5): OCR pipes ("A |didn't.") read as noise or "I" in the answer reader
//   and spoken(); spoken() also strips "Q:"/"A:", an OCR "0:", capitals labels ("O.J. SIMPSON:") and
//   titled names ("Ms. Hutchinson."); the negation and tag checks read only the interrogative sentence;
//   a plain yes or no to a positive statement with a confirming tag ("…, correct?") adopts or denies it;
//   a hedge qualifies only its own clause (", and", " but"). The first version stored with findings.
export const VERIFICATION_VERSION = "verify-2026-11-04";

// The version a stored finding's checks were made with.
export const verificationVersionOf = (checks: unknown): string => {
  const v = (checks as { verificationVersion?: unknown } | null)?.verificationVersion;
  return typeof v === "string" ? v : "unversioned";
};
