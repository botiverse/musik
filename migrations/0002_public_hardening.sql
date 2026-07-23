ALTER TABLE loops ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE loops ADD COLUMN last_mutation_id TEXT;

CREATE INDEX IF NOT EXISTS idx_loops_author_updated
  ON loops(author_id, author_kind, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_loops_published_page
  ON loops(published, published_at DESC, id DESC);

CREATE TABLE ops_hardened (
  id         TEXT PRIMARY KEY,
  loop_id    TEXT NOT NULL REFERENCES loops(id) ON DELETE CASCADE,
  actor_id   TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human','agent')),
  actor_name TEXT,
  action     TEXT NOT NULL,
  payload    TEXT,
  ts         TEXT NOT NULL
);

INSERT INTO ops_hardened (id,loop_id,actor_id,actor_kind,actor_name,action,payload,ts)
SELECT id,loop_id,actor_id,actor_kind,actor_name,action,payload,ts FROM ops;

DROP TABLE ops;
ALTER TABLE ops_hardened RENAME TO ops;
CREATE INDEX idx_ops_loop ON ops(loop_id, ts, id);
CREATE INDEX idx_ops_ts ON ops(ts, id);

CREATE TABLE sessions (
  id               TEXT PRIMARY KEY,
  token_ciphertext TEXT NOT NULL,
  expires_at       INTEGER NOT NULL
);
CREATE INDEX idx_sessions_expiry ON sessions(expires_at);

CREATE TABLE rate_limits (
  bucket       TEXT NOT NULL,
  subject      TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL,
  PRIMARY KEY (bucket, subject)
);
CREATE INDEX idx_rate_limits_window ON rate_limits(window_start);
