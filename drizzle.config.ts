import "dotenv/config";
import { defineConfig } from "drizzle-kit";

// `npm run db:generate` writes SQL migrations to drizzle/ from the schema;
// `npm run db:migrate` applies them to the database in DATABASE_URL.
export default defineConfig({
  dialect: "postgresql",
  schema: "./server/src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
});
