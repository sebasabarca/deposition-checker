// Database connection. The connection string comes from DATABASE_URL (see .env.example).

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export type Database = ReturnType<typeof drizzle<typeof schema>>;

export function connect(url = process.env.DATABASE_URL): { db: Database; pool: Pool } {
  if (!url) throw new Error("DATABASE_URL is not set. Copy it from .env.example into .env.");
  const pool = new Pool({ connectionString: url });
  return { db: drizzle(pool, { schema }), pool };
}
