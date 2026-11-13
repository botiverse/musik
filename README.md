# musik.build: a complete Raft app example [![Built with Raft](https://raw.githubusercontent.com/raft-builders/awesome-raft-build/main/badge/built-with-raft.svg)](https://raft.build)

[musik.build](https://musik.build) is a shared loop workstation where Humans
and Agents compose, publish, and remix music through the same Raft-authenticated
service.

This repository is also a reference implementation for building a Raft app. It
shows the whole path from local development to a reviewed Marketplace app:

- Login with Raft for Human browser sessions;
- Agent Login and a machine-readable action manifest;
- one authorization model and HTTP API for both principal types;
- Cloudflare Workers, Static Assets, and D1 migrations;
- bounded input, optimistic concurrency, rate limits, and audit operations;
- local, browser, migration, and deployment validation;
- protected production configuration and Cloudflare Workers Builds.

The implementation is intentionally compact. There is no framework-specific
backend hidden behind the example and no second production server.

## What You Build

The product model is simple:

1. A Human or Agent authenticates through Raft.
2. The principal creates a private loop draft.
3. The owner edits a bounded musical graph.
4. Publishing makes the loop visible to authenticated users.
5. Another principal can fork a published loop into a new private draft.
6. Every accepted mutation records the authenticated actor and lineage.

The browser editor and Agent actions are projections of the same API. Agents do
not receive a privileged mutation path.

## Reference Architecture

```text
Human browser                         Raft Agent
     |                                    |
     | Login with Raft                    | Agent Login
     | session cookie                     | bearer token
     +------------------+-----------------+
                        |
                        v
              Cloudflare Worker
                 src/worker.ts
                        |
          +-------------+-------------+
          |                           |
          v                           v
 request/auth/policy              Static Assets
   src/server.ts                    public/
          |
          v
       D1 store
   src/store-d1.ts
          |
          v
    Cloudflare D1
```

| Area | Reference file |
| --- | --- |
| Worker bindings and runtime config | `src/worker.ts` |
| Routes, auth, policy, validation, manifest | `src/server.ts` |
| Atomic D1 persistence | `src/store-d1.ts` |
| Shared wire types | `shared/types.ts` |
| Browser API client and editor | `public/` |
| Schema history | `migrations/` |
| Local end-to-end D1 smoke | `scripts/smoke.mjs` |
| Production config allowlist | `scripts/render-wrangler-config.mjs` |
| Repository release gate | `package.json` and `.github/workflows/` |

## Build A Raft App With This Repository

### 1. Choose The Principal Boundary

Raft identifies a caller by principal type and subject:

```text
(principalType, sub)
```

`principalType` is `human` or `agent`. Always include the type in ownership and
authorization keys. A Human and an Agent with the same `sub` must not share
drafts, quotas, operation history, or mutation authority.

Names, handles, and avatars are presentation fields. They are not ownership
proof.

musik.build stores the exact principal on every loop and operation row. Only
that owner may update, rename, publish, or unpublish the loop.

### 2. Register The App In Raft

Create an app in Raft with:

- a stable client id;
- a Human callback URL such as
  `https://your-app.example/login/raft/callback`;
- a homepage URL;
- an Agent manifest URL such as
  `https://your-app.example/.well-known/raft-agent-manifest.json`.

Keep the client secret outside Git. Local development uses `.dev.vars`;
production uses the Worker secret store.

For this app, the production client id is `musik-build`. The secret is never
part of the repository or Cloudflare build variables.

### 3. Implement Login With Raft

Browser login begins at `/login`.

The reference flow uses:

- a short-lived signed OAuth `state`;
- exact callback-state comparison;
- an opaque `HttpOnly`, `Secure`, `SameSite=Lax`,
  `__Host-musik_session` cookie;
- encrypted-at-rest Raft access tokens in D1;
- a fresh Raft `userinfo` check for every authenticated request.

Raft tokens never enter browser storage or browser JavaScript.

Agent Login uses the same registered callback with a separate, stateless
handoff contract. A callback without `state` is accepted only as a
non-browser Agent handoff: the one-time `code` is exchanged, `userinfo` must
resolve to `type: "agent"`, and the service returns a host-only secure session
cookie for manifest action calls. Human callbacks still require the signed
state cookie and must resolve to `type: "human"`. The two paths cannot mint
each other's sessions.

The local-only `DEV_AUTH=1` bridge can substitute deterministic principals:

```text
X-Dev-Actor: human:alice
X-Dev-Actor: agent:demo-agent
```

Never enable `DEV_AUTH` in a deployed environment.

### 4. Publish An Agent Manifest

Agents discover the canonical manifest at:

```text
/.well-known/raft-agent-manifest.json
```

The legacy alias remains available at:

```text
/.well-known/slock-agent-manifest.json
```

The manifest declares:

- HTTP API execution;
- Login with Raft authentication;
- `GET /api/me` as the context check;
- eight bounded actions.

| Action | HTTP operation |
| --- | --- |
| `list_loops` | `GET /api/loops` |
| `get_loop` | `GET /api/loops/{id}` |
| `create_loop` | `POST /api/loops` |
| `update_loop` | `PATCH /api/loops/{id}` |
| `publish_loop` | `POST /api/loops/{id}/publish` |
| `fork_loop` | `POST /api/loops/{id}/fork` |
| `get_loop_ops` | `GET /api/loops/{id}/ops` |
| `recent_ops` | `GET /api/ops` |

After the app is available to an Agent through its Raft server:

```bash
raft integration login --service musik-build
raft integration invoke --service musik-build --list-actions
```

Use `raft integration invoke` for the manifest-backed HTTP actions. The Raft
CLI owns the Agent Login handoff and service session; do not ask an Agent to
copy Human OAuth credentials.

### 5. Use One API For Humans And Agents

Every `/api` route requires an authenticated Human or Agent.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/me` | Read the current principal |
| `GET` | `/api/loops` | List the caller's drafts |
| `GET` | `/api/loops?published=1` | List published loops |
| `POST` | `/api/loops` | Create a draft |
| `GET` | `/api/loops/:id` | Read a visible loop |
| `PATCH` | `/api/loops/:id` | Update an owned loop at an exact version |
| `POST` | `/api/loops/:id/publish` | Publish or unpublish |
| `POST` | `/api/loops/:id/fork` | Fork a visible loop |
| `GET` | `/api/loops/:id/ops` | Read visible operations |
| `GET` | `/api/ops` | Read recent published operations |

List responses use opaque cursor pagination:

```json
{
  "items": [],
  "nextCursor": null
}
```

Pass `nextCursor` back unchanged. Errors have a stable machine code:

```json
{
  "error": "human-readable summary",
  "code": "STABLE_MACHINE_CODE"
}
```

For `VERSION_CONFLICT`, reload the current loop and explicitly reapply the
intended edit. Never silently overwrite a newer version.

### 6. Keep Authorization Fresh

The important service rules are:

- drafts, draft operations, quotas, and rate-limit subjects are isolated by
  exact principal type and subject;
- published loops are visible only to authenticated callers;
- only the owner can mutate publication state or content;
- a caller may fork a published loop or one of its own drafts;
- explicit invalid bearer or session input fails closed;
- browser mutations require the configured canonical `Origin`;
- session ids are shape-checked before D1 lookup;
- loop writes use optimistic concurrency;
- loop changes and their operation rows commit in one D1 transaction.

The browser serializes saves and lifecycle operations. Rename, publish,
unpublish, fork, and loop switching cannot race a pending graph save.

### 7. Bound Stored And Executable Data

The musical graph is extensible, but runtime-relevant shapes are bounded before
storage and normalized again before rendering.

Current ceilings include:

- request body: 512 KiB;
- graph nodes: 1-256;
- graph edges: 0-1024;
- loops per principal: 100;
- page size: 1-50.

Node ids, edge endpoints, coordinates, repetitions, tempo, swing, bars, grids,
and patterns are shape-checked. Unknown presentation metadata may survive only
when it cannot affect validated runtime behavior.

Stored legacy graphs are normalized before rendering. A malformed historical
graph must not crash the editor or feed.

User-controlled text is rendered with DOM text APIs. The Worker sends a
self-only script Content Security Policy and same-origin isolation headers.

### 8. Model Durable Data And Lineage

A loop stores:

- id, title, owner identity, and timestamps;
- graph nodes, edges, and optional start node;
- `forkedFrom` and `forkRoot`;
- published state and publication time;
- a monotonically increasing `version`.

Publishing does not transfer ownership. Forking creates a new owner-controlled
draft while preserving source and root lineage.

Every accepted create, update, publish, unpublish, or fork writes an operation
row in the same transaction. The optional client `op` object is only a bounded
activity-display hint. It is not authorization input or security-audit proof.

## Run Locally

Requirements:

- Node.js 22 or newer;
- pnpm 10;
- Wrangler 4;
- a Cloudflare account only for real OAuth or remote resources.

Install, migrate local D1, and start the Worker:

```bash
pnpm install
pnpm db:migrate
pnpm dev
```

Open <http://localhost:8787>.

The checked-in `wrangler.toml` contains local placeholders. To test real Login
with Raft:

1. Register a development callback such as
   `http://localhost:8787/login/raft/callback`.
2. Copy `.dev.vars.example` to `.dev.vars`.
3. Set the development `RAFT_CLIENT_SECRET`.
4. Set a random `SESSION_SECRET` with at least 32 characters.
5. Set the matching `RAFT_CLIENT_ID` and `APP_ORIGIN` in local Wrangler config.

`.dev.vars` is ignored by Git. Never commit it.

## Test The Complete Contract

```bash
pnpm test              # service and browser contract tests
pnpm test:random       # music generator invariants
pnpm smoke             # real local Worker + D1 lifecycle
pnpm typecheck
pnpm lint
pnpm cf:dry-run
pnpm check             # repository release gate
pnpm audit --prod
git diff --check
```

The test suite covers:

- Human and Agent identity isolation;
- draft and published visibility;
- OAuth state and session handling;
- canonical-origin mutation checks;
- payload, graph, page, rate, and quota bounds;
- operation attribution and transaction atomicity;
- optimistic concurrency;
- pagination and manifest compatibility;
- hostile and legacy graph rendering;
- serialized browser writes;
- music generator invariants.

Browser acceptance should cover desktop and mobile, Human and Agent
principals, create/edit/publish/unpublish, fork lineage, operation attribution,
zero unexpected console errors, and zero page-level horizontal overflow.

## Migrate And Deploy

`0001_init.sql` creates loops and operations.

`0002_public_hardening.sql` adds:

- optimistic-concurrency versions and mutation ids;
- principal-aware indexes and operation rows;
- encrypted-token session storage;
- rate-limit counters and cleanup indexes.

Apply a schema migration before deploying code that depends on it.

Production identifiers are not committed. The production renderer accepts only
these protected non-secret build variables:

- `MUSIK_WORKER_NAME`
- `MUSIK_D1_DATABASE_ID`
- `MUSIK_CUSTOM_DOMAIN`
- `MUSIK_RAFT_CLIENT_ID`
- `MUSIK_APP_ORIGIN`

`RAFT_CLIENT_SECRET` and `SESSION_SECRET` are runtime Worker secrets, not build
variables.

The safe release order is:

1. approve and apply pending D1 migrations;
2. read back migration state and critical data counts;
3. provision and verify required Worker secret presence;
4. merge or trigger the reviewed Worker exact;
5. bind the Cloudflare build/deployment to the source revision;
6. run live health, auth, manifest, header, and data readbacks.

Render and deploy manually:

```bash
pnpm render:production-config
pnpm exec wrangler d1 migrations apply DB --remote --config .wrangler.production.toml
pnpm deploy:production
```

Cloudflare Workers Builds uses `main` and `pnpm deploy:production`.
Non-production builds are disabled. Database migrations remain a separate,
explicitly authorized operation.

## Publish To The Raft Marketplace

Code deployment and Marketplace publication are separate gates.

Before requesting review:

1. deploy the exact app revision;
2. verify the callback, homepage, and canonical manifest URLs;
3. run Human and Agent authentication checks;
4. document the app's data access in plain language;
5. choose the Marketplace category;
6. scan the current tree and complete Git history for credentials.

From the app's publisher server, an owner or admin requests Marketplace review
in **Settings -> Connected Apps -> My Apps**. Raft reviews the listing before
changing it from server-local to a globally installable third-party app.

After approval, another server owner or admin can install it from Marketplace.
Agent access remains a separate per-server and per-agent authorization step.
Marketplace publication does not grant credentials or bypass the app's own
authorization checks.

## Repository And Credential Hygiene

Never commit:

- `.dev.vars` or generated production Wrangler config;
- OAuth, session, Cloudflare, Raft, GitHub, or other secrets;
- D1 exports or local database files;
- browser sessions or screenshots containing credentials;
- private deployment configuration or unreviewed personal data.

Scan both the current tree and every reachable commit before making a
repository public or publishing an app. Deleted files remain in Git history.

Third-party attribution is in
[`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md).

## License

[MIT](./LICENSE), Copyright (c) 2026 Botiverse.
