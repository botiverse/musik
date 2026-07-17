/** SQLite persistence for musik.build loops and operation log (bun:sqlite).
 *
 * Port of store.py — same schema, same queries. The store is intentionally
 * dumb about graph internals — graph is stored as opaque JSON.
 *
 * Display names (authorName / actorName) are snapshots taken at write time
 * so feeds and the activity ticker render without extra lookups.
 *
 * One deliberate addition vs the Python SQL: `rowid` tiebreakers in the ops
 * ORDER BY clauses. Python's `ORDER BY ts` alone leaves same-millisecond
 * ops in unspecified order; the tiebreaker makes the (already implicit)
 * insertion order deterministic.
 *
 * Methods are async to satisfy LoopStore (shared with the D1 store); the
 * bun:sqlite driver underneath stays synchronous.
 */

import { Database } from "bun:sqlite";
import type { Actor, Graph, Loop, Op } from "../shared/types";
import { loopFromRow, newId, nowIso, opFromRow, type LoopStore } from "./loop-store";

const SCHEMA = `
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
`;

export class Store implements LoopStore {
  private db: Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.exec(SCHEMA);
  }

  // ---- loops ----

  async createLoop(title: string, graph: Graph, actor: Actor): Promise<Loop> {
    const lid = newId();
    const ts = nowIso();
    this.db
      .query(
        "INSERT INTO loops (id,title,author_id,author_kind,author_name," +
          "created_at,updated_at,graph,forked_from,fork_root,published)" +
          " VALUES (?,?,?,?,?,?,?,?,?,?,0)"
      )
      .run(lid, title, actor.id, actor.kind, actor.name ?? null, ts, ts,
           JSON.stringify(graph), null, lid);
    await this.insertOp(lid, actor, "create_loop", { title });
    return (await this.getLoop(lid))!;
  }

  async getLoop(loopId: string): Promise<Loop | null> {
    const row = this.db.query("SELECT * FROM loops WHERE id=?").get(loopId);
    return row ? loopFromRow(row) : null;
  }

  async listLoops(publishedOnly = false): Promise<Loop[]> {
    const rows = publishedOnly
      ? this.db
          .query("SELECT * FROM loops WHERE published=1 ORDER BY published_at DESC")
          .all()
      : this.db.query("SELECT * FROM loops ORDER BY created_at DESC").all();
    return rows.map(loopFromRow);
  }

  async updateGraph(
    loopId: string,
    graph: Graph | null,
    actor: Actor,
    action: string,
    payload: Record<string, any> | null,
    title: string | null = null
  ): Promise<Loop> {
    if (graph !== null && title !== null) {
      this.db
        .query("UPDATE loops SET graph=?, title=?, updated_at=? WHERE id=?")
        .run(JSON.stringify(graph), title, nowIso(), loopId);
    } else if (graph !== null) {
      this.db
        .query("UPDATE loops SET graph=?, updated_at=? WHERE id=?")
        .run(JSON.stringify(graph), nowIso(), loopId);
    } else {
      this.db
        .query("UPDATE loops SET title=?, updated_at=? WHERE id=?")
        .run(title, nowIso(), loopId);
    }
    await this.insertOp(loopId, actor, action, payload);
    return (await this.getLoop(loopId))!;
  }

  async publishLoop(loopId: string, actor: Actor): Promise<Loop> {
    const ts = nowIso();
    this.db
      .query("UPDATE loops SET published=1, published_at=?, updated_at=? WHERE id=?")
      .run(ts, ts, loopId);
    await this.insertOp(loopId, actor, "publish", null);
    return (await this.getLoop(loopId))!;
  }

  async forkLoop(parent: Loop, actor: Actor, title: string | null): Promise<Loop> {
    const lid = newId();
    const ts = nowIso();
    const forkRoot = parent.forkRoot || parent.id;
    const forkTitle = title || `Fork of ${parent.title}`;
    this.db
      .query(
        "INSERT INTO loops (id,title,author_id,author_kind,author_name," +
          "created_at,updated_at,graph,forked_from,fork_root,published)" +
          " VALUES (?,?,?,?,?,?,?,?,?,?,0)"
      )
      .run(lid, forkTitle, actor.id, actor.kind, actor.name ?? null, ts, ts,
           JSON.stringify(parent.graph), parent.id, forkRoot);
    await this.insertOp(lid, actor, "fork", {
      from: parent.id,
      fromTitle: parent.title,
      fromAuthor: parent.authorId,
      fromAuthorName: parent.authorName ?? null,
    });
    return (await this.getLoop(lid))!;
  }

  // ---- ops ----

  async insertOp(
    loopId: string,
    actor: Actor,
    action: string,
    payload: Record<string, any> | null
  ): Promise<Op> {
    const oid = newId();
    const ts = nowIso();
    this.db
      .query(
        "INSERT INTO ops (id,loop_id,actor_id,actor_kind,actor_name," +
          "action,payload,ts) VALUES (?,?,?,?,?,?,?,?)"
      )
      .run(oid, loopId, actor.id, actor.kind, actor.name ?? null, action,
           payload !== null ? JSON.stringify(payload) : null, ts);
    return {
      id: oid,
      loopId,
      actorId: actor.id,
      actorKind: actor.kind,
      actorName: actor.name ?? null,
      action,
      payload,
      ts,
    };
  }

  async listOps(loopId: string): Promise<Op[]> {
    const rows = this.db
      .query("SELECT * FROM ops WHERE loop_id=? ORDER BY ts ASC, rowid ASC")
      .all(loopId);
    return rows.map(opFromRow);
  }

  async recentOps(limit = 20): Promise<Op[]> {
    const rows = this.db
      .query(
        "SELECT ops.*, loops.title AS loop_title FROM ops" +
          " JOIN loops ON loops.id = ops.loop_id" +
          " ORDER BY ops.ts DESC, ops.rowid DESC LIMIT ?"
      )
      .all(limit);
    return rows.map(opFromRow);
  }
}
