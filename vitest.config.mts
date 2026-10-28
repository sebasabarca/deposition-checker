import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The database tests in tests/db/ all reset the same test database, so files must not run at once.
    fileParallelism: false,
  },
});
