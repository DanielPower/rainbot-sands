import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.ts";

type DB = PostgresJsDatabase<typeof schema>;
export type DatabaseTransaction = Parameters<Parameters<DB["transaction"]>[0]>[0];

let instance: DB | null = null;

function getDb(): DB {
  if (!instance) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("Missing required environment variable: DATABASE_URL");
    instance = drizzle(postgres(url), { schema });
  }
  return instance;
}

// Lazy proxy: importing this module never reads DATABASE_URL or opens a
// connection. The real client is created on first query, so build-time module
// analysis (e.g. SvelteKit's prerender pass) doesn't require the env var.
export const db = new Proxy({} as DB, {
  get(_target, prop) {
    const real = getDb();
    const value = (real as unknown as Record<string | symbol, unknown>)[prop];
    return typeof value === "function" ? value.bind(real) : value;
  },
});
