import { defineConfig } from "drizzle-kit";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { pgConnectionString } from "./src/connection.ts";

// Load the repo-root .env for local development. In Docker/CI the file is
// absent and the variables come from the environment directly, so ignore the
// error when it isn't found.
try {
  loadEnvFile(fileURLToPath(new URL("../../.env", import.meta.url)));
} catch {
  // No .env file present; rely on the existing environment.
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("Missing required environment variable: DATABASE_URL");

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: pgConnectionString(DATABASE_URL) },
});
