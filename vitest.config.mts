import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The database tests in tests/db/ all reset the same test database, so files must not run at once.
    fileParallelism: false,
    // Agent worktrees live under .claude/worktrees/ with their own copies of the tests: never run those here.
    exclude: ["**/node_modules/**", "**/dist/**", ".claude/**"],
  },
});
