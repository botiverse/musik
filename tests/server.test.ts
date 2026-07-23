import assert from "node:assert/strict";
import test from "node:test";
import type { Actor, Graph, Loop, Op } from "../shared/types";
import {
  newId,
  nowIso,
  type LoopListOptions,
  type LoopStore,
  type Page,
  type PageCursor,
  type SessionRecord,
} from "../src/loop-store";
import { createHandler, type ServerConfig } from "../src/server";

const GRAPH: Graph = {
  nodes: [{ id: "n1", x: 0, y: 0, state: { bpm: 96, grids: {} } }],
  edges: [],
  startId: "n1",
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

class MemoryStore implements LoopStore {
  loops = new Map<string, Loop>();
  ops: Op[] = [];
  sessions = new Map<string, SessionRecord>();
  limits = new Map<string, { windowStart: number; count: number }>();

  async createLoop(title: string, graph: Graph, actor: Actor): Promise<Loop> {
    const id = newId();
    const ts = nowIso();
    const loop: Loop = {
      id,
      title,
      authorId: actor.id,
      authorKind: actor.kind,
      authorName: actor.name,
      createdAt: ts,
      updatedAt: ts,
      graph: clone(graph),
      forkedFrom: null,
      forkRoot: id,
      published: false,
      publishedAt: null,
      version: 1,
    };
    this.loops.set(id, loop);
    this.addOp(id, actor, "create_loop", { title });
    return clone(loop);
  }

  async getLoop(loopId: string): Promise<Loop | null> {
    const loop = this.loops.get(loopId);
    return loop ? clone(loop) : null;
  }

  async listLoops(options: LoopListOptions): Promise<Page<Loop>> {
    const atKey = options.publishedOnly ? "publishedAt" : "updatedAt";
    let loops = [...this.loops.values()].filter((loop) =>
      options.publishedOnly
        ? loop.published
        : loop.authorId === options.ownerId && loop.authorKind === options.ownerKind,
    );
    loops.sort((a, b) => {
      const at = String(b[atKey] ?? "").localeCompare(String(a[atKey] ?? ""));
      return at || b.id.localeCompare(a.id);
    });
    if (options.cursor) {
      loops = loops.filter((loop) => {
        const at = String(loop[atKey] ?? "");
        return at < options.cursor!.at || (at === options.cursor!.at && loop.id < options.cursor!.id);
      });
    }
    const visible = loops.slice(0, options.limit);
    const tail = visible.at(-1);
    return {
      items: clone(visible),
      nextCursor:
        loops.length > options.limit && tail
          ? { at: String(tail[atKey] ?? ""), id: tail.id }
          : null,
    };
  }

  async countLoopsByAuthor(authorId: string, authorKind: Actor["kind"]): Promise<number> {
    return [...this.loops.values()].filter(
      (loop) => loop.authorId === authorId && loop.authorKind === authorKind,
    ).length;
  }

  async updateGraph(
    loopId: string,
    graph: Graph | null,
    actor: Actor,
    action: string,
    payload: Record<string, any> | null,
    expectedVersion: number,
    title: string | null = null,
  ): Promise<Loop | null> {
    const loop = this.loops.get(loopId);
    if (!loop || loop.version !== expectedVersion) return null;
    if (graph) loop.graph = clone(graph);
    if (title) loop.title = title;
    loop.version += 1;
    loop.updatedAt = nowIso();
    this.addOp(loopId, actor, action, payload);
    return clone(loop);
  }

  async setPublished(
    loopId: string,
    actor: Actor,
    published: boolean,
    expectedVersion: number,
  ): Promise<Loop | null> {
    const loop = this.loops.get(loopId);
    if (!loop || loop.version !== expectedVersion) return null;
    loop.published = published;
    loop.publishedAt = published ? nowIso() : null;
    loop.updatedAt = nowIso();
    loop.version += 1;
    this.addOp(loopId, actor, published ? "publish" : "unpublish", null);
    return clone(loop);
  }

  async forkLoop(parent: Loop, actor: Actor, title: string | null): Promise<Loop> {
    const child = await this.createLoop(title || `Fork of ${parent.title}`, parent.graph, actor);
    child.forkedFrom = parent.id;
    child.forkRoot = parent.forkRoot;
    this.loops.set(child.id, clone(child));
    this.ops = this.ops.filter((op) => op.loopId !== child.id);
    this.addOp(child.id, actor, "fork", { from: parent.id, fromTitle: parent.title });
    return clone(child);
  }

  async listOps(
    loopId: string,
    limit: number,
    cursor?: PageCursor | null,
  ): Promise<Page<Op>> {
    let ops = this.ops
      .filter((op) => op.loopId === loopId)
      .sort((a, b) => a.ts.localeCompare(b.ts) || a.id.localeCompare(b.id));
    if (cursor) {
      ops = ops.filter((op) => op.ts > cursor.at || (op.ts === cursor.at && op.id > cursor.id));
    }
    return this.page(ops, limit);
  }

  async recentPublishedOps(
    limit: number,
    cursor?: PageCursor | null,
  ): Promise<Page<Op>> {
    let ops = this.ops
      .filter((op) => this.loops.get(op.loopId)?.published)
      .map((op) => ({ ...op, loopTitle: this.loops.get(op.loopId)?.title ?? null }))
      .sort((a, b) => b.ts.localeCompare(a.ts) || b.id.localeCompare(a.id));
    if (cursor) {
      ops = ops.filter((op) => op.ts < cursor.at || (op.ts === cursor.at && op.id < cursor.id));
    }
    return this.page(ops, limit);
  }

  async createSession(record: SessionRecord): Promise<void> {
    this.sessions.set(record.id, record);
  }

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    return this.sessions.get(sessionId) ?? null;
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }

  async consumeRateLimit(
    bucket: string,
    subject: string,
    limit: number,
    windowSeconds: number,
    nowSeconds: number,
  ): Promise<boolean> {
    const key = `${bucket}:${subject}`;
    const windowStart = Math.floor(nowSeconds / windowSeconds) * windowSeconds;
    const current = this.limits.get(key);
    const count = current?.windowStart === windowStart ? current.count + 1 : 1;
    this.limits.set(key, { windowStart, count });
    return count <= limit;
  }

  async pruneSecurityState(nowSeconds: number): Promise<void> {
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= nowSeconds) this.sessions.delete(id);
    }
  }

  private addOp(
    loopId: string,
    actor: Actor,
    action: string,
    payload: Record<string, any> | null,
  ) {
    this.ops.push({
      id: newId(),
      loopId,
      actorId: actor.id,
      actorKind: actor.kind,
      actorName: actor.name,
      action,
      payload,
      ts: nowIso(),
    });
  }

  private page<T extends { id: string; ts: string }>(items: T[], limit: number): Page<T> {
    const visible = items.slice(0, limit);
    const tail = visible.at(-1);
    return {
      items: clone(visible),
      nextCursor:
        items.length > limit && tail ? { at: tail.ts, id: tail.id } : null,
    };
  }
}

function config(fetchImpl?: typeof fetch): ServerConfig {
  return {
    devAuth: true,
    raftOrigin: "https://app.raft.build",
    raftApiOrigin: "https://api.raft.build",
    raftClientId: "musik-test",
    raftClientSecret: "client-secret",
    sessionSecret: "0123456789abcdef0123456789abcdef",
    appOrigin: "https://musik.test",
    fetchImpl,
  };
}

function request(
  path: string,
  init: RequestInit = {},
  actor?: `human:${string}` | `agent:${string}`,
): Request {
  const headers = new Headers(init.headers);
  if (actor) headers.set("X-Dev-Actor", actor);
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  return new Request(`https://musik.test${path}`, { ...init, headers });
}

async function json(response: Response): Promise<any> {
  return response.json();
}

test("drafts and draft ops are owner-only while published loops are readable", async () => {
  const store = new MemoryStore();
  const handler = createHandler(config(), store);

  const createdResponse = await handler(
    request("/api/loops", { method: "POST", body: JSON.stringify({ title: "Private", graph: GRAPH }) }, "human:alice"),
  );
  assert.equal(createdResponse.status, 201);
  const created = await json(createdResponse);

  const edList = await handler(request("/api/loops", {}, "agent:ed"));
  assert.deepEqual((await json(edList)).items, []);
  assert.equal((await handler(request(`/api/loops/${created.id}`, {}, "agent:ed"))).status, 404);
  assert.equal((await handler(request(`/api/loops/${created.id}/ops`, {}, "agent:ed"))).status, 404);
  assert.deepEqual((await json(await handler(request("/api/ops", {}, "agent:ed")))).items, []);

  const published = await handler(
    request(
      `/api/loops/${created.id}/publish`,
      { method: "POST", body: JSON.stringify({ published: true, version: created.version }) },
      "human:alice",
    ),
  );
  assert.equal(published.status, 200);
  assert.equal((await handler(request(`/api/loops/${created.id}`, {}, "agent:ed"))).status, 200);
  assert.equal((await handler(request(`/api/loops/${created.id}/ops`, {}, "agent:ed"))).status, 200);
  assert.ok((await json(await handler(request("/api/ops", {}, "agent:ed")))).items.length >= 1);
});

test("ownership is scoped to the exact actor kind and subject", async () => {
  const store = new MemoryStore();
  const handler = createHandler(config(), store);
  const created = await json(
    await handler(
      request(
        "/api/loops",
        { method: "POST", body: JSON.stringify({ title: "Human draft", graph: GRAPH }) },
        "human:alice",
      ),
    ),
  );

  assert.deepEqual(
    (await json(await handler(request("/api/loops", {}, "agent:alice")))).items,
    [],
  );
  assert.equal(
    (await handler(request(`/api/loops/${created.id}`, {}, "agent:alice"))).status,
    404,
  );
  assert.equal(
    (
      await handler(
        request(
          `/api/loops/${created.id}`,
          {
            method: "PATCH",
            body: JSON.stringify({ title: "Cross-kind", version: created.version }),
          },
          "agent:alice",
        ),
      )
    ).status,
    403,
  );
});

test("mutations require current versions and reject hostile origins", async () => {
  const handler = createHandler(config(), new MemoryStore());
  const created = await json(
    await handler(
      request("/api/loops", { method: "POST", body: JSON.stringify({ graph: GRAPH }) }, "human:alice"),
    ),
  );

  const stale = await handler(
    request(
      `/api/loops/${created.id}`,
      { method: "PATCH", body: JSON.stringify({ version: 99, title: "stale" }) },
      "human:alice",
    ),
  );
  assert.equal(stale.status, 409);

  const foreign = await handler(
    request("/api/loops", {
      method: "POST",
      headers: { Origin: "https://evil.test", "X-Dev-Actor": "human:alice" },
      body: JSON.stringify({ graph: GRAPH }),
    }),
  );
  assert.equal(foreign.status, 403);
});

test("graph validation rejects selector and markup injection ids", async () => {
  const handler = createHandler(config(), new MemoryStore());
  const badGraph = clone(GRAPH);
  badGraph.nodes[0].id = `x"]><img src=x onerror=alert(1)>`;
  const response = await handler(
    request(
      "/api/loops",
      { method: "POST", body: JSON.stringify({ graph: badGraph }) },
      "human:alice",
    ),
  );
  assert.equal(response.status, 400);
});

test("graph validation rejects state shapes that would crash feed rendering", async () => {
  const handler = createHandler(config(), new MemoryStore());
  for (const state of [{ grids: "not-a-grid" }, { bars: "not-a-map" }]) {
    const badGraph = clone(GRAPH);
    badGraph.nodes[0].state = state;
    const response = await handler(
      request(
        "/api/loops",
        { method: "POST", body: JSON.stringify({ graph: badGraph }) },
        "agent:ed",
      ),
    );
    assert.equal(response.status, 400);
  }
});

test("graph validation keeps legacy short grids compatible for client normalization", async () => {
  const handler = createHandler(config(), new MemoryStore());
  const legacyGraph = clone(GRAPH);
  legacyGraph.nodes[0].state = {
    grids: {
      drums: [[true, false]],
      keys: [],
      bars: [[true, false, true, false]],
    },
    bpm: 88,
    swing: 0.14,
    mood: "dark",
    bars: {},
  };
  const response = await handler(
    request(
      "/api/loops",
      { method: "POST", body: JSON.stringify({ graph: legacyGraph }) },
      "agent:ed",
    ),
  );
  assert.equal(response.status, 201);
});

test("static HTML receives a self-only script CSP and security headers", async () => {
  const handler = createHandler(
    config(),
    new MemoryStore(),
    () => new Response("<!doctype html><title>musik</title>", { headers: { "Content-Type": "text/html" } }),
  );
  const response = await handler(request("/"));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-security-policy") ?? "", /script-src 'self'/);
  assert.doesNotMatch(response.headers.get("content-security-policy") ?? "", /script-src[^;]*unsafe-inline/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
});

test("login uses canonical Raft setup and an opaque HttpOnly app session", async () => {
  let userinfoCalls = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/oauth/token")) {
      assert.match(String(new Headers(init?.headers).get("authorization")), /^Basic /);
      return Response.json({ access_token: "raw-secret-token", expires_in: 3600 });
    }
    if (url.endsWith("/api/oauth/userinfo")) {
      userinfoCalls += 1;
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer raw-secret-token");
      return Response.json({
        sub: "human-1",
        type: "human",
        name: "Alice",
        preferred_username: "alice",
      });
    }
    return new Response("not found", { status: 404 });
  };
  const store = new MemoryStore();
  const handler = createHandler(config(fetchImpl), store);
  const login = await handler(request("/login"));
  assert.equal(login.status, 302);
  const location = new URL(login.headers.get("location")!);
  assert.equal(location.pathname, "/login-with-raft/setup");
  assert.equal(location.searchParams.get("return_to"), "https://musik.test/login/raft/callback");
  const stateCookie = login.headers.get("set-cookie")!;
  assert.match(stateCookie, /__Host-musik_login_state=/);
  const statePair = stateCookie.split(";")[0];
  const state = decodeURIComponent(statePair.slice(statePair.indexOf("=") + 1));
  assert.equal(location.searchParams.get("state"), state);

  const wrongState = await handler(
    request("/login/raft/callback?code=abc&state=wrong", { headers: { Cookie: statePair } }),
  );
  assert.equal(wrongState.status, 400);
  assert.equal(store.sessions.size, 0);

  const callback = await handler(
    request(
      `/login/raft/callback?code=abc&state=${encodeURIComponent(state)}`,
      { headers: { Cookie: statePair } },
    ),
  );
  assert.equal(callback.status, 303);
  const cookies = callback.headers.getSetCookie();
  const sessionCookie = cookies.find((value) => value.startsWith("__Host-musik_session="));
  assert.ok(sessionCookie);
  assert.doesNotMatch(sessionCookie!, /raw-secret-token/);
  assert.equal(callback.headers.get("cache-control"), "no-store");
  assert.equal(store.sessions.size, 1);
  assert.doesNotMatch([...store.sessions.values()][0].tokenCiphertext, /raw-secret-token/);

  const sessionPair = sessionCookie!.split(";")[0];
  assert.equal((await handler(request("/api/me", { headers: { Cookie: sessionPair } }))).status, 200);
  assert.equal((await handler(request("/api/me", { headers: { Cookie: sessionPair } }))).status, 200);
  assert.equal(userinfoCalls, 3);
});

test("Agent Login consumes a stateless one-time handoff into a strict app session", async () => {
  let tokenCalls = 0;
  let userinfoCalls = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/oauth/token")) {
      tokenCalls += 1;
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body, {
        grant_type: "authorization_code",
        code: "agent-request",
      });
      if (tokenCalls > 1) {
        return Response.json({ error: "request already consumed" }, { status: 400 });
      }
      assert.match(String(new Headers(init?.headers).get("authorization")), /^Basic /);
      return Response.json({ access_token: "agent-secret-token", expires_in: 900 });
    }
    if (url.endsWith("/api/oauth/userinfo")) {
      userinfoCalls += 1;
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer agent-secret-token",
      );
      return Response.json({
        sub: "agent-1",
        type: "agent",
        name: "Beat Agent",
        preferred_username: "beat-agent",
      });
    }
    return new Response("not found", { status: 404 });
  };
  const store = new MemoryStore();
  const handler = createHandler(config(fetchImpl), store);

  const missingCode = await handler(request("/login/raft/callback"));
  assert.equal(missingCode.status, 400);
  assert.equal(tokenCalls, 0);

  const browserNavigation = await handler(
    request("/login/raft/callback?code=agent-request", {
      headers: { "User-Agent": "Mozilla/5.0" },
    }),
  );
  assert.equal(browserNavigation.status, 403);
  assert.equal(tokenCalls, 0);

  const callback = await handler(
    request("/login/raft/callback?code=agent-request", {
      headers: { Accept: "text/html,application/json" },
    }),
  );
  assert.equal(callback.status, 204);
  const sessionCookie = callback.headers
    .getSetCookie()
    .find((value) => value.startsWith("__Host-musik_session="));
  assert.ok(sessionCookie);
  assert.match(sessionCookie!, /HttpOnly/);
  assert.match(sessionCookie!, /Secure/);
  assert.match(sessionCookie!, /SameSite=Strict/);
  assert.doesNotMatch(sessionCookie!, /agent-secret-token/);
  assert.equal(store.sessions.size, 1);
  assert.doesNotMatch([...store.sessions.values()][0].tokenCiphertext, /agent-secret-token/);

  const sessionPair = sessionCookie!.split(";")[0];
  const me = await handler(request("/api/me", { headers: { Cookie: sessionPair } }));
  assert.equal(me.status, 200);
  assert.equal((await json(me)).kind, "agent");
  assert.equal(userinfoCalls, 2);

  const replay = await handler(request("/login/raft/callback?code=agent-request"));
  assert.equal(replay.status, 409);
  assert.equal(store.sessions.size, 1);
});

test("browser and Agent Login callbacks reject the wrong principal type", async () => {
  let principalType: Actor["kind"] = "human";
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/api/oauth/token")) {
      return Response.json({ access_token: "context-token", expires_in: 900 });
    }
    if (url.endsWith("/api/oauth/userinfo")) {
      return Response.json({
        sub: "context-principal",
        type: principalType,
        name: "Context Principal",
      });
    }
    return new Response("not found", { status: 404 });
  };
  const store = new MemoryStore();
  const handler = createHandler(config(fetchImpl), store);

  const humanThroughAgentHandoff = await handler(
    request("/login/raft/callback?code=human-request"),
  );
  assert.equal(humanThroughAgentHandoff.status, 403);
  assert.equal(store.sessions.size, 0);

  const login = await handler(request("/login"));
  const stateCookie = login.headers.get("set-cookie")!;
  const statePair = stateCookie.split(";")[0];
  const state = decodeURIComponent(statePair.slice(statePair.indexOf("=") + 1));
  principalType = "agent";
  const agentThroughBrowserCallback = await handler(
    request(
      `/login/raft/callback?code=agent-request&state=${encodeURIComponent(state)}`,
      { headers: { Cookie: statePair } },
    ),
  );
  assert.equal(agentThroughBrowserCallback.status, 403);
  assert.equal(store.sessions.size, 0);
});

test("malformed session cookies fail closed before persistence lookup", async () => {
  const store = new MemoryStore();
  let lookups = 0;
  const originalGetSession = store.getSession.bind(store);
  store.getSession = async (sessionId: string) => {
    lookups += 1;
    return originalGetSession(sessionId);
  };
  const handler = createHandler(config(), store);
  const response = await handler(
    request("/api/me", {
      headers: {
        Cookie: "__Host-musik_session=not-a-session-id",
        "X-Dev-Actor": "human:alice",
      },
    }),
  );
  assert.equal(response.status, 401);
  assert.equal(lookups, 0);
});

test("canonical and legacy manifest paths expose the same current contract", async () => {
  const handler = createHandler(config(), new MemoryStore());
  const canonical = await handler(request("/.well-known/raft-agent-manifest.json"));
  const legacy = await handler(request("/.well-known/slock-agent-manifest.json"));
  assert.equal(canonical.status, 200);
  assert.deepEqual(await json(canonical), await json(legacy));
});
