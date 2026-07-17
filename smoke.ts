/** End-to-end smoke test for the musik.build API (Bun port of smoke.py).
 *
 * Spawns src/server.ts on a scratch port with DEV_AUTH=1 and a temp DB,
 * exercises every endpoint and the permission rules, prints PASS/FAIL.
 * Usage: bun run smoke.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PORT = 8391;
const BASE = `http://127.0.0.1:${PORT}`;
const ALICE = { "X-Dev-Actor": "human:alice" };
const ED = { "X-Dev-Actor": "agent:ed" };

const GRAPH = {
  nodes: [
    {
      id: "n1",
      name: "A",
      x: 0,
      y: 0,
      reps: 1,
      state: { bpm: 100, grids: { drums: [[1, 0, 1, 0]] } },
    },
  ],
  edges: [] as any[],
  startId: "n1",
};

const failures: string[] = [];

async function call(
  method: string,
  p: string,
  headers: Record<string, string> = {},
  body?: unknown
): Promise<[number, any]> {
  const resp = await fetch(BASE + p, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5000),
  });
  return [resp.status, await resp.json()];
}

function check(name: string, cond: boolean, detail = "") {
  const status = cond ? "PASS" : "FAIL";
  console.log(`[${status}] ${name}` + (detail && !cond ? ` — ${detail}` : ""));
  if (!cond) failures.push(name);
}

async function main() {
  const td = mkdtempSync(path.join(tmpdir(), "musik-smoke-"));
  const proc = Bun.spawn([process.execPath, path.join(import.meta.dir, "src", "server.ts")], {
    env: { ...process.env, PORT: String(PORT), DEV_AUTH: "1", DB_PATH: path.join(td, "test.db") },
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    for (let i = 0; i < 50; i++) {
      await Bun.sleep(100);
      try {
        const [s] = await call("GET", "/api/health");
        if (s === 200) break;
      } catch {
        // not up yet
      }
    }

    let [s, b] = await call("GET", "/api/health");
    check("health", s === 200 && b.ok === true);

    [s, b] = await call("GET", "/api/me", ALICE);
    check(
      "api/me dev actor",
      s === 200 && b.id === "alice" && b.kind === "human" && b.name === "alice"
    );

    [s, b] = await call("GET", "/.well-known/slock-agent-manifest.json");
    check(
      "agent manifest",
      s === 200 &&
        b.execution?.mode === "http_api" &&
        b.execution?.base_url?.endsWith("/api") &&
        b.context_check?.url?.endsWith("/api/me")
    );

    [s] = await call("GET", "/api/loops");
    check("no auth -> 401", s === 401);

    [s, b] = await call("POST", "/api/loops", ALICE, { bad: 1 });
    check("bad graph -> 400", s === 400);

    let loop: any;
    [s, loop] = await call("POST", "/api/loops", ALICE, {
      title: "Midnight Metro",
      graph: GRAPH,
    });
    check(
      "create loop",
      s === 201 &&
        loop.authorKind === "human" &&
        loop.forkRoot === loop.id &&
        loop.published === false
    );
    const lid = loop.id;

    [s, b] = await call("GET", `/api/loops/${lid}`, ED);
    check("get loop", s === 200 && b.id === lid);

    const g2 = JSON.parse(JSON.stringify(GRAPH));
    g2.nodes.push({ id: "n2", name: "B", x: 1, y: 0, reps: 2, state: { bpm: 92 } });
    g2.edges.push({ from: "n1", to: "n2" });
    [s, b] = await call("PATCH", `/api/loops/${lid}`, ED, { graph: g2 });
    check("non-author PATCH -> 403", s === 403);

    [s, b] = await call("PATCH", `/api/loops/${lid}`, ALICE, {
      graph: g2,
      op: { action: "add_node", payload: { id: "n2" } },
    });
    check("author PATCH", s === 200 && b.graph.nodes.length === 2);

    [s, b] = await call("PATCH", `/api/loops/${lid}`, ALICE, { title: "Renamed Metro" });
    check(
      "rename via title-only PATCH",
      s === 200 && b.title === "Renamed Metro" && b.graph.nodes.length === 2
    );

    [s, b] = await call("PATCH", `/api/loops/${lid}`, ED, { title: "Hijack" });
    check("non-author rename -> 403", s === 403);

    [s, b] = await call("PATCH", `/api/loops/${lid}`, ALICE, {});
    check("empty PATCH -> 400", s === 400);

    [s, b] = await call("POST", `/api/loops/${lid}/fork`, ED, {});
    check("fork unpublished other's -> 403", s === 403);

    [s, b] = await call("POST", `/api/loops/${lid}/publish`, ED);
    check("non-author publish -> 403", s === 403);

    [s, b] = await call("POST", `/api/loops/${lid}/publish`, ALICE);
    check("publish", s === 200 && b.published === true && !!b.publishedAt);

    let fork: any;
    [s, fork] = await call("POST", `/api/loops/${lid}/fork`, ED, { title: "808 Remix" });
    check(
      "fork published",
      s === 201 &&
        fork.forkedFrom === lid &&
        fork.forkRoot === lid &&
        fork.authorKind === "agent" &&
        fork.published === false
    );

    let feed: any;
    [s, feed] = await call("GET", "/api/loops?published=1", ED);
    check("published feed", s === 200 && feed.length === 1 && feed[0].id === lid);

    let ops: any;
    [s, ops] = await call("GET", `/api/loops/${lid}/ops`, ED);
    const actions = ops.map((o: any) => o.action);
    check(
      "loop ops",
      s === 200 &&
        JSON.stringify(actions) ===
          JSON.stringify(["create_loop", "add_node", "rename", "publish"]),
      JSON.stringify(actions)
    );
    check("op actor recorded", ops[1].actorId === "alice" && ops[1].actorKind === "human");
    check(
      "rename op payload",
      JSON.stringify(ops[2].payload) === JSON.stringify({ title: "Renamed Metro" })
    );

    let fops: any;
    [s, fops] = await call("GET", `/api/loops/${fork.id}/ops`, ALICE);
    check(
      "fork op on child",
      s === 200 && fops.length === 1 && fops[0].action === "fork" && fops[0].payload.from === lid
    );

    let recent: any;
    [s, recent] = await call("GET", "/api/ops?limit=10", ALICE);
    check(
      "global ops desc",
      s === 200 && recent[0].action === "fork" && recent[0].loopTitle === "808 Remix"
    );

    let allLoops: any;
    [s, allLoops] = await call("GET", "/api/loops", ALICE);
    check("list all", s === 200 && allLoops.length === 2);
  } finally {
    proc.kill();
    await proc.exited;
    rmSync(td, { recursive: true, force: true });
  }

  console.log(`\n${failures.length === 0 ? "ALL PASS" : `${failures.length} FAILURES: ${JSON.stringify(failures)}`}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

await main();
