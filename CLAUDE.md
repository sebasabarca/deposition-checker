I am new to Claude Code, and this is my first project using an AI coding agent.

We are developing Deposition Checker v2, an application that analyzes legal depositions and identifies potential contradictions.

The repository contains an existing v1 implementation that we will upgrade.

I have an approved technical plan in DESIGN.md.

Your task is to review the repository, read DESIGN.md, and improve the existing CLAUDE.md.

Do not implement application features yet.

1. Understand the repository

Inspect the existing codebase and identify:

- Technologies currently used.
- Existing project structure.
- Available development commands.
- Testing framework and test commands.
- Reusable v1 functionality.
- Existing coding conventions.

Do not assume that planned v2 modules already exist.

2. Understand the approved design

Read DESIGN.md and identify:

- The application’s purpose.
- Approved technologies and architecture.
- Important technical constraints.
- Non-negotiable correctness requirements.
- Development priorities.

DESIGN.md is the source of truth for the planned architecture.

If existing code differs from DESIGN.md, distinguish between the current implementation and the intended v2 architecture.

Do not silently change the design.

3. Improve CLAUDE.md

Create a concise, practical set of project instructions.

Include these sections:

Project overview

Explain what Deposition Checker v2 does in a few sentences.

Technology stack

Document the existing stack and the approved v2 additions.

Repository structure

Explain the important existing directories and the planned module boundaries.

Development commands

Include only commands verified against the repository.

Architectural rules

Include these requirements:

- Follow DESIGN.md.
- Keep API requests separate from long-running analysis jobs.
- Never call an AI model directly from the client.
- Every displayed quotation must originate from stored transcript source lines.
- Never trust a model-generated citation without verification.
- Claude classifies contradictions, but TypeScript calculates confidence scores.
- Keep model interpretation separate from deterministic verification.
- Record every AI call’s token usage and cost.
- Preserve page and line references throughout processing.
- Do not silently discard failed or unprocessed evidence.

Development workflow

For each feature:

1. Read the relevant section of DESIGN.md.
2. Inspect the existing implementation.
3. Explain the proposed approach.
4. Identify affected files.
5. Wait for my approval before implementing significant changes.
6. Implement only the approved scope.
7. Add or update tests.
8. Run relevant tests and type checks.
9. Summarize changes and limitations.

Coding conventions

Follow the existing repository’s TypeScript conventions.

Prefer clear, maintainable code over unnecessary abstractions.

Do not add dependencies without explaining why they are necessary.

Git workflow

- Work on one feature at a time.
- Do not modify unrelated files.
- Do not commit unless I explicitly request it.
- Never rewrite Git history or discard existing work without permission.
- Summarize changes before suggesting a commit.

Communication preferences

I am a Computer Systems Technology student learning to use AI coding agents.

I want to understand the system I am building.

When proposing significant changes:

- Explain the reasoning in straightforward language.
- Explain important trade-offs.
- Identify what is new versus reused.
- Avoid unnecessary technical complexity.
- Ask for approval when deviating from DESIGN.md.

4. Keep CLAUDE.md concise

Aim for approximately 100–150 lines.

Avoid duplicating the entire DESIGN.md.

CLAUDE.md should explain how to work on the project, not reproduce the full implementation plan.

5. Expected result

Update CLAUDE.md only.

Then summarize:

1. What instructions you added.
2. What information came from the existing repository.
3. What information came from DESIGN.md.
4. Any inconsistencies or missing commands you discovered.

Do not implement features, install dependencies, or change application code yet.
