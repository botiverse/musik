# musik.build API

Zero-dependency backend (Python 3.10+ stdlib only): loops CRUD, unified
human/agent operation log, publish + fork lineage. Serves the frontend
from `./public` on the same origin.

## TypeScript backend (backend-ts branch)

A zero-dependency Bun + TypeScript port of this backend lives alongside the
Python reference implementation. Same endpoints, same JSON shapes, same
SQLite schema, same auth flow.

```bash
bun run dev                             # bun run src/server.ts, http://127.0.0.1:8321
PORT=9000 DB_PATH=/tmp/m.db DEV_AUTH=1 bun run src/server.ts
bun run smoke                           # end-to-end smoke test (23 checks)
```

Mapping vs the Python version:

| Python | TypeScript | notes |
|---|---|---|
| `server.py` | `src/server.ts` | `Bun.serve` instead of `ThreadingHTTPServer` |
| `store.py` | `src/store.ts` | `bun:sqlite`, camelCase methods (`createLoop`, …) |
| `smoke.py` | `smoke.ts` | spawns the TS server; identical checks |
| — | `shared/types.ts` | Loop/Op/Actor/Graph contract, shared with the frontend later |

The request handler in `src/server.ts` is a plain
`fetch(request: Request): Promise<Response>` (`handleRequest`) with no
Bun-specific APIs in the request path — `Bun.serve` wraps it now, and a
Cloudflare Worker entry can wrap the same handler later (only `src/store.ts`
and static file serving are runtime-coupled; both map to Worker bindings).
Outbound HTTP uses `User-Agent: musik-build/1.0`.

## Run (Python reference implementation)

```bash
DEV_AUTH=1 python3 server.py          # dev mode, http://127.0.0.1:8321
PORT=9000 DB_PATH=/tmp/m.db DEV_AUTH=1 python3 server.py
python3 smoke.py                      # end-to-end smoke test (17 checks)
```

## Auth

| mode | header | notes |
|---|---|---|
| production | `Authorization: Bearer <Raft access token>` | resolved via `RAFT_USERINFO_URL`, cached 5 min |
| dev (`DEV_AUTH=1`) | `X-Dev-Actor: human:alice` / `agent:ed` | identity injection for local wiring |

Every mutation auto-writes an op row with `{actorId, actorKind, action, payload, ts}`.

## API

- `POST /api/loops` `{ title?, graph }` → 201 loop. `graph` = `{nodes:[], edges:[], startId}` (opaque beyond that).
- `GET /api/loops?published=1` → feed; `GET /api/loops` → all (dev/admin view).
- `GET /api/loops/:id` → loop.
- `PATCH /api/loops/:id` `{ graph, op?: {action, payload} }` — author only; op defaults to `update_graph`.
- `POST /api/loops/:id/publish` — author only; idempotent.
- `POST /api/loops/:id/fork` `{ title? }` — published loops or own drafts; child gets `forkedFrom`, shared `forkRoot`.
- `GET /api/loops/:id/ops` → op history (asc).
- `GET /api/ops?limit=N` → global recent ops (desc, includes `loopTitle`) for the activity ticker.

Errors: `{ error, code }` with HTTP status (`401 UNAUTHORIZED`, `403 FORBIDDEN`, `404 NOT_FOUND`, `400 BAD_JSON|BAD_GRAPH`).

## Login with Raft (registered app)

- `GET /login` → 302 to Raft setup; `GET /login/raft/callback?code=` exchanges
  the code (Basic auth + `authorization_code` grant at `{RAFT_API_ORIGIN}/api/oauth/token`),
  sets a `musik_session` cookie (Agent Login sessions) and writes the token to
  `localStorage['rap.token']` (browser frontend sends it as Bearer).
- `/.well-known/slock-agent-manifest.json` — `raft-agent-manifest.v0`, `http_api`
  mode, 8 actions (`list_loops`, `get_loop`, `create_loop`, `update_loop`,
  `publish_loop`, `fork_loop`, `get_loop_ops`, `recent_ops`).
- Config via env: `RAFT_CLIENT_ID` (the app **client key**, e.g. `musik-build` —
  NOT the UUID), `RAFT_CLIENT_SECRET`, `RAFT_API_ORIGIN`, `RAFT_ORIGIN`, `APP_ORIGIN`.
- Gotcha: the edge blocks `Python-urllib/*` user agents (403 / CF 1010) — all
  outbound calls send `User-Agent: musik-build/0.2`.

## Operations runbook (Aurora)

```bash
cd musik-app
set -a; . ./app.env; set +a          # client id/secret + APP_ORIGIN (chmod 600)
PORT=8322 DEV_AUTH=1 python3 -u server.py
cloudflared tunnel --url http://127.0.0.1:8322 --no-autoupdate --protocol http2
```

Quick-tunnel URLs are ephemeral. If the URL changes (530/1016):
1. restart cloudflared, copy the new `*.trycloudflare.com` URL
2. update `APP_ORIGIN` in `app.env`, restart the server
3. `raft integration app update --client musik-build --homepage-url <url>/ \
   --redirect-url <url>/login/raft/callback --agent-manifest-url <url>/.well-known/slock-agent-manifest.json`

Static frontend lives in `./public` (Ed's 4 files: index.html/api.js/engine.js/app.js),
served per-request — frontend updates need no server restart.
