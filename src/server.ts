/** musik.build API server — Bun + TypeScript port of server.py.
 *
 * The request handler is a plain `fetch(request: Request): Promise<Response>`
 * (`handleRequest` below) with zero Bun-specific APIs in the request path —
 * Bun.serve wraps it here, and a Cloudflare Worker entry can wrap the same
 * handler later. The only Bun-coupled pieces are SQLite (src/store.ts) and
 * static file serving (`serveStatic`, would become a Worker asset binding).
 *
 * All outbound HTTP sends `User-Agent: musik-build/1.0` — the edge blocks
 * default runtime UAs (Python-urllib/* got 403 / CF 1010).
 */

import path from "node:path";
import { statSync } from "node:fs";
import { Store } from "./store";
import type { Actor } from "../shared/types";

const PORT = parseInt(process.env.PORT ?? "8321", 10);
const ROOT = path.resolve(import.meta.dir, "..");
const DB_PATH = process.env.DB_PATH ?? path.join(ROOT, "data", "musik.db");
const DEV_AUTH = process.env.DEV_AUTH === "1";

const RAFT_ORIGIN = process.env.RAFT_ORIGIN ?? "https://app.raft.build";
const RAFT_API_ORIGIN = process.env.RAFT_API_ORIGIN ?? "https://api.raft.build";
const RAFT_CLIENT_ID = process.env.RAFT_CLIENT_ID ?? "";
const RAFT_CLIENT_SECRET = process.env.RAFT_CLIENT_SECRET ?? "";
const APP_ORIGIN = process.env.APP_ORIGIN ?? ""; // public https origin of THIS app

const PUBLIC_DIR = path.join(ROOT, "public");

const store = new Store(DB_PATH);

// token -> {claims, expiry}. Access tokens are opaque; cache claims briefly.
const tokenCache = new Map<string, { claims: any; exp: number }>();
const TOKEN_CACHE_TTL = 300; // seconds

// ---- outbound HTTP ----

async function httpJson(
  method: string,
  url: string,
  headers: Record<string, string> = {},
  body?: unknown
): Promise<any | null> {
  try {
    const resp = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "musik-build/1.0",
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(8000),
    });
    return await resp.json();
  } catch (e) {
    console.log(`http ${method} ${url} failed: ${e}`);
    return null;
  }
}

async function fetchUserinfo(token: string): Promise<any | null> {
  const cached = tokenCache.get(token);
  if (cached && cached.exp > Date.now() / 1000) return cached.claims;
  const claims = await httpJson("GET", `${RAFT_API_ORIGIN}/api/oauth/userinfo`, {
    Authorization: `Bearer ${token}`,
  });
  if (!claims || !claims.sub) return null;
  tokenCache.set(token, { claims, exp: Date.now() / 1000 + TOKEN_CACHE_TTL });
  return claims;
}

function claimsToActor(claims: any): Actor {
  return {
    id: String(claims.sub),
    kind: claims.type === "agent" ? "agent" : "human",
    name: claims.name || claims.preferred_username || String(claims.sub).slice(0, 8),
    handle: claims.preferred_username ?? null,
    picture: claims.picture ?? null,
  };
}

async function resolveActor(request: Request): Promise<Actor | null> {
  let token: string | null = null;
  const auth = request.headers.get("authorization") ?? "";
  if (auth.startsWith("Bearer ")) {
    token = auth.slice(7).trim();
  } else {
    // Agent Login sessions: the CLI stores the callback's session cookie
    // and presents it on later calls (raft integration invoke).
    const cookie = request.headers.get("cookie") ?? "";
    for (const part of cookie.split(";")) {
      const t = part.trim();
      const eq = t.indexOf("=");
      if (eq >= 0 && t.slice(0, eq) === "musik_session") {
        const v = t.slice(eq + 1);
        if (v) {
          token = v.trim();
          break;
        }
      }
    }
  }
  if (token) {
    const claims = await fetchUserinfo(token);
    if (claims) return claimsToActor(claims);
  }
  if (DEV_AUTH) {
    const dev = request.headers.get("x-dev-actor") ?? "";
    const i = dev.indexOf(":");
    if (i >= 0) {
      const kind = dev.slice(0, i);
      const aid = dev.slice(i + 1);
      if ((kind === "human" || kind === "agent") && aid) {
        return { id: aid, kind, name: aid, picture: null };
      }
    }
  }
  return null;
}

// ---- validation ----

function validGraph(g: any): boolean {
  // Light structural sanity only; semantics stay with the frontend/agents.
  return (
    typeof g === "object" &&
    g !== null &&
    !Array.isArray(g) &&
    Array.isArray(g.nodes) &&
    Array.isArray(g.edges)
  );
}

function isPlainObject(v: any): v is Record<string, any> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ---- response helpers ----

function sendJson(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function sendHtml(status: number, html: string, headers: Record<string, string> = {}): Response {
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", ...headers },
  });
}

function redirect(url: string): Response {
  return new Response(null, { status: 302, headers: { Location: url } });
}

function err(status: number, code: string, message: string): Response {
  return sendJson(status, { error: message, code });
}

/** Mirrors server.py's _body(): Content-Length <= 0 -> {}, > 5 MiB or
 *  unparseable -> null. (Non-object JSON also returns null here; the Python
 *  version would instead crash later with a 500.) */
async function readBody(request: Request): Promise<Record<string, any> | null> {
  const raw = request.headers.get("content-length");
  let length = 0;
  if (raw !== null) {
    length = parseInt(raw, 10);
    if (Number.isNaN(length)) return null;
  }
  if (length <= 0) return {};
  if (length > 5 * 1024 * 1024) return null;
  let text: string;
  try {
    text = await request.text();
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function appOrigin(request: Request): string {
  if (APP_ORIGIN) return APP_ORIGIN.replace(/\/+$/, "");
  const host = request.headers.get("host") ?? `127.0.0.1:${PORT}`;
  const scheme = request.headers.get("x-forwarded-proto") === "https" ? "https" : "http";
  return `${scheme}://${host}`;
}

/** Python's urllib.parse.quote: like encodeURIComponent but also escapes
 *  ! ' ( ) * and leaves `safe` chars untouched. */
function pyQuote(s: string, safe: string): string {
  let out = encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()
  );
  for (const ch of safe) {
    out = out.replaceAll("%" + ch.charCodeAt(0).toString(16).toUpperCase(), ch);
  }
  return out;
}

/** Python int() for query params: optional sign + digits, whitespace ok. */
function pyInt(s: string): number | null {
  return /^[+-]?\d+$/.test(s.trim()) ? parseInt(s.trim(), 10) : null;
}

// ---- request handler (CF-Worker-shaped) ----

export async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname;
  const method = request.method.toUpperCase();

  if (method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,PATCH,OPTIONS",
        "Access-Control-Allow-Headers": "Authorization,Content-Type,X-Dev-Actor",
      },
    });
  }

  if (method === "GET") return handleGet(request, url, pathname);
  if (method === "POST") return handlePost(request, pathname);
  if (method === "PATCH") return handlePatch(request, pathname);
  return new Response("Unsupported method", { status: 501 });
}

async function handleGet(request: Request, url: URL, pathname: string): Promise<Response> {
  if (pathname === "/api/health") {
    return sendJson(200, {
      ok: true,
      service: "musik.build",
      devAuth: DEV_AUTH,
      loginConfigured: !!RAFT_CLIENT_ID,
    });
  }

  if (pathname === "/api/me") {
    const actor = await resolveActor(request);
    if (!actor) return err(401, "UNAUTHORIZED", "missing or invalid credentials");
    return sendJson(200, actor);
  }

  if (pathname === "/login") return login(request);

  if (pathname === "/login/raft/callback") return loginCallback(request, url);

  if (pathname === "/logout") {
    // Clear the Agent Login session cookie; the browser frontend
    // clears localStorage['rap.token'] on its side.
    return new Response('{"ok":true}', {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Set-Cookie": "musik_session=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax",
      },
    });
  }

  if (pathname === "/.well-known/slock-agent-manifest.json") {
    return sendJson(200, manifest(appOrigin(request)));
  }

  if (pathname === "/api/loops") {
    if (!(await resolveActor(request))) {
      return err(401, "UNAUTHORIZED", "missing or invalid credentials");
    }
    const published = ["1", "true"].includes(url.searchParams.get("published") ?? "0");
    return sendJson(200, store.listLoops(published));
  }

  if (pathname === "/api/ops") {
    if (!(await resolveActor(request))) {
      return err(401, "UNAUTHORIZED", "missing or invalid credentials");
    }
    const raw = url.searchParams.get("limit");
    const parsed = raw !== null ? pyInt(raw) : null;
    const limit = parsed !== null ? Math.min(parsed, 100) : 20;
    return sendJson(200, store.recentOps(limit));
  }

  let m = /^\/api\/loops\/([0-9a-f]{32})$/.exec(pathname);
  if (m) {
    if (!(await resolveActor(request))) {
      return err(401, "UNAUTHORIZED", "missing or invalid credentials");
    }
    const loop = store.getLoop(m[1]);
    return loop ? sendJson(200, loop) : err(404, "NOT_FOUND", "loop not found");
  }

  m = /^\/api\/loops\/([0-9a-f]{32})\/ops$/.exec(pathname);
  if (m) {
    if (!(await resolveActor(request))) {
      return err(401, "UNAUTHORIZED", "missing or invalid credentials");
    }
    if (!store.getLoop(m[1])) return err(404, "NOT_FOUND", "loop not found");
    return sendJson(200, store.listOps(m[1]));
  }

  // static frontend
  return serveStatic(pathname);
}

async function handlePost(request: Request, pathname: string): Promise<Response> {
  const actor = await resolveActor(request);
  if (!actor) return err(401, "UNAUTHORIZED", "missing or invalid credentials");
  const body = await readBody(request);
  if (body === null) return err(400, "BAD_JSON", "request body must be valid JSON");

  if (pathname === "/api/loops") {
    const graph = body.graph ?? null;
    if (!validGraph(graph)) {
      return err(400, "BAD_GRAPH", "graph must be an object with nodes[] and edges[]");
    }
    const title = (body.title ? String(body.title) : "Untitled Loop").slice(0, 120);
    return sendJson(201, store.createLoop(title, graph, actor));
  }

  let m = /^\/api\/loops\/([0-9a-f]{32})\/publish$/.exec(pathname);
  if (m) {
    const loop = store.getLoop(m[1]);
    if (!loop) return err(404, "NOT_FOUND", "loop not found");
    if (loop.authorId !== actor.id) return err(403, "FORBIDDEN", "only the author can publish");
    if (loop.published) return sendJson(200, loop);
    return sendJson(200, store.publishLoop(loop.id, actor));
  }

  m = /^\/api\/loops\/([0-9a-f]{32})\/fork$/.exec(pathname);
  if (m) {
    const parent = store.getLoop(m[1]);
    if (!parent) return err(404, "NOT_FOUND", "loop not found");
    if (!parent.published && parent.authorId !== actor.id) {
      return err(403, "FORBIDDEN", "only published loops can be forked by others");
    }
    const title = body.title ? String(body.title).slice(0, 120) : null;
    return sendJson(201, store.forkLoop(parent, actor, title));
  }

  return err(404, "NOT_FOUND", "unknown endpoint");
}

async function handlePatch(request: Request, pathname: string): Promise<Response> {
  const actor = await resolveActor(request);
  if (!actor) return err(401, "UNAUTHORIZED", "missing or invalid credentials");
  const m = /^\/api\/loops\/([0-9a-f]{32})$/.exec(pathname);
  if (!m) return err(404, "NOT_FOUND", "unknown endpoint");
  const loop = store.getLoop(m[1]);
  if (!loop) return err(404, "NOT_FOUND", "loop not found");
  if (loop.authorId !== actor.id) {
    return err(403, "FORBIDDEN", "only the author can edit; fork the loop to remix it");
  }
  const body = await readBody(request);
  if (body === null) return err(400, "BAD_JSON", "request body must be valid JSON");
  const graph = body.graph ?? null;
  let title: string | null = null;
  if (body.title !== undefined && body.title !== null) {
    title = String(body.title).trim().slice(0, 120);
    if (title === "") title = null;
  }
  if (graph === null && title === null) {
    return err(400, "BAD_REQUEST", "PATCH needs graph and/or title");
  }
  if (graph !== null && !validGraph(graph)) {
    return err(400, "BAD_GRAPH", "graph must be an object with nodes[] and edges[]");
  }
  const op = isPlainObject(body.op) ? body.op : {};
  const defaultAction = graph === null ? "rename" : "update_graph";
  const action = String(op.action || defaultAction).slice(0, 40);
  let payload = isPlainObject(op.payload) ? op.payload : null;
  if (payload === null && title !== null) payload = { title };
  return sendJson(200, store.updateGraph(loop.id, graph, actor, action, payload, title));
}

// ---- Login with Raft ----

function login(request: Request): Response {
  if (!RAFT_CLIENT_ID) {
    return sendHtml(200, "<p>Login not configured yet (RAFT_CLIENT_ID unset).</p>");
  }
  const returnTo = `${appOrigin(request)}/login/raft/callback`;
  const url =
    `${RAFT_ORIGIN}/login-with-slock/setup` +
    `?client_id=${pyQuote(RAFT_CLIENT_ID, "/")}` +
    `&return_to=${pyQuote(returnTo, "")}`;
  return redirect(url);
}

async function loginCallback(request: Request, url: URL): Promise<Response> {
  const code = url.searchParams.get("code") ?? "";
  if (!code) return sendHtml(400, "<p>Missing Raft callback code.</p>");
  const tokenResp = await httpJson(
    "POST",
    `${RAFT_API_ORIGIN}/api/oauth/token`,
    {
      Authorization:
        "Basic " + Buffer.from(`${RAFT_CLIENT_ID}:${RAFT_CLIENT_SECRET}`).toString("base64"),
    },
    { grant_type: "authorization_code", code }
  );
  if (!tokenResp || !tokenResp.access_token) {
    return sendHtml(502, "<p>Raft token exchange failed. 请回应用重试登录。</p>");
  }
  const token = tokenResp.access_token;
  const claims = await fetchUserinfo(token);
  if (!claims) return sendHtml(502, "<p>Raft userinfo failed.</p>");
  // Two session shapes for two audiences:
  // - Agent Login (CLI): musik_session cookie, resolved server-side on
  //   every /api call (see resolveActor).
  // - Browser frontend: token in localStorage['rap.token'], sent as Bearer.
  const rawExpires = tokenResp.expires_in ?? 3600;
  const expires = Number.isFinite(+rawExpires) ? Math.trunc(+rawExpires) : 3600;
  const html = `<!doctype html><meta charset="utf-8">
<title>musik.build login</title>
<script>
localStorage.setItem('rap.token', ${JSON.stringify(token)});
location.replace('/');
</script>
<p>已登录，正在回到 musik.build…</p>`;
  return sendHtml(200, html, {
    "Set-Cookie": `musik_session=${token}; Path=/; Max-Age=${expires}; Secure; HttpOnly; SameSite=Lax`,
  });
}

// ---- agent manifest ----

function manifest(origin: string) {
  const loopIdPath = "/api/loops/{id}";
  return {
    schema: "raft-agent-manifest.v0",
    service: RAFT_CLIENT_ID || "musik-build",
    name: "musik.build",
    description:
      "Make a loop. Share it. See who picks it up. " +
      "musik.build — humans and agents create loops, " +
      "link them into songs, and pass them on. One API " +
      "for humans and agents; every operation is logged.",
    docs_url: `${origin}/`,
    app_origin: origin,
    execution: { mode: "http_api", base_url: `${origin}/api` },
    auth: { type: "login_with_raft", login_url: `${origin}/login` },
    context_check: { url: `${origin}/api/me`, method: "GET" },
    actions: [
      {
        name: "list_loops",
        description: "List loops; the published feed when published=1.",
        endpoint: { method: "GET", path: "/api/loops" },
        parameters: {
          published: { type: "string", description: "pass 1 for the published feed" },
        },
      },
      {
        name: "get_loop",
        description: "Get one loop with its full graph.",
        endpoint: { method: "GET", path: loopIdPath },
        parameters: {
          id: { type: "string", required: true, description: "loop id (32 hex chars)" },
        },
      },
      {
        name: "create_loop",
        description:
          "Create a loop. graph = {nodes:[], edges:[], " +
          "startId}; semantics are opaque to the backend. " +
          "Pass the full body via --data-json.",
        endpoint: { method: "POST", path: "/api/loops" },
        parameters: {
          title: { type: "string" },
          graph: { type: "object", required: true, description: "{nodes, edges, startId}" },
        },
        returns: { loop: { type: "object" } },
      },
      {
        name: "update_loop",
        description:
          "Replace a loop's graph (author only) and record " +
          "an op. Body: {graph, op?: {action, payload}} via " +
          "--data-json.",
        endpoint: { method: "PATCH", path: loopIdPath },
        parameters: {
          id: { type: "string", required: true },
          graph: { type: "object", required: true },
          op: { type: "object", description: "{action, payload} for the audit log" },
        },
      },
      {
        name: "publish_loop",
        description: "Publish a loop to the feed (author only).",
        endpoint: { method: "POST", path: `${loopIdPath}/publish` },
        parameters: {
          id: { type: "string", required: true },
        },
      },
      {
        name: "fork_loop",
        description:
          "Pass-it-on (接力/flip): fork a published loop " +
          "(or your own draft) into a new remixable loop " +
          "with lineage.",
        endpoint: { method: "POST", path: `${loopIdPath}/fork` },
        parameters: {
          id: { type: "string", required: true },
          title: { type: "string" },
        },
      },
      {
        name: "get_loop_ops",
        description: "Operation history of one loop (audit log).",
        endpoint: { method: "GET", path: `${loopIdPath}/ops` },
        parameters: {
          id: { type: "string", required: true },
        },
      },
      {
        name: "recent_ops",
        description: "Global recent operations across all loops.",
        endpoint: { method: "GET", path: "/api/ops" },
        parameters: {
          limit: { type: "string", description: "default 20, max 100" },
        },
      },
    ],
  };
}

// ---- static ----

function serveStatic(urlPath: string): Response {
  let p = urlPath;
  if (p === "/" || p === "") p = "/index.html";
  const publicRoot = path.resolve(PUBLIC_DIR);
  const target = path.resolve(publicRoot, p.replace(/^\/+/, ""));
  let isFile = false;
  if (target.startsWith(publicRoot)) {
    try {
      isFile = statSync(target).isFile();
    } catch {
      isFile = false;
    }
  }
  if (!target.startsWith(publicRoot) || !isFile) {
    if (p === "/index.html") {
      return new Response("musik.build API up (no frontend bundled yet)\n", {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    return err(404, "NOT_FOUND", "not found");
  }
  const ctype =
    {
      ".html": "text/html",
      ".js": "text/javascript",
      ".css": "text/css",
      ".png": "image/png",
      ".json": "application/json",
    }[path.extname(target)] ?? "application/octet-stream";
  const contentType =
    ctype.startsWith("text") || ctype === "application/json"
      ? `${ctype}; charset=utf-8`
      : ctype;
  return new Response(Bun.file(target), {
    headers: { "Content-Type": contentType },
  });
}

// ---- entrypoint ----

if (import.meta.main) {
  Bun.serve({
    port: PORT,
    hostname: "127.0.0.1",
    fetch: (req) => handleRequest(req),
  });
  console.log(
    `musik.build on :${PORT} (db=${DB_PATH}, DEV_AUTH=${DEV_AUTH}, ` +
      `client_id=${RAFT_CLIENT_ID || "unset"}, APP_ORIGIN=${APP_ORIGIN || "auto"})`
  );
}
