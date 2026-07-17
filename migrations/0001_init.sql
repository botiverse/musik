-- musik.build D1 schema — identical to the SCHEMA constant in src/store.ts
-- (and store.py). Applied via `wrangler d1 migrations apply musik`.

CREATE TABLE IF NOT EXISTS loops (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  author_id    TEXT NOT NULL,
  author_kind  TEXT NOT NULL CHECK (author_kind IN ('human','agent')),
  author_name  TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  graph        TEXT NOT NULL,
  forked_from  TEXT,
  fork_root    TEXT NOT NULL,
  published    INTEGER NOT NULL DEFAULT 0,
  published_at TEXT
);
CREATE TABLE IF NOT EXISTS ops (
  id         TEXT PRIMARY KEY,
  loop_id    TEXT NOT NULL,
  actor_id   TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human','agent')),
  actor_name TEXT,
  action     TEXT NOT NULL,
  payload    TEXT,
  ts         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ops_loop ON ops(loop_id, ts);
CREATE INDEX IF NOT EXISTS idx_ops_ts   ON ops(ts);
CREATE INDEX IF NOT EXISTS idx_loops_pub ON loops(published, published_at);
