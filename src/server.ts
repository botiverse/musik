/** Runtime-neutral musik.build HTTP handler.
 *
 * The production Worker supplies D1 persistence and a static-assets fallback.
 * Authentication supports fresh Raft bearer tokens and opaque app sessions;
 * access tokens never enter browser-readable storage.
 */

import type { Actor, Graph, Loop } from "../shared/types";
import type { LoopStore, PageCursor } from "./loop-store";
import {
  createLoginState,
  decryptAccessToken,
  encryptAccessToken,
  readCookie,
  verifyLoginState,
} from "./security";

export interface ServerConfig {
  devAuth: boolean;
  raftOrigin: string;
  raftApiOrigin: string;
  raftClientId: string;
  raftClientSecret: string;
  sessionSecret: string;
  appOrigin: string;
  fetchImpl?: typeof fetch;
}

export type FallbackHandler = (
  request: Request,
  pathname: string,
) => Response | Promise<Response>;

const SESSION_COOKIE = "__Host-musik_session";
const LOGIN_STATE_COOKIE = "__Host-musik_login_state";
const MAX_BODY_BYTES = 512 * 1024;
const MAX_LOOPS_PER_ACTOR = 100;
const MAX_GRAPH_NODES = 256;
const MAX_GRAPH_EDGES = 1024;
const MAX_PAGE_SIZE = 50;
const SAFE_NODE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SESSION_ID = /^[0-9a-f]{32}$/;
const GRID_ROWS = { drums: 5, k808: 6, keys: 8, bars: 1 } as const;
const GRID_STEPS = 16;
const ALLOWED_ACTIONS = new Set([
  "update_graph",
  "paint",
  "write_bar",
  "erase",
  "set_tempo",
  "set_swing",
  "set_mood",
  "clear",
  "starter",
  "add_node",
  "remove_node",
  "add_edge",
  "remove_edge",
  "set_start",
  "arrange",
  "rename_node",
]);

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "media-src 'self' blob:",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join("; ");

export function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  const contentType = headers.get("content-type") ?? "";
  if (contentType.includes("text/html")) {
    headers.set("Content-Security-Policy", CSP);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function sendJson(status: number, body: unknown, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Content-Type", "application/json; charset=utf-8");
  responseHeaders.set("Cache-Control", "no-store");
  return withSecurityHeaders(
    new Response(JSON.stringify(body), { status, headers: responseHeaders }),
  );
}

function sendHtml(status: number, html: string, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Content-Type", "text/html; charset=utf-8");
  responseHeaders.set("Cache-Control", "no-store");
  return withSecurityHeaders(new Response(html, { status, headers: responseHeaders }));
}

const AUTH_PAGE_COPY = {
  loginNotConfigured: {
    enTitle: "Sign-in is unavailable",
    enBody: "Login with Raft is not configured for musik.build.",
    zhTitle: "暂时无法登录",
    zhBody: "musik.build 尚未配置 Login with Raft。",
  },
  stateExpired: {
    enTitle: "Sign-in expired",
    enBody: "Your sign-in request is missing or expired. Start again from musik.build.",
    zhTitle: "登录请求已过期",
    zhBody: "登录请求不存在或已过期，请从 musik.build 重新开始。",
  },
  missingCode: {
    enTitle: "Sign-in could not continue",
    enBody: "The Raft callback code is missing. Start the sign-in flow again.",
    zhTitle: "无法继续登录",
    zhBody: "缺少 Raft 回调代码，请重新发起登录。",
  },
  tokenExchangeFailed: {
    enTitle: "Raft sign-in failed",
    enBody: "musik.build could not complete the Raft token exchange. Please try again.",
    zhTitle: "Raft 登录失败",
    zhBody: "musik.build 无法完成 Raft 令牌交换，请重试。",
  },
  userinfoFailed: {
    enTitle: "Raft identity could not be verified",
    enBody: "musik.build could not verify the Raft identity. Please try again.",
    zhTitle: "无法验证 Raft 身份",
    zhBody: "musik.build 无法验证 Raft 身份，请重试。",
  },
  humanRequired: {
    enTitle: "Human sign-in required",
    enBody: "Browser sign-in requires a Human Raft identity.",
    zhTitle: "需要 Human 身份登录",
    zhBody: "浏览器登录需要 Human 类型的 Raft 身份。",
  },
  agentBrowserRejected: {
    enTitle: "Complete Agent Login in the client",
    enBody: "This Agent Login callback is for the Raft client and cannot be opened as a browser page.",
    zhTitle: "请在客户端完成 Agent Login",
    zhBody: "此 Agent Login 回调由 Raft 客户端处理，不能作为浏览器页面打开。",
  },
  agentHandoffFailed: {
    enTitle: "Agent Login failed",
    enBody: "musik.build could not complete the Raft Agent Login handoff. Start a fresh Agent Login.",
    zhTitle: "Agent Login 失败",
    zhBody: "musik.build 无法完成 Raft Agent Login 交接，请重新发起 Agent Login。",
  },
  agentRequired: {
    enTitle: "Agent identity required",
    enBody: "Agent Login requires an Agent Raft identity.",
    zhTitle: "需要 Agent 身份",
    zhBody: "Agent Login 需要 Agent 类型的 Raft 身份。",
  },
} as const;

type AuthPageKind = keyof typeof AUTH_PAGE_COPY;

function sendAuthPage(status: number, kind: AuthPageKind, headers?: HeadersInit): Response {
  const copy = AUTH_PAGE_COPY[kind];
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${copy.enTitle} / ${copy.zhTitle} — musik.build</title>
  <style>
    :root{color-scheme:dark;--bg:#14120c;--panel:#1d1a12;--line:#4d4433;--text:#f2e9d0;--dim:#b8ae94;--accent:#ffb000;--keys:#3fe8a0}
    *{box-sizing:border-box}
    body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;padding:24px}
    main{width:min(680px,100%);border:3px solid var(--line);background:var(--panel);padding:clamp(24px,6vw,48px);box-shadow:5px 5px 0 rgba(0,0,0,.55)}
    .logo{font-size:20px;font-weight:800;letter-spacing:2px;text-transform:uppercase;margin-bottom:32px}.logo b{color:var(--keys)}
    section+section{border-top:1px solid var(--line);margin-top:24px;padding-top:24px}
    h1{font-size:clamp(20px,4vw,28px);line-height:1.25;margin:0 0 12px;letter-spacing:0}
    p{color:var(--dim);line-height:1.65;margin:0}
    a{display:inline-block;margin-top:32px;background:var(--accent);color:#1b1200;font-weight:800;text-decoration:none;padding:11px 16px;border:2px solid #8f6a10}
  </style>
</head>
<body>
  <main>
    <div class="logo" aria-label="musik.build">musik<b>.build</b></div>
    <section lang="en">
      <h1>${copy.enTitle}</h1>
      <p>${copy.enBody}</p>
    </section>
    <section lang="zh-CN">
      <h1>${copy.zhTitle}</h1>
      <p>${copy.zhBody}</p>
    </section>
    <a href="/">Return to musik.build / 返回 musik.build</a>
  </main>
</body>
</html>`;
  return sendHtml(status, html, headers);
}

function err(status: number, code: string, message: string): Response {
  return sendJson(status, { error: message, code });
}

function redirect(location: string, status = 302, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Location", location);
  responseHeaders.set("Cache-Control", "no-store");
  return withSecurityHeaders(new Response(null, { status, headers: responseHeaders }));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function claimsToActor(claims: unknown): Actor | null {
  if (!isPlainObject(claims)) return null;
  if (
    typeof claims.sub !== "string" ||
    claims.sub.length === 0 ||
    claims.sub.length > 128
  ) {
    return null;
  }
  if (claims.type !== "human" && claims.type !== "agent") return null;
  const rawName =
    typeof claims.name === "string" && claims.name
      ? claims.name
      : typeof claims.preferred_username === "string" && claims.preferred_username
        ? claims.preferred_username
        : claims.sub.slice(0, 8);
  const handle =
    typeof claims.preferred_username === "string"
      ? claims.preferred_username.slice(0, 120)
      : null;
  return {
    id: claims.sub,
    kind: claims.type,
    name: rawName.slice(0, 120),
    handle,
    picture:
      typeof claims.picture === "string" && claims.picture.length <= 2048
        ? claims.picture
        : null,
  };
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  const lengthHeader = request.headers.get("content-length");
  if (lengthHeader !== null) {
    const length = Number(lengthHeader);
    if (!Number.isInteger(length) || length < 0 || length > MAX_BODY_BYTES) return null;
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    return null;
  }
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) return null;
  if (text === "") return {};
  try {
    const parsed = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function validPatternState(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  if (value.grids !== undefined) {
    if (!isPlainObject(value.grids)) return false;
    for (const [section, rowCount] of Object.entries(GRID_ROWS)) {
      const rows = value.grids[section];
      if (rows === undefined) continue;
      if (!Array.isArray(rows) || rows.length > rowCount) return false;
      if (
        rows.some(
          (row) =>
            !Array.isArray(row) ||
            row.length > GRID_STEPS ||
            row.some((step) => typeof step !== "boolean"),
        )
      ) {
        return false;
      }
    }
  }
  if (value.bars !== undefined) {
    if (!isPlainObject(value.bars)) return false;
    const bars = Object.entries(value.bars);
    if (bars.length > GRID_STEPS) return false;
    for (const [step, lyric] of bars) {
      const index = Number(step);
      if (
        !/^\d{1,2}$/.test(step) ||
        !Number.isInteger(index) ||
        index < 0 ||
        index >= GRID_STEPS ||
        typeof lyric !== "string" ||
        lyric.length > 10
      ) {
        return false;
      }
    }
  }
  if (
    value.bpm !== undefined &&
    (!Number.isFinite(value.bpm) || Number(value.bpm) < 20 || Number(value.bpm) > 400)
  ) {
    return false;
  }
  if (
    value.swing !== undefined &&
    (!Number.isFinite(value.swing) || Number(value.swing) < 0 || Number(value.swing) > 1)
  ) {
    return false;
  }
  return value.mood === undefined || value.mood === "dark" || value.mood === "bright";
}

function validGraph(value: unknown): value is Graph {
  if (!isPlainObject(value) || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) {
    return false;
  }
  if (value.nodes.length === 0 || value.nodes.length > MAX_GRAPH_NODES) return false;
  if (value.edges.length > MAX_GRAPH_EDGES) return false;
  const ids = new Set<string>();
  for (const node of value.nodes) {
    if (!isPlainObject(node) || typeof node.id !== "string" || !SAFE_NODE_ID.test(node.id)) {
      return false;
    }
    if (ids.has(node.id) || !validPatternState(node.state)) return false;
    if (node.x !== undefined && (!Number.isFinite(node.x) || Math.abs(Number(node.x)) > 100000)) {
      return false;
    }
    if (node.y !== undefined && (!Number.isFinite(node.y) || Math.abs(Number(node.y)) > 100000)) {
      return false;
    }
    if (
      node.reps !== undefined &&
      (!Number.isInteger(node.reps) || Number(node.reps) < 1 || Number(node.reps) > 64)
    ) {
      return false;
    }
    ids.add(node.id);
  }
  for (const edge of value.edges) {
    if (
      !isPlainObject(edge) ||
      typeof edge.from !== "string" ||
      typeof edge.to !== "string" ||
      !ids.has(edge.from) ||
      !ids.has(edge.to)
    ) {
      return false;
    }
  }
  if (value.startId !== undefined && (typeof value.startId !== "string" || !ids.has(value.startId))) {
    return false;
  }
  if (value.counter !== undefined && (!Number.isInteger(value.counter) || Number(value.counter) < 0)) {
    return false;
  }
  if (value.master !== undefined) {
    if (!isPlainObject(value.master)) return false;
    if (value.master.align !== undefined && typeof value.master.align !== "boolean") return false;
    if (
      value.master.bpm !== undefined &&
      (!Number.isFinite(value.master.bpm) ||
        Number(value.master.bpm) < 20 ||
        Number(value.master.bpm) > 400)
    ) {
      return false;
    }
  }
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_BODY_BYTES;
  } catch {
    return false;
  }
}

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return value.slice(0, 160);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (depth >= 2) return null;
  if (Array.isArray(value)) {
    return value.slice(0, 16).map((item) => sanitizeValue(item, depth + 1));
  }
  if (isPlainObject(value)) {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, 16)) {
      output[key.slice(0, 40)] = sanitizeValue(item, depth + 1);
    }
    return output;
  }
  return null;
}

function sanitizePayload(value: unknown): Record<string, unknown> | null {
  if (!isPlainObject(value)) return null;
  return sanitizeValue(value) as Record<string, unknown>;
}

function parseLimit(url: URL, fallback: number): number | null {
  const raw = url.searchParams.get("limit");
  if (raw === null) return fallback;
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= MAX_PAGE_SIZE ? value : null;
}

function encodeCursor(cursor: PageCursor | null): string | null {
  if (!cursor) return null;
  return btoa(JSON.stringify(cursor))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function decodeCursor(value: string | null): PageCursor | null | false {
  if (value === null) return null;
  if (value.length === 0 || value.length > 256) return false;
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    const parsed = JSON.parse(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")));
    if (
      !isPlainObject(parsed) ||
      typeof parsed.at !== "string" ||
      parsed.at.length > 64 ||
      typeof parsed.id !== "string" ||
      !/^[0-9a-f]{32}$/.test(parsed.id)
    ) {
      return false;
    }
    return { at: parsed.at, id: parsed.id };
  } catch {
    return false;
  }
}

function pageBody<T>(page: { items: T[]; nextCursor: PageCursor | null }) {
  return { items: page.items, nextCursor: encodeCursor(page.nextCursor) };
}

function canonicalOrigin(config: ServerConfig, request: Request): string {
  if (config.appOrigin) return config.appOrigin.replace(/\/+$/, "");
  return new URL(request.url).origin;
}

function cookie(
  value: string,
  maxAge: number,
  sameSite: "Lax" | "Strict" = "Lax",
): string {
  return `${value}; Path=/; Secure; HttpOnly; SameSite=${sameSite}; Max-Age=${maxAge}`;
}

function isBrowserNavigation(request: Request): boolean {
  return (
    request.headers.get("sec-fetch-mode")?.toLowerCase() === "navigate" ||
    request.headers.get("sec-fetch-dest")?.toLowerCase() === "document" ||
    /^mozilla\/5\.0\b/i.test(request.headers.get("user-agent") ?? "")
  );
}

export function createHandler(
  config: ServerConfig,
  store: LoopStore,
  fallback?: FallbackHandler,
): (request: Request) => Promise<Response> {
  const fetchImpl = config.fetchImpl ?? fetch;

  async function fetchUserinfo(token: string): Promise<Actor | null> {
    let response: Response;
    try {
      response = await fetchImpl(`${config.raftApiOrigin}/api/oauth/userinfo`, {
        headers: {
          Authorization: `Bearer ${token}`,
          "User-Agent": "musik-build/2.0",
        },
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      return null;
    }
    if (!response.ok) return null;
    try {
      return claimsToActor(await response.json());
    } catch {
      return null;
    }
  }

  async function resolveActor(request: Request): Promise<Actor | null> {
    const authorization = request.headers.get("authorization") ?? "";
    const sessionId = readCookie(request, SESSION_COOKIE);
    if (authorization) {
      if (!authorization.startsWith("Bearer ")) return null;
      const token = authorization.slice(7).trim();
      return token ? fetchUserinfo(token) : null;
    }
    if (sessionId) {
      if (!SESSION_ID.test(sessionId)) return null;
      const session = await store.getSession(sessionId);
      const now = Math.floor(Date.now() / 1000);
      if (!session || session.expiresAt <= now || !config.sessionSecret) {
        if (session) await store.deleteSession(sessionId);
        return null;
      }
      const token = await decryptAccessToken(session.tokenCiphertext, config.sessionSecret);
      return token ? fetchUserinfo(token) : null;
    }
    if (config.devAuth) {
      const dev = request.headers.get("x-dev-actor") ?? "";
      const separator = dev.indexOf(":");
      if (separator > 0) {
        const kind = dev.slice(0, separator);
        const id = dev.slice(separator + 1);
        if ((kind === "human" || kind === "agent") && id && id.length <= 128) {
          return { id, kind, name: id, picture: null };
        }
      }
    }
    return null;
  }

  async function rateLimit(
    actor: Actor,
    bucket: string,
    limit: number,
    windowSeconds: number,
  ): Promise<Response | null> {
    const allowed = await store.consumeRateLimit(
      bucket,
      `${actor.kind}:${actor.id}`,
      limit,
      windowSeconds,
      Math.floor(Date.now() / 1000),
    );
    return allowed ? null : err(429, "RATE_LIMITED", "request rate limit exceeded");
  }

  function canRead(loop: Loop, actor: Actor): boolean {
    return loop.published || isOwner(loop, actor);
  }

  function isOwner(loop: Loop, actor: Actor): boolean {
    return loop.authorId === actor.id && loop.authorKind === actor.kind;
  }

  async function requireActor(request: Request): Promise<Actor | Response> {
    const actor = await resolveActor(request);
    return actor ?? err(401, "UNAUTHORIZED", "missing or invalid credentials");
  }

  async function handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const origin = request.headers.get("origin");
    if (
      origin &&
      origin !== canonicalOrigin(config, request) &&
      ["POST", "PATCH", "DELETE"].includes(method)
    ) {
      return err(403, "ORIGIN_FORBIDDEN", "cross-origin mutation rejected");
    }
    if (method === "OPTIONS") {
      return origin && origin !== canonicalOrigin(config, request)
        ? err(403, "ORIGIN_FORBIDDEN", "cross-origin request rejected")
        : withSecurityHeaders(new Response(null, { status: 204, headers: { Allow: "GET,POST,PATCH" } }));
    }
    if (method === "GET") return handleGet(request, url);
    if (method === "POST") return handlePost(request, url.pathname);
    if (method === "PATCH") return handlePatch(request, url.pathname);
    return err(405, "METHOD_NOT_ALLOWED", "method not allowed");
  }

  async function handleGet(request: Request, url: URL): Promise<Response> {
    const pathname = url.pathname;
    if (pathname === "/api/health") {
      return sendJson(200, {
        ok: true,
        service: "musik.build",
        devAuth: config.devAuth,
        loginConfigured: Boolean(
          config.raftClientId && config.raftClientSecret && config.sessionSecret,
        ),
      });
    }
    if (pathname === "/api/me") {
      const actor = await requireActor(request);
      return actor instanceof Response ? actor : sendJson(200, actor);
    }
    if (pathname === "/login") return login(request);
    if (pathname === "/login/raft/callback") return loginCallback(request, url);
    if (
      pathname === "/.well-known/raft-agent-manifest.json" ||
      pathname === "/.well-known/slock-agent-manifest.json"
    ) {
      return sendJson(200, manifest(canonicalOrigin(config, request)));
    }

    if (pathname === "/api/loops") {
      const actor = await requireActor(request);
      if (actor instanceof Response) return actor;
      const limited = await rateLimit(actor, "read", 600, 60);
      if (limited) return limited;
      const limit = parseLimit(url, 24);
      const cursor = decodeCursor(url.searchParams.get("cursor"));
      if (limit === null || cursor === false) {
        return err(400, "BAD_PAGE", "limit or cursor is invalid");
      }
      const publishedOnly = ["1", "true"].includes(
        url.searchParams.get("published") ?? "0",
      );
      return sendJson(
        200,
        pageBody(
          await store.listLoops({
            publishedOnly,
            ownerId: publishedOnly ? undefined : actor.id,
            ownerKind: publishedOnly ? undefined : actor.kind,
            limit,
            cursor,
          }),
        ),
      );
    }

    if (pathname === "/api/ops") {
      const actor = await requireActor(request);
      if (actor instanceof Response) return actor;
      const limited = await rateLimit(actor, "read", 600, 60);
      if (limited) return limited;
      const limit = parseLimit(url, 20);
      const cursor = decodeCursor(url.searchParams.get("cursor"));
      if (limit === null || cursor === false) {
        return err(400, "BAD_PAGE", "limit or cursor is invalid");
      }
      return sendJson(200, pageBody(await store.recentPublishedOps(limit, cursor)));
    }

    let match = /^\/api\/loops\/([0-9a-f]{32})$/.exec(pathname);
    if (match) {
      const actor = await requireActor(request);
      if (actor instanceof Response) return actor;
      const limited = await rateLimit(actor, "read", 600, 60);
      if (limited) return limited;
      const loop = await store.getLoop(match[1]);
      if (!loop) return err(404, "NOT_FOUND", "loop not found");
      return canRead(loop, actor)
        ? sendJson(200, loop)
        : err(404, "NOT_FOUND", "loop not found");
    }

    match = /^\/api\/loops\/([0-9a-f]{32})\/ops$/.exec(pathname);
    if (match) {
      const actor = await requireActor(request);
      if (actor instanceof Response) return actor;
      const limited = await rateLimit(actor, "read", 600, 60);
      if (limited) return limited;
      const loop = await store.getLoop(match[1]);
      if (!loop || !canRead(loop, actor)) return err(404, "NOT_FOUND", "loop not found");
      const limit = parseLimit(url, 50);
      const cursor = decodeCursor(url.searchParams.get("cursor"));
      if (limit === null || cursor === false) {
        return err(400, "BAD_PAGE", "limit or cursor is invalid");
      }
      return sendJson(200, pageBody(await store.listOps(loop.id, limit, cursor)));
    }

    if (fallback) return withSecurityHeaders(await fallback(request, pathname));
    return err(404, "NOT_FOUND", "not found");
  }

  async function handlePost(request: Request, pathname: string): Promise<Response> {
    if (pathname === "/logout") {
      const sessionId = readCookie(request, SESSION_COOKIE);
      if (sessionId && SESSION_ID.test(sessionId)) await store.deleteSession(sessionId);
      const headers = new Headers();
      headers.append("Set-Cookie", cookie(`${SESSION_COOKIE}=`, 0));
      headers.append("Set-Cookie", cookie(`${LOGIN_STATE_COOKIE}=`, 0));
      return sendJson(200, { ok: true }, headers);
    }

    const actor = await requireActor(request);
    if (actor instanceof Response) return actor;
    const generalLimit = await rateLimit(actor, "write", 120, 60);
    if (generalLimit) return generalLimit;
    const body = await readBody(request);
    if (body === null) return err(400, "BAD_JSON", "request body must be bounded JSON");

    if (pathname === "/api/loops") {
      const createLimit = await rateLimit(actor, "create", 20, 3600);
      if (createLimit) return createLimit;
      if ((await store.countLoopsByAuthor(actor.id, actor.kind)) >= MAX_LOOPS_PER_ACTOR) {
        return err(409, "LOOP_QUOTA", "loop quota reached");
      }
      if (!validGraph(body.graph)) {
        return err(
          400,
          "BAD_GRAPH",
          `graph needs 1-${MAX_GRAPH_NODES} valid nodes and at most ${MAX_GRAPH_EDGES} edges`,
        );
      }
      const rawTitle = typeof body.title === "string" ? body.title.trim() : "";
      const title = (rawTitle || "Untitled Loop").slice(0, 120);
      return sendJson(201, await store.createLoop(title, body.graph, actor));
    }

    let match = /^\/api\/loops\/([0-9a-f]{32})\/publish$/.exec(pathname);
    if (match) {
      const loop = await store.getLoop(match[1]);
      if (!loop) return err(404, "NOT_FOUND", "loop not found");
      if (!isOwner(loop, actor)) {
        return err(403, "FORBIDDEN", "only the author can change publication");
      }
      const expectedVersion = Number(body.version);
      const published = body.published === undefined ? true : body.published;
      if (!Number.isInteger(expectedVersion) || expectedVersion < 1 || typeof published !== "boolean") {
        return err(428, "VERSION_REQUIRED", "published and current version are required");
      }
      if (loop.published === published && loop.version === expectedVersion) {
        return sendJson(200, loop);
      }
      const updated = await store.setPublished(loop.id, actor, published, expectedVersion);
      return updated
        ? sendJson(200, updated)
        : err(409, "VERSION_CONFLICT", "loop changed; reload before publishing");
    }

    match = /^\/api\/loops\/([0-9a-f]{32})\/fork$/.exec(pathname);
    if (match) {
      const forkLimit = await rateLimit(actor, "fork", 30, 3600);
      if (forkLimit) return forkLimit;
      if ((await store.countLoopsByAuthor(actor.id, actor.kind)) >= MAX_LOOPS_PER_ACTOR) {
        return err(409, "LOOP_QUOTA", "loop quota reached");
      }
      const parent = await store.getLoop(match[1]);
      if (!parent) return err(404, "NOT_FOUND", "loop not found");
      if (!parent.published && !isOwner(parent, actor)) {
        return err(404, "NOT_FOUND", "loop not found");
      }
      const title =
        typeof body.title === "string" && body.title.trim()
          ? body.title.trim().slice(0, 120)
          : null;
      return sendJson(201, await store.forkLoop(parent, actor, title));
    }

    return err(404, "NOT_FOUND", "unknown endpoint");
  }

  async function handlePatch(request: Request, pathname: string): Promise<Response> {
    const actor = await requireActor(request);
    if (actor instanceof Response) return actor;
    const limited = await rateLimit(actor, "write", 120, 60);
    if (limited) return limited;
    const match = /^\/api\/loops\/([0-9a-f]{32})$/.exec(pathname);
    if (!match) return err(404, "NOT_FOUND", "unknown endpoint");
    const loop = await store.getLoop(match[1]);
    if (!loop) return err(404, "NOT_FOUND", "loop not found");
    if (!isOwner(loop, actor)) {
      return err(403, "FORBIDDEN", "only the author can edit; fork the loop to remix it");
    }
    const body = await readBody(request);
    if (body === null) return err(400, "BAD_JSON", "request body must be bounded JSON");
    const expectedVersion = Number(body.version);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
      return err(428, "VERSION_REQUIRED", "current loop version is required");
    }
    const graph = body.graph ?? null;
    let title: string | null = null;
    if (body.title !== undefined && body.title !== null) {
      if (typeof body.title !== "string" || body.title.trim() === "") {
        return err(400, "BAD_REQUEST", "title must be a non-empty string");
      }
      title = body.title.trim().slice(0, 120);
    }
    if (graph === null && title === null) {
      return err(400, "BAD_REQUEST", "PATCH needs graph and/or title");
    }
    if (graph !== null && !validGraph(graph)) {
      return err(400, "BAD_GRAPH", "graph structure or size is invalid");
    }
    const op = isPlainObject(body.op) ? body.op : {};
    const requestedAction = typeof op.action === "string" ? op.action : "";
    const action =
      graph === null ? "rename" : ALLOWED_ACTIONS.has(requestedAction) ? requestedAction : "update_graph";
    const payload =
      graph === null
        ? { title }
        : sanitizePayload(op.payload);
    const updated = await store.updateGraph(
      loop.id,
      graph as Graph | null,
      actor,
      action,
      payload,
      expectedVersion,
      title,
    );
    return updated
      ? sendJson(200, updated)
      : err(409, "VERSION_CONFLICT", "loop changed; reload before editing");
  }

  function loginReady(): boolean {
    return Boolean(
      config.raftClientId &&
        config.raftClientSecret &&
        config.sessionSecret &&
        config.sessionSecret.length >= 32,
    );
  }

  async function login(request: Request): Promise<Response> {
    if (!loginReady()) {
      return sendAuthPage(503, "loginNotConfigured");
    }
    const state = await createLoginState(config.sessionSecret);
    const headers = new Headers();
    headers.append("Set-Cookie", cookie(`${LOGIN_STATE_COOKIE}=${encodeURIComponent(state)}`, 600));
    const setup = new URL("/login-with-raft/setup", config.raftOrigin);
    setup.searchParams.set("client_id", config.raftClientId);
    setup.searchParams.set(
      "return_to",
      `${canonicalOrigin(config, request)}/login/raft/callback`,
    );
    setup.searchParams.set("state", state);
    return redirect(setup.toString(), 302, headers);
  }

  async function exchangeLoginCode(
    code: string,
  ): Promise<
    | { ok: true; accessToken: string; maxAge: number }
    | { ok: false; upstreamStatus: number | null }
  > {
    let tokenResponse: Response;
    try {
      tokenResponse = await fetchImpl(`${config.raftApiOrigin}/api/oauth/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${btoa(`${config.raftClientId}:${config.raftClientSecret}`)}`,
          "User-Agent": "musik-build/2.0",
        },
        body: JSON.stringify({ grant_type: "authorization_code", code }),
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      return { ok: false, upstreamStatus: null };
    }
    if (!tokenResponse.ok) {
      return { ok: false, upstreamStatus: tokenResponse.status };
    }
    let tokenBody: Record<string, unknown>;
    try {
      const parsed = await tokenResponse.json();
      if (!isPlainObject(parsed)) throw new Error("bad token response");
      tokenBody = parsed;
    } catch {
      return { ok: false, upstreamStatus: tokenResponse.status };
    }
    if (typeof tokenBody.access_token !== "string" || !tokenBody.access_token) {
      return { ok: false, upstreamStatus: tokenResponse.status };
    }
    const rawExpires = Number(tokenBody.expires_in ?? 3600);
    const maxAge = Math.min(
      Math.max(Number.isFinite(rawExpires) ? Math.trunc(rawExpires) : 3600, 60),
      86400,
    );
    return { ok: true, accessToken: tokenBody.access_token, maxAge };
  }

  async function createLoginSession(accessToken: string, maxAge: number): Promise<string> {
    const sessionId = crypto.randomUUID().replaceAll("-", "");
    await store.createSession({
      id: sessionId,
      tokenCiphertext: await encryptAccessToken(accessToken, config.sessionSecret),
      expiresAt: Math.floor(Date.now() / 1000) + maxAge,
    });
    await store.pruneSecurityState(Math.floor(Date.now() / 1000));
    return sessionId;
  }

  async function loginCallback(request: Request, url: URL): Promise<Response> {
    if (!loginReady()) return sendAuthPage(503, "loginNotConfigured");
    if (!url.searchParams.has("state")) {
      return agentLoginCallback(request, url);
    }
    const headers = new Headers();
    headers.append("Set-Cookie", cookie(`${LOGIN_STATE_COOKIE}=`, 0));
    const state = readCookie(request, LOGIN_STATE_COOKIE);
    const returnedState = url.searchParams.get("state");
    if (
      !state ||
      returnedState !== state ||
      !(await verifyLoginState(state, config.sessionSecret))
    ) {
      return sendAuthPage(400, "stateExpired", headers);
    }
    const code = url.searchParams.get("code") ?? "";
    if (!code) return sendAuthPage(400, "missingCode", headers);
    const exchanged = await exchangeLoginCode(code);
    if (!exchanged.ok) {
      return sendAuthPage(502, "tokenExchangeFailed", headers);
    }
    const actor = await fetchUserinfo(exchanged.accessToken);
    if (!actor) {
      return sendAuthPage(502, "userinfoFailed", headers);
    }
    if (actor.kind !== "human") {
      return sendAuthPage(403, "humanRequired", headers);
    }
    const sessionId = await createLoginSession(exchanged.accessToken, exchanged.maxAge);
    headers.append(
      "Set-Cookie",
      cookie(`${SESSION_COOKIE}=${encodeURIComponent(sessionId)}`, exchanged.maxAge),
    );
    return redirect("/", 303, headers);
  }

  async function agentLoginCallback(request: Request, url: URL): Promise<Response> {
    if (isBrowserNavigation(request)) {
      return sendAuthPage(403, "agentBrowserRejected");
    }
    const code = url.searchParams.get("code") ?? "";
    if (!code) return sendAuthPage(400, "missingCode");
    const exchanged = await exchangeLoginCode(code);
    if (!exchanged.ok) {
      const status = exchanged.upstreamStatus === 400 ? 409 : 502;
      return sendAuthPage(status, "agentHandoffFailed");
    }
    const actor = await fetchUserinfo(exchanged.accessToken);
    if (!actor) return sendAuthPage(502, "userinfoFailed");
    if (actor.kind !== "agent") {
      return sendAuthPage(403, "agentRequired");
    }
    const sessionId = await createLoginSession(exchanged.accessToken, exchanged.maxAge);
    const headers = new Headers();
    headers.append(
      "Set-Cookie",
      cookie(
        `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}`,
        exchanged.maxAge,
        "Strict",
      ),
    );
    return withSecurityHeaders(new Response(null, { status: 204, headers }));
  }

  function manifest(origin: string) {
    const loopPath = "/api/loops/{id}";
    const pageParameters = {
      limit: { type: "string", description: `page size, 1-${MAX_PAGE_SIZE}` },
      cursor: { type: "string", description: "opaque nextCursor from the previous response" },
    };
    return {
      schema: "raft-agent-manifest.v0",
      service: config.raftClientId || "musik-build",
      name: "musik.build",
      description:
        "A shared loop workstation where Humans and Agents build, publish, and remix music with visible provenance.",
      docs_url: `${origin}/`,
      app_origin: origin,
      execution: { mode: "http_api", base_url: `${origin}/api` },
      auth: { type: "login_with_raft", login_url: `${origin}/login` },
      context_check: { url: `${origin}/api/me`, method: "GET" },
      actions: [
        {
          name: "list_loops",
          description: "List your loops, or the public feed when published=1.",
          endpoint: { method: "GET", path: "/api/loops" },
          parameters: {
            published: { type: "string", description: "set to 1 for the published feed" },
            ...pageParameters,
          },
        },
        {
          name: "get_loop",
          description: "Get a published loop or one of your own drafts.",
          endpoint: { method: "GET", path: loopPath },
          parameters: { id: { type: "string", required: true } },
        },
        {
          name: "create_loop",
          description: "Create a draft loop with a bounded graph containing nodes and edges.",
          endpoint: { method: "POST", path: "/api/loops" },
          parameters: {
            title: { type: "string" },
            graph: { type: "object", required: true },
          },
        },
        {
          name: "update_loop",
          description: "Update your loop using the current optimistic-concurrency version.",
          endpoint: { method: "PATCH", path: loopPath },
          parameters: {
            id: { type: "string", required: true },
            version: { type: "number", required: true },
            graph: { type: "object" },
            title: { type: "string" },
            op: { type: "object", description: "bounded UI change hint; never authorization evidence" },
          },
        },
        {
          name: "publish_loop",
          description: "Publish or unpublish your loop using its current version.",
          endpoint: { method: "POST", path: `${loopPath}/publish` },
          parameters: {
            id: { type: "string", required: true },
            version: { type: "number", required: true },
            published: { type: "boolean", required: true },
          },
        },
        {
          name: "fork_loop",
          description: "Fork a published loop or one of your own drafts with lineage.",
          endpoint: { method: "POST", path: `${loopPath}/fork` },
          parameters: {
            id: { type: "string", required: true },
            title: { type: "string" },
          },
        },
        {
          name: "get_loop_ops",
          description: "Read operation history for a published loop or your own draft.",
          endpoint: { method: "GET", path: `${loopPath}/ops` },
          parameters: { id: { type: "string", required: true }, ...pageParameters },
        },
        {
          name: "recent_ops",
          description: "Read recent operations for published loops only.",
          endpoint: { method: "GET", path: "/api/ops" },
          parameters: pageParameters,
        },
      ],
    };
  }

  return handleRequest;
}
