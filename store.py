"""SQLite persistence for musik.build loops and operation log.

Stdlib only. Single connection guarded by a lock; writes are serialized.
The store is intentionally dumb about graph internals — graph is stored
as opaque JSON. Graph semantics belong to the frontend / agents.

Display names (author_name / actor_name) are snapshots taken at write
time so feeds and the activity ticker render without extra lookups.
"""

import json
import sqlite3
import threading
import uuid
from datetime import datetime, timezone

SCHEMA = """
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
"""


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def new_id() -> str:
    return uuid.uuid4().hex


def _loop_from_row(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "title": row["title"],
        "authorId": row["author_id"],
        "authorKind": row["author_kind"],
        "authorName": row["author_name"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
        "graph": json.loads(row["graph"]),
        "forkedFrom": row["forked_from"],
        "forkRoot": row["fork_root"],
        "published": bool(row["published"]),
        "publishedAt": row["published_at"],
    }


def _op_from_row(row: sqlite3.Row) -> dict:
    keys = row.keys()
    return {
        "id": row["id"],
        "loopId": row["loop_id"],
        "loopTitle": row["loop_title"] if "loop_title" in keys else None,
        "actorId": row["actor_id"],
        "actorKind": row["actor_kind"],
        "actorName": row["actor_name"],
        "action": row["action"],
        "payload": json.loads(row["payload"]) if row["payload"] else None,
        "ts": row["ts"],
    }


class Store:
    def __init__(self, path: str):
        self._lock = threading.Lock()
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        with self._lock, self.db:
            self.db.executescript(SCHEMA)

    # ---- loops ----

    def create_loop(self, title: str, graph: dict, actor: dict) -> dict:
        lid = new_id()
        ts = now_iso()
        with self._lock, self.db:
            self.db.execute(
                "INSERT INTO loops (id,title,author_id,author_kind,author_name,"
                "created_at,updated_at,graph,forked_from,fork_root,published)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,0)",
                (lid, title, actor["id"], actor["kind"], actor.get("name"),
                 ts, ts, json.dumps(graph), None, lid),
            )
        self.insert_op(lid, actor, "create_loop", {"title": title})
        return self.get_loop(lid)

    def get_loop(self, loop_id: str) -> dict | None:
        with self._lock:
            row = self.db.execute("SELECT * FROM loops WHERE id=?", (loop_id,)).fetchone()
        return _loop_from_row(row) if row else None

    def list_loops(self, published_only: bool = False) -> list:
        with self._lock:
            if published_only:
                rows = self.db.execute(
                    "SELECT * FROM loops WHERE published=1 ORDER BY published_at DESC"
                ).fetchall()
            else:
                rows = self.db.execute("SELECT * FROM loops ORDER BY created_at DESC").fetchall()
        return [_loop_from_row(r) for r in rows]

    def update_graph(self, loop_id: str, graph: dict, actor: dict,
                     action: str, payload: dict | None) -> dict:
        with self._lock, self.db:
            self.db.execute(
                "UPDATE loops SET graph=?, updated_at=? WHERE id=?",
                (json.dumps(graph), now_iso(), loop_id),
            )
        self.insert_op(loop_id, actor, action, payload)
        return self.get_loop(loop_id)

    def publish_loop(self, loop_id: str, actor: dict) -> dict:
        ts = now_iso()
        with self._lock, self.db:
            self.db.execute(
                "UPDATE loops SET published=1, published_at=?, updated_at=? WHERE id=?",
                (ts, ts, loop_id),
            )
        self.insert_op(loop_id, actor, "publish", None)
        return self.get_loop(loop_id)

    def fork_loop(self, parent: dict, actor: dict, title: str | None) -> dict:
        lid = new_id()
        ts = now_iso()
        fork_root = parent["forkRoot"] or parent["id"]
        fork_title = title or f"Fork of {parent['title']}"
        with self._lock, self.db:
            self.db.execute(
                "INSERT INTO loops (id,title,author_id,author_kind,author_name,"
                "created_at,updated_at,graph,forked_from,fork_root,published)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,0)",
                (lid, fork_title, actor["id"], actor["kind"], actor.get("name"),
                 ts, ts, json.dumps(parent["graph"]), parent["id"], fork_root),
            )
        self.insert_op(lid, actor, "fork", {
            "from": parent["id"],
            "fromTitle": parent["title"],
            "fromAuthor": parent["authorId"],
            "fromAuthorName": parent.get("authorName"),
        })
        return self.get_loop(lid)

    # ---- ops ----

    def insert_op(self, loop_id: str, actor: dict, action: str,
                  payload: dict | None) -> dict:
        oid = new_id()
        ts = now_iso()
        with self._lock, self.db:
            self.db.execute(
                "INSERT INTO ops (id,loop_id,actor_id,actor_kind,actor_name,"
                "action,payload,ts) VALUES (?,?,?,?,?,?,?,?)",
                (oid, loop_id, actor["id"], actor["kind"], actor.get("name"),
                 action, json.dumps(payload) if payload is not None else None, ts),
            )
        return {
            "id": oid, "loopId": loop_id, "actorId": actor["id"],
            "actorKind": actor["kind"], "actorName": actor.get("name"),
            "action": action, "payload": payload, "ts": ts,
        }

    def list_ops(self, loop_id: str) -> list:
        with self._lock:
            rows = self.db.execute(
                "SELECT * FROM ops WHERE loop_id=? ORDER BY ts ASC", (loop_id,)
            ).fetchall()
        return [_op_from_row(r) for r in rows]

    def recent_ops(self, limit: int = 20) -> list:
        with self._lock:
            rows = self.db.execute(
                "SELECT ops.*, loops.title AS loop_title FROM ops"
                " JOIN loops ON loops.id = ops.loop_id"
                " ORDER BY ops.ts DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [_op_from_row(r) for r in rows]
