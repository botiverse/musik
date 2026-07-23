import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const port = 8391;
const base = `http://127.0.0.1:${port}`;
const state = await mkdtemp(path.join(tmpdir(), "musik-smoke-"));
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function run(args) {
  const result = spawnSync(pnpm, args, { stdio: "inherit", env: process.env });
  if (result.status !== 0) throw new Error(`${pnpm} ${args.join(" ")} failed`);
}

async function call(method, pathname, actor, body) {
  const headers = { "Content-Type": "application/json" };
  if (actor) headers["X-Dev-Actor"] = actor;
  const response = await fetch(base + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload = null;
  if ((response.headers.get("content-type") ?? "").includes("application/json")) {
    payload = await response.json();
  }
  return { response, payload };
}

run([
  "exec",
  "wrangler",
  "d1",
  "execute",
  "DB",
  "--local",
  "--persist-to",
  state,
  "--file",
  "migrations/0001_init.sql",
]);
run([
  "exec",
  "wrangler",
  "d1",
  "execute",
  "DB",
  "--local",
  "--persist-to",
  state,
  "--command",
  "INSERT INTO loops (id,title,author_id,author_kind,author_name,created_at,updated_at,graph,fork_root,published) VALUES ('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','Pre-migration','fixture','human','Fixture','2026-01-01T00:00:00.000+00:00','2026-01-01T00:00:00.000+00:00','{\"nodes\":[{\"id\":\"n1\",\"state\":{}}],\"edges\":[],\"startId\":\"n1\"}','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',0); INSERT INTO ops (id,loop_id,actor_id,actor_kind,actor_name,action,ts) VALUES ('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','fixture','human','Fixture','create_loop','2026-01-01T00:00:00.000+00:00');",
]);
run([
  "exec",
  "wrangler",
  "d1",
  "execute",
  "DB",
  "--local",
  "--persist-to",
  state,
  "--file",
  "migrations/0002_public_hardening.sql",
]);

const worker = spawn(
  pnpm,
  [
    "exec",
    "wrangler",
    "dev",
    "--local",
    "--port",
    String(port),
    "--persist-to",
    state,
    "--var",
    "DEV_AUTH:1",
    "--var",
    `APP_ORIGIN:${base}`,
  ],
  { stdio: ["ignore", "pipe", "pipe"], env: process.env },
);

let output = "";
worker.stdout.on("data", (chunk) => {
  output += chunk;
});
worker.stderr.on("data", (chunk) => {
  output += chunk;
});

try {
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 125));
    try {
      if ((await fetch(`${base}/api/health`)).ok) {
        ready = true;
        break;
      }
    } catch {
      // Worker is still starting.
    }
  }
  if (!ready) throw new Error(`Worker did not start:\n${output}`);

  const root = await fetch(base);
  assert.equal(root.status, 200);
  assert.match(root.headers.get("content-security-policy") ?? "", /script-src 'self'/);

  const manifest = await fetch(`${base}/.well-known/raft-agent-manifest.json`);
  assert.equal(manifest.status, 200);
  assert.equal((await manifest.json()).execution.mode, "http_api");

  const graph = {
    nodes: [{ id: "n1", x: 0, y: 0, state: { bpm: 96, grids: {} } }],
    edges: [],
    startId: "n1",
  };
  const preserved = await call("GET", "/api/loops/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "human:fixture");
  assert.equal(preserved.response.status, 200);
  assert.equal(preserved.payload.version, 1);
  const preservedOps = await call(
    "GET",
    "/api/loops/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/ops",
    "human:fixture",
  );
  assert.equal(preservedOps.payload.items.length, 1);

  const created = await call("POST", "/api/loops", "human:alice", {
    title: "Smoke Loop",
    graph,
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.payload.version, 1);
  const id = created.payload.id;

  assert.equal((await call("GET", `/api/loops/${id}`, "agent:ed")).response.status, 404);
  const mine = await call("GET", "/api/loops", "human:alice");
  assert.equal(mine.payload.items.length, 1);
  const sameSubjectAgent = await call("GET", "/api/loops", "agent:alice");
  assert.equal(sameSubjectAgent.payload.items.length, 0);
  assert.equal(
    (await call("PATCH", `/api/loops/${id}`, "agent:alice", {
      title: "Cross-kind",
      version: 1,
    })).response.status,
    403,
  );

  const published = await call("POST", `/api/loops/${id}/publish`, "human:alice", {
    published: true,
    version: 1,
  });
  assert.equal(published.response.status, 200);
  assert.equal(published.payload.version, 2);
  assert.equal((await call("GET", `/api/loops/${id}`, "agent:ed")).response.status, 200);

  const stale = await call("PATCH", `/api/loops/${id}`, "human:alice", {
    version: 1,
    title: "Stale",
  });
  assert.equal(stale.response.status, 409);

  const ops = await call("GET", "/api/ops", "agent:ed");
  assert.equal(ops.response.status, 200);
  assert.ok(ops.payload.items.some((op) => op.action === "publish"));
  assert.ok(!ops.payload.items.some((op) => op.action === "rename"));
  console.log("Worker/D1 smoke: PASS");
} finally {
  worker.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => worker.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
  if (!worker.killed) worker.kill("SIGKILL");
  await rm(state, { recursive: true, force: true });
}
