import pg from "pg";
import { config } from "./config.js";

// DATE columns as plain "YYYY-MM-DD"; TIME columns stay "HH:MM:SS"; bigint sums as numbers.
pg.types.setTypeParser(1082, (v) => v);
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

let shared: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (shared) return shared;
  if (!config.databaseUrl) throw new Error("DATABASE_URL must be set (see .env.example)");
  const url = new URL(config.databaseUrl);
  url.searchParams.delete("sslmode");
  const local = ["localhost", "127.0.0.1"].includes(url.hostname);
  const schema = config.dbSchema;
  if (schema && !/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error("DB_SCHEMA must be a simple lowercase name");
  // A schema of our own needs a session-level search_path, which transaction
  // poolers (Neon "-pooler" hosts, PgBouncer) drop; use the direct endpoint.
  if (schema) url.hostname = url.hostname.replace("-pooler.", ".");
  shared = new pg.Pool({
    connectionString: url.toString(),
    ssl: local ? undefined : { rejectUnauthorized: false },
    max: schema ? 4 : 8,
    connectionTimeoutMillis: 10000,
  });
  if (schema) {
    // Only our schema on the path: never read or write the host database's own tables.
    shared.on("connect", (client) => {
      client.query(`SET search_path TO "${schema}"`).catch(() => {});
    });
  }
  return shared;
}

export async function closePool(): Promise<void> {
  await shared?.end();
  shared = null;
}

export type Queryable = pg.Pool | pg.PoolClient;

export async function query<T extends pg.QueryResultRow = any>(sql: string, params: unknown[] = [], client: Queryable = getPool()): Promise<T[]> {
  return (await client.query<T>(sql, params)).rows;
}

export async function one<T extends pg.QueryResultRow = any>(sql: string, params: unknown[] = [], client: Queryable = getPool()): Promise<T | undefined> {
  return (await query<T>(sql, params, client))[0];
}

export async function transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
