# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Litigation associates and paralegals preparing for a deposition or trial. They work in long desktop sessions, going through a witness's sessions finding by finding, and hand the findings they keep to the trial attorney. The trial attorney is a secondary reader of the result.

## Product Purpose

Veridict finds places where a witness's testimony in one deposition session may conflict with another session, and lets the reviewer check each one against the exact page:line testimony and record a decision (keep, needs context, dismiss). Success is a reviewer who trusts what they see because the testimony itself is always on screen, and who never has to open a PDF to verify a finding.

## Positioning

Every finding is shown as the two passages of real testimony side by side, cited by page and line, with code-checked evidence kept apart from Claude's interpretation. The app never says a witness lied and never draws legal conclusions.

## Operating Context

- Objects: cases, witnesses, depositions (sessions, from PDF or text), analyses (a check of two sessions of one witness), findings (contradiction, needs context, compatible, unverified), review decisions with notes.
- Typical magnitudes: a handful of cases; 2–5 sessions per witness; 50–400 pages per session at 25 lines per page; an analysis yields 0–30 findings and costs about $1–$6.
- Citations follow the lawyer's form: `Webb Dep. 11:15–11:16 (Mar. 14, 2023)`.
- Text depositions without page:line numbers are accepted; they are cited by line of the file and are not official citations.

## Capabilities and Constraints

- Analyses run on Claude (Fable 5.1 batch by default) and cost real money; starting one needs a cost confirmation.
- Unverified findings stay visible but separated as "check manually".
- No login, no users, no matter numbers, no Bates ranges, no certified-transcript status: none of these exist in the data and must not be shown.
- The browser makes no third-party requests; fonts and icons ship with the app.

## Brand Commitments

- Name: Veridict. Logo: navy V with a slate-blue stroke and a serif wordmark (`client/public/veridict-logo.png`).
- The user pinned the look: a dark navy sidebar, a light grey canvas with plain white panels, a serif voice for titles, and testimony set like a transcript in a monospace with a line-number gutter.
- Collapsible sidebar with Overview, Cases, Depositions, Findings, Analyses and Help. No breadcrumbs.

## Evidence on Hand

Real public depositions (Hutchinson, June and September sessions) and synthetic fixtures (Webb, Whitfield) in the local database. No customers, testimonials, or accuracy figures exist; none may be invented.

## Product Principles

1. Testimony is the dominant thing on any screen that shows a finding; nothing competes with reading it.
2. Show evidence, not verdicts: code checks and Claude's reading are labelled as what they are.
3. It should feel like a legal work tool, not a startup: no gradients, no hype, no AI theatre.
4. Every number on screen is computed from real rows.

## Accessibility & Inclusion

Category is never conveyed by colour alone; text meets 4.5:1; every control works from the keyboard.
