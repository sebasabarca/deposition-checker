import { defineConfig } from "vitest/config";

// Two projects (docs/commands.md, "Tests"):
//   unit:        pure tests, no database or local tools; run in parallel.
//   integration: tests/db/ (Postgres) and the real-document OCR checks; run in parallel, each Vitest worker
//                on its own database (tests/db/workerDatabase.mts), every file re-creating its schema.
const INTEGRATION = ["tests/db/**/*.test.ts", "tests/ingest/real-documents.test.ts"];
// Agent worktrees live under .claude/worktrees/ with their own copies of the tests: never run those here.
const EXCLUDE = ["**/node_modules/**", "**/dist/**", ".claude/**"];

export default defineConfig({
  test: {
    // Changes here can affect tests the import graph doesn't show, so `--changed` reruns everything.
    forceRerunTriggers: ["**/package.json/**", "**/vitest.config.*/**", "**/drizzle/**", "**/data/eval/**", "**/tests/fixtures/**", "**/tests/db/database.ts/**", "**/tests/db/workerDatabase.mts/**", "**/.env/**"],
    projects: [
      { extends: true, test: { name: "unit", include: ["tests/**/*.test.{ts,tsx}"], exclude: [...EXCLUDE, ...INTEGRATION] } },
      // Real files and Postgres under parallel load: some tests take 4-6 s (evidenceReal's re-read was 4.5 s
      // even run alone), so the 5 s default would fail on load, not on behaviour. Unit tests keep 5 s.
      { extends: true, test: { name: "integration", include: INTEGRATION, exclude: EXCLUDE, setupFiles: ["tests/db/workerDatabase.mts"], testTimeout: 20_000 } },
    ],
  },
});
