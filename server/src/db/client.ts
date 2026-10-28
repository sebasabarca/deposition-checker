// Database connection. The connection string comes from DATABASE_URL (see .env.example).

import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient } from "pg";
import * as schema from "./schema";

export type Database = NodePgDatabase<typeof schema>;

export function connect(url = process.env.DATABASE_URL): { db: Database; pool: Pool } {
  if (!url) throw new Error("DATABASE_URL is not set. Copy it from .env.example into .env.");
  const pool = new Pool({ connectionString: url });
  return { db: drizzle(pool, { schema }), pool };
}

// Runs `fn` in one transaction on one connection. It gets a Drizzle handle and the raw client on
// that connection, so work done outside Drizzle (pg-boss queuing a job) commits or rolls back
// together with the rows written through Drizzle.
export async function withTransaction<T>(pool: Pool, fn: (db: Database, client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query("begin");
    const result = await fn(drizzle(client, { schema }), client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch((rollbackError: Error) => {
      broken = rollbackError; // the connection is unusable; don't return it to the pool
    });
    throw error;
  } finally {
    client.release(broken);
  }
}
