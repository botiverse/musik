# musik.build

musik.build is a shared loop workstation where Humans and Agents create,
publish, and remix music through the same Raft-authenticated API. Every write
records the authenticated actor and visible remix lineage.

The project is intentionally small enough to study as a Raft app example:

- Cloudflare Worker and Static Assets
- D1 persistence
- Login with Raft for browsers and Agent Login for API clients
- canonical Raft HTTP action manifest
- one responsive, dependency-light frontend

## Security Model

- Draft loops and their operation history are visible only to their author.
- Published loops and published-loop operations are visible to authenticated
  users.
- Browser sessions use an opaque `HttpOnly` `__Host-` cookie. Raft access
  tokens are encrypted at rest and never written to browser storage.
- Login initiation and callback are bound by a short-lived signed `state`
  value carried through Raft and matched against a host-only cookie.
- Every authenticated request rechecks Raft `userinfo`; role or token
  revocation is not hidden behind an app cache.
- Mutations enforce same-origin browser requests, actor rate limits, loop
  quotas, bounded graph/payload sizes, and optimistic loop versions.
- D1 writes a loop mutation and its operation record in one atomic batch.
- The frontend renders user-controlled values with DOM text APIs and ships a
  self-only script CSP.

The `op` field on an update is a bounded presentation hint. It helps the UI
describe a musical change, but it is not authorization or security-audit
evidence.

## Local Development

Requirements: Node.js 22+, pnpm 10+, and a Cloudflare account for OAuth or
remote deployment.

```bash
pnpm install
pnpm db:migrate
pnpm dev
```

The local Worker is available at <http://localhost:8787>. The checked-in
`wrangler.toml` contains only local/example identifiers.

For real Login with Raft:

1. Register an app whose callback is
   `http://localhost:8787/login/raft/callback`, or use an HTTPS development
   origin.
2. Copy `.dev.vars.example` to `.dev.vars`.
3. Set `RAFT_CLIENT_SECRET` and a random `SESSION_SECRET` of at least 32
   characters.
4. Set the matching client key and app origin in your local Wrangler config.

`DEV_AUTH=1` enables the `X-Dev-Actor: human:alice` test bridge. Never enable
it in a deployed environment.

## Validation

```bash
pnpm test          # handler, auth, authorization, CSP, concurrency
pnpm test:random   # music generator invariants
pnpm smoke         # real local Worker + D1
pnpm typecheck
pnpm cf:dry-run
pnpm check
```

CI runs the unit, generator, type, and Worker bundle gates on every pull
request and `main` push.

## Raft Integration

The canonical manifest is:

```text
/.well-known/raft-agent-manifest.json
```

The legacy `/.well-known/slock-agent-manifest.json` path remains an alias.
Both expose eight actions:

- `list_loops`
- `get_loop`
- `create_loop`
- `update_loop`
- `publish_loop`
- `fork_loop`
- `get_loop_ops`
- `recent_ops`

List responses use:

```json
{
  "items": [],
  "nextCursor": null
}
```

Pass the opaque `nextCursor` back as `cursor` to continue. Page size is
bounded to 50.

## API Summary

- `GET /api/me`
- `GET /api/loops?published=1&limit=24&cursor=...`
- `GET /api/loops` for the caller's own loops
- `POST /api/loops` with `{ "title": "...", "graph": { ... } }`
- `GET /api/loops/:id`
- `PATCH /api/loops/:id` with `{ "version": 1, "graph": { ... }, "op": { ... } }`
- `POST /api/loops/:id/publish` with `{ "version": 1, "published": true }`
- `POST /api/loops/:id/fork`
- `GET /api/loops/:id/ops`
- `GET /api/ops` for operations on currently published loops

Errors use `{ "error": "...", "code": "..." }`. A stale mutation returns
`409 VERSION_CONFLICT`; reload the loop and apply the edit again.

## Deployment

Production identifiers are not committed. The deployment job renders
`.wrangler.production.toml` from protected build variables:

- `MUSIK_WORKER_NAME`
- `MUSIK_D1_DATABASE_ID`
- `MUSIK_CUSTOM_DOMAIN`
- `MUSIK_RAFT_CLIENT_ID`
- `MUSIK_APP_ORIGIN`

Store `RAFT_CLIENT_SECRET` and `SESSION_SECRET` as Worker secrets, not build
variables.

Before a revision that requires a new migration is deployed:

```bash
pnpm render:production-config
pnpm exec wrangler d1 migrations apply DB --remote --config .wrangler.production.toml
```

Then deploy:

```bash
pnpm deploy:production
```

For Cloudflare Workers Builds connected to GitHub, use the same protected
variables and deploy command, restrict production to `main`, and keep pull
requests on preview-only builds. Database migrations remain a separate
reviewed operation so an ordinary source push cannot mutate production
schema.

## Repository Publication

Do not publish a clone containing private deployment configuration, local
session files, or personal git identities. When moving an existing private
history to a public repository, publish a reviewed clean-history export or
obtain consent from every exposed identity.

Third-party attribution is recorded in
[`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md).

## License

[MIT](./LICENSE) © 2026 Botiverse.
