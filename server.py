"""musik.build API server — stdlib-only HTTP backend + Login with Raft.

Endpoints (humans and agents share the same API; actor comes from auth):
  GET    /api/health
  GET    /api/me                                                    -> actor claims
  POST   /api/loops                 { title?, graph }                 -> loop
  GET    /api/loops                 ?published=1                      -> [loop]
  GET    /api/loops/:id                                               -> loop
  PATCH  /api/loops/:id             { graph, op?: {action, payload} } -> loop  (author only)
  POST   /api/loops/:id/publish                                       -> loop  (author only)
  POST   /api/loops/:id/fork        { title? }                        -> loop  (published or own)
  GET    /api/loops/:id/ops                                           -> [op]
  GET    /api/ops                   ?limit=N (default 20, max 100)    -> [op]  global ticker

Login with Raft:
  GET    /login                     -> 302 to Raft setup URL
  GET    /login/raft/callback?code  -> exchanges code, hands token to frontend
  GET    /.well-known/slock-agent-manifest.json -> agent behavior manifest

Auth on /api/*:
  Production: `Authorization: Bearer <Raft access token>`; resolved via
  {RAFT_API_ORIGIN}/api/oauth/userinfo (claims cached 5 min).
  Dev (DEV_AUTH=1): `X-Dev-Actor: human:alice` / `agent:ed` injects identity.

Static: serves ./public at / (same origin as the API, no CORS pain).
"""

import base64
import json
import os
import re
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

from store import Store

PORT = int(os.environ.get("PORT", "8321"))
DB_PATH = os.environ.get("DB_PATH", str(Path(__file__).parent / "data" / "musik.db"))
DEV_AUTH = os.environ.get("DEV_AUTH") == "1"

RAFT_ORIGIN = os.environ.get("RAFT_ORIGIN", "https://app.raft.build")
RAFT_API_ORIGIN = os.environ.get("RAFT_API_ORIGIN", "https://api.raft.build")
RAFT_CLIENT_ID = os.environ.get("RAFT_CLIENT_ID", "")
RAFT_CLIENT_SECRET = os.environ.get("RAFT_CLIENT_SECRET", "")
APP_ORIGIN = os.environ.get("APP_ORIGIN", "")  # public https origin of THIS app

PUBLIC_DIR = Path(__file__).parent / "public"

Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
store = Store(DB_PATH)

# token -> (claims, expiry_epoch). Access tokens are opaque; cache claims briefly.
_token_cache: dict[str, tuple[dict, float]] = {}
TOKEN_CACHE_TTL = 300


def _http_json(method: str, url: str, headers: dict | None = None,
               body: dict | None = None, timeout: int = 8) -> dict | None:
    try:
        req = urllib.request.Request(
            url, method=method,
            # Custom UA: the edge blocks Python-urllib/* with a 403 (CF 1010).
            headers={"Content-Type": "application/json",
                     "User-Agent": "musik-build/0.2", **(headers or {})},
            data=json.dumps(body).encode() if body is not None else None)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except Exception as e:
        print(f"http {method} {url} failed: {e}")
        return None


def fetch_userinfo(token: str) -> dict | None:
    cached = _token_cache.get(token)
    if cached and cached[1] > time.time():
        return cached[0]
    claims = _http_json("GET", f"{RAFT_API_ORIGIN}/api/oauth/userinfo",
                        headers={"Authorization": f"Bearer {token}"})
    if not claims or not claims.get("sub"):
        return None
    _token_cache[token] = (claims, time.time() + TOKEN_CACHE_TTL)
    return claims


def claims_to_actor(claims: dict) -> dict:
    return {
        "id": str(claims["sub"]),
        "kind": "agent" if claims.get("type") == "agent" else "human",
        "name": claims.get("name") or claims.get("preferred_username")
                or str(claims["sub"])[:8],
        "handle": claims.get("preferred_username"),
        "picture": claims.get("picture"),
    }


def resolve_actor(headers) -> dict | None:
    token = None
    auth = headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        token = auth[7:].strip()
    else:
        # Agent Login sessions: the CLI stores the callback's session cookie
        # and presents it on later calls (raft integration invoke).
        for part in headers.get("Cookie", "").split(";"):
            k, sep, v = part.strip().partition("=")
            if sep and k == "musik_session" and v:
                token = v.strip()
                break
    if token:
        claims = fetch_userinfo(token)
        if claims:
            return claims_to_actor(claims)
    if DEV_AUTH:
        dev = headers.get("X-Dev-Actor", "")
        kind, sep, aid = dev.partition(":")
        if sep and kind in ("human", "agent") and aid:
            return {"id": aid, "kind": kind, "name": aid, "picture": None}
    return None


def valid_graph(g) -> bool:
    # Light structural sanity only; semantics stay with the frontend/agents.
    return (
        isinstance(g, dict)
        and isinstance(g.get("nodes"), list)
        and isinstance(g.get("edges"), list)
    )


class Handler(BaseHTTPRequestHandler):
    server_version = "musik/0.2"

    # ---- plumbing ----

    def log_message(self, fmt, *args):
        print(f"{self.address_string()} {fmt % args}")

    def _send_json(self, status: int, body: dict | list):
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)

    def _send_html(self, status: int, html: str):
        data = html.encode()
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _redirect(self, url: str):
        self.send_response(302)
        self.send_header("Location", url)
        self.end_headers()

    def _err(self, status: int, code: str, message: str):
        self._send_json(status, {"error": message, "code": code})

    def _body(self) -> dict | None:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return None
        if length <= 0:
            return {}
        if length > 5 * 1024 * 1024:
            return None
        try:
            return json.loads(self.rfile.read(length).decode())
        except Exception:
            return None

    def _actor(self) -> dict | None:
        return resolve_actor(self.headers)

    def _app_origin(self) -> str:
        if APP_ORIGIN:
            return APP_ORIGIN.rstrip("/")
        host = self.headers.get("Host", f"127.0.0.1:{PORT}")
        scheme = "https" if self.headers.get("X-Forwarded-Proto") == "https" else "http"
        return f"{scheme}://{host}"

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS")
        self.send_header("Access-Control-Allow-Headers",
                         "Authorization,Content-Type,X-Dev-Actor")
        self.end_headers()

    # ---- routing ----

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)

        if path == "/api/health":
            return self._send_json(200, {
                "ok": True, "service": "musik.build",
                "devAuth": DEV_AUTH, "loginConfigured": bool(RAFT_CLIENT_ID)})

        if path == "/api/me":
            actor = self._actor()
            if not actor:
                return self._err(401, "UNAUTHORIZED", "missing or invalid credentials")
            return self._send_json(200, actor)

        if path == "/login":
            return self._login()

        if path == "/login/raft/callback":
            return self._login_callback(qs)

        if path == "/logout":
            # Clear the Agent Login session cookie; the browser frontend
            # clears localStorage['rap.token'] on its side.
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Set-Cookie",
                             "musik_session=; Path=/; Max-Age=0; "
                             "Secure; HttpOnly; SameSite=Lax")
            self.end_headers()
            self.wfile.write(b'{"ok":true}')
            return

        if path == "/.well-known/slock-agent-manifest.json":
            return self._manifest()

        if path == "/api/loops":
            if not self._actor():
                return self._err(401, "UNAUTHORIZED", "missing or invalid credentials")
            published = qs.get("published", ["0"])[0] in ("1", "true")
            return self._send_json(200, store.list_loops(published_only=published))

        if path == "/api/ops":
            if not self._actor():
                return self._err(401, "UNAUTHORIZED", "missing or invalid credentials")
            try:
                limit = min(int(qs.get("limit", ["20"])[0]), 100)
            except ValueError:
                limit = 20
            return self._send_json(200, store.recent_ops(limit))

        m = re.fullmatch(r"/api/loops/([0-9a-f]{32})", path)
        if m:
            if not self._actor():
                return self._err(401, "UNAUTHORIZED", "missing or invalid credentials")
            loop = store.get_loop(m.group(1))
            return self._send_json(200, loop) if loop else \
                self._err(404, "NOT_FOUND", "loop not found")

        m = re.fullmatch(r"/api/loops/([0-9a-f]{32})/ops", path)
        if m:
            if not self._actor():
                return self._err(401, "UNAUTHORIZED", "missing or invalid credentials")
            if not store.get_loop(m.group(1)):
                return self._err(404, "NOT_FOUND", "loop not found")
            return self._send_json(200, store.list_ops(m.group(1)))

        # static frontend
        return self._static(path)

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        actor = self._actor()
        if not actor:
            return self._err(401, "UNAUTHORIZED", "missing or invalid credentials")
        body = self._body()
        if body is None:
            return self._err(400, "BAD_JSON", "request body must be valid JSON")

        if path == "/api/loops":
            graph = body.get("graph")
            if not valid_graph(graph):
                return self._err(400, "BAD_GRAPH",
                                 "graph must be an object with nodes[] and edges[]")
            title = str(body.get("title") or "Untitled Loop")[:120]
            return self._send_json(201, store.create_loop(title, graph, actor))

        m = re.fullmatch(r"/api/loops/([0-9a-f]{32})/publish", path)
        if m:
            loop = store.get_loop(m.group(1))
            if not loop:
                return self._err(404, "NOT_FOUND", "loop not found")
            if loop["authorId"] != actor["id"]:
                return self._err(403, "FORBIDDEN", "only the author can publish")
            if loop["published"]:
                return self._send_json(200, loop)
            return self._send_json(200, store.publish_loop(loop["id"], actor))

        m = re.fullmatch(r"/api/loops/([0-9a-f]{32})/fork", path)
        if m:
            parent = store.get_loop(m.group(1))
            if not parent:
                return self._err(404, "NOT_FOUND", "loop not found")
            if not parent["published"] and parent["authorId"] != actor["id"]:
                return self._err(403, "FORBIDDEN",
                                 "only published loops can be forked by others")
            title = body.get("title")
            title = str(title)[:120] if title else None
            return self._send_json(201, store.fork_loop(parent, actor, title))

        return self._err(404, "NOT_FOUND", "unknown endpoint")

    def do_PATCH(self):
        parsed = urlparse(self.path)
        actor = self._actor()
        if not actor:
            return self._err(401, "UNAUTHORIZED", "missing or invalid credentials")
        m = re.fullmatch(r"/api/loops/([0-9a-f]{32})", parsed.path)
        if not m:
            return self._err(404, "NOT_FOUND", "unknown endpoint")
        loop = store.get_loop(m.group(1))
        if not loop:
            return self._err(404, "NOT_FOUND", "loop not found")
        if loop["authorId"] != actor["id"]:
            return self._err(403, "FORBIDDEN",
                             "only the author can edit; fork the loop to remix it")
        body = self._body()
        if body is None:
            return self._err(400, "BAD_JSON", "request body must be valid JSON")
        graph = body.get("graph")
        title = body.get("title")
        title = str(title).strip()[:120] if title is not None else None
        if title == "":
            title = None
        if graph is None and title is None:
            return self._err(400, "BAD_REQUEST",
                             "PATCH needs graph and/or title")
        if graph is not None and not valid_graph(graph):
            return self._err(400, "BAD_GRAPH",
                             "graph must be an object with nodes[] and edges[]")
        op = body.get("op") or {}
        default_action = "rename" if graph is None else "update_graph"
        action = str(op.get("action") or default_action)[:40]
        payload = op.get("payload") if isinstance(op.get("payload"), dict) else None
        if payload is None and title is not None:
            payload = {"title": title}
        return self._send_json(200, store.update_graph(loop["id"], graph, actor,
                                                       action, payload, title))

    # ---- Login with Raft ----

    def _login(self):
        if not RAFT_CLIENT_ID:
            return self._send_html(200, "<p>Login not configured yet "
                                        "(RAFT_CLIENT_ID unset).</p>")
        return_to = f"{self._app_origin()}/login/raft/callback"
        url = (f"{RAFT_ORIGIN}/login-with-slock/setup"
               f"?client_id={urllib.parse.quote(RAFT_CLIENT_ID)}"
               f"&return_to={urllib.parse.quote(return_to, safe='')}")
        return self._redirect(url)

    def _login_callback(self, qs):
        code = qs.get("code", [""])[0]
        if not code:
            return self._send_html(400, "<p>Missing Raft callback code.</p>")
        token_resp = _http_json(
            "POST", f"{RAFT_API_ORIGIN}/api/oauth/token",
            headers={"Authorization": "Basic " + base64.b64encode(
                f"{RAFT_CLIENT_ID}:{RAFT_CLIENT_SECRET}".encode()).decode()},
            body={"grant_type": "authorization_code", "code": code})
        if not token_resp or not token_resp.get("access_token"):
            return self._send_html(502, "<p>Raft token exchange failed. "
                                        "请回应用重试登录。</p>")
        token = token_resp["access_token"]
        claims = fetch_userinfo(token)
        if not claims:
            return self._send_html(502, "<p>Raft userinfo failed.</p>")
        # Two session shapes for two audiences:
        # - Agent Login (CLI): musik_session cookie, resolved server-side on
        #   every /api call (see resolve_actor).
        # - Browser frontend: token in localStorage['rap.token'], sent as Bearer.
        expires = int(token_resp.get("expires_in", 3600))
        html = f"""<!doctype html><meta charset="utf-8">
<title>musik.build login</title>
<script>
localStorage.setItem('rap.token', {json.dumps(token)});
location.replace('/');
</script>
<p>已登录，正在回到 musik.build…</p>"""
        data = html.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Set-Cookie",
                         f"musik_session={token}; Path=/; Max-Age={expires}; "
                         "Secure; HttpOnly; SameSite=Lax")
        self.end_headers()
        self.wfile.write(data)

    def _manifest(self):
        origin = self._app_origin()
        loop_id_path = "/api/loops/{id}"
        return self._send_json(200, {
            "schema": "raft-agent-manifest.v0",
            "service": RAFT_CLIENT_ID or "musik-build",
            "name": "musik.build",
            "description": "Make a loop. Share it. See who picks it up. "
                           "musik.build — humans and agents create loops, "
                           "link them into songs, and pass them on. One API "
                           "for humans and agents; every operation is logged.",
            "docs_url": f"{origin}/",
            "app_origin": origin,
            "execution": {"mode": "http_api", "base_url": f"{origin}/api"},
            "auth": {"type": "login_with_raft", "login_url": f"{origin}/login"},
            "context_check": {"url": f"{origin}/api/me", "method": "GET"},
            "actions": [
                {"name": "list_loops",
                 "description": "List loops; the published feed when published=1.",
                 "endpoint": {"method": "GET", "path": "/api/loops"},
                 "parameters": {
                     "published": {"type": "string",
                                   "description": "pass 1 for the published feed"}}},
                {"name": "get_loop",
                 "description": "Get one loop with its full graph.",
                 "endpoint": {"method": "GET", "path": loop_id_path},
                 "parameters": {
                     "id": {"type": "string", "required": True,
                            "description": "loop id (32 hex chars)"}}},
                {"name": "create_loop",
                 "description": "Create a loop. graph = {nodes:[], edges:[], "
                                "startId}; semantics are opaque to the backend. "
                                "Pass the full body via --data-json.",
                 "endpoint": {"method": "POST", "path": "/api/loops"},
                 "parameters": {
                     "title": {"type": "string"},
                     "graph": {"type": "object", "required": True,
                               "description": "{nodes, edges, startId}"}},
                 "returns": {"loop": {"type": "object"}}},
                {"name": "update_loop",
                 "description": "Replace a loop's graph (author only) and record "
                                "an op. Body: {graph, op?: {action, payload}} via "
                                "--data-json.",
                 "endpoint": {"method": "PATCH", "path": loop_id_path},
                 "parameters": {
                     "id": {"type": "string", "required": True},
                     "graph": {"type": "object", "required": True},
                     "op": {"type": "object",
                            "description": "{action, payload} for the audit log"}}},
                {"name": "publish_loop",
                 "description": "Publish a loop to the feed (author only).",
                 "endpoint": {"method": "POST",
                              "path": f"{loop_id_path}/publish"},
                 "parameters": {
                     "id": {"type": "string", "required": True}}},
                {"name": "fork_loop",
                 "description": "Pass-it-on (接力/flip): fork a published loop "
                                "(or your own draft) into a new remixable loop "
                                "with lineage.",
                 "endpoint": {"method": "POST", "path": f"{loop_id_path}/fork"},
                 "parameters": {
                     "id": {"type": "string", "required": True},
                     "title": {"type": "string"}}},
                {"name": "get_loop_ops",
                 "description": "Operation history of one loop (audit log).",
                 "endpoint": {"method": "GET", "path": f"{loop_id_path}/ops"},
                 "parameters": {
                     "id": {"type": "string", "required": True}}},
                {"name": "recent_ops",
                 "description": "Global recent operations across all loops.",
                 "endpoint": {"method": "GET", "path": "/api/ops"},
                 "parameters": {
                     "limit": {"type": "string",
                               "description": "default 20, max 100"}}},
            ],
        })

    # ---- static ----

    def _static(self, path: str):
        if path in ("/", ""):
            path = "/index.html"
        target = (PUBLIC_DIR / path.lstrip("/")).resolve()
        if not str(target).startswith(str(PUBLIC_DIR.resolve())) or not target.is_file():
            if path == "/index.html":
                self.send_response(200)
                self.send_header("Content-Type", "text/plain; charset=utf-8")
                self.end_headers()
                self.wfile.write(b"musik.build API up (no frontend bundled yet)\n")
                return
            return self._err(404, "NOT_FOUND", "not found")
        ctype = {".html": "text/html", ".js": "text/javascript",
                 ".css": "text/css", ".png": "image/png",
                 ".json": "application/json"}.get(target.suffix, "application/octet-stream")
        data = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", f"{ctype}; charset=utf-8"
                       if ctype.startswith("text") or ctype == "application/json"
                       else ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main():
    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"musik.build on :{PORT} (db={DB_PATH}, DEV_AUTH={DEV_AUTH}, "
          f"client_id={RAFT_CLIENT_ID or 'unset'}, APP_ORIGIN={APP_ORIGIN or 'auto'})")
    server.serve_forever()


if __name__ == "__main__":
    main()
