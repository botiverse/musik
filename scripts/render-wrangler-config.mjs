import { writeFile } from "node:fs/promises";

const required = [
  "MUSIK_WORKER_NAME",
  "MUSIK_D1_DATABASE_ID",
  "MUSIK_CUSTOM_DOMAIN",
  "MUSIK_RAFT_CLIENT_ID",
  "MUSIK_APP_ORIGIN",
];

const missing = required.filter((name) => !process.env[name]?.trim());
if (missing.length) {
  throw new Error(`Missing production build variables: ${missing.join(", ")}`);
}

if (
  !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    process.env.MUSIK_D1_DATABASE_ID,
  )
) {
  throw new Error("MUSIK_D1_DATABASE_ID must be a UUID");
}
if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/i.test(process.env.MUSIK_CUSTOM_DOMAIN)) {
  throw new Error("MUSIK_CUSTOM_DOMAIN must be a hostname");
}
const appOrigin = new URL(process.env.MUSIK_APP_ORIGIN);
if (
  appOrigin.protocol !== "https:" ||
  appOrigin.pathname !== "/" ||
  appOrigin.search ||
  appOrigin.hash ||
  appOrigin.hostname !== process.env.MUSIK_CUSTOM_DOMAIN
) {
  throw new Error("MUSIK_APP_ORIGIN must be the HTTPS origin for MUSIK_CUSTOM_DOMAIN");
}

const quote = (value) => JSON.stringify(String(value));
const config = `# Generated in CI. Do not commit.
name = ${quote(process.env.MUSIK_WORKER_NAME)}
main = "src/worker.ts"
compatibility_date = "2026-01-01"
routes = [{ pattern = ${quote(process.env.MUSIK_CUSTOM_DOMAIN)}, custom_domain = true }]

[assets]
directory = "./public"
binding = "ASSETS"
run_worker_first = true

[[d1_databases]]
binding = "DB"
database_name = "musik"
database_id = ${quote(process.env.MUSIK_D1_DATABASE_ID)}
migrations_dir = "./migrations"

[vars]
RAFT_ORIGIN = "https://app.raft.build"
RAFT_API_ORIGIN = "https://api.raft.build"
RAFT_CLIENT_ID = ${quote(process.env.MUSIK_RAFT_CLIENT_ID)}
APP_ORIGIN = ${quote(process.env.MUSIK_APP_ORIGIN)}
`;

await writeFile(".wrangler.production.toml", config, { mode: 0o600 });
console.log("Rendered .wrangler.production.toml");
