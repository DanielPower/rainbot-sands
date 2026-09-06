import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { PgBoss } from "pg-boss";
import { pgConnectionString } from "./connection.ts";

try {
  loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
} catch {
  // Docker and CI pass DATABASE_URL directly.
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("Missing required environment variable: DATABASE_URL");

const boss = new PgBoss({
  connectionString: pgConnectionString(connectionString),
  schedule: false,
  supervise: false,
  useListenNotify: false,
  max: 2,
});

await boss.start();
await boss.stop({ graceful: true });
