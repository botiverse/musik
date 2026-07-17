/** Cloudflare D1 persistence for musik.build — same SQL and row mapping as
 *  the bun:sqlite store (src/store.ts), over a D1Database binding instead.
 *
 *  No schema exec at runtime: tables/indexes are created by the migrations
 *  in migrations/ (wrangler d1 migrations apply).
 *
 *  The D1 types below are structural minimal interfaces (subset of
 *  @cloudflare/workers-types) so this repo stays zero-dependency and
 *  typechecks without fetching Cloudflare's type package.
 */

import type { Actor, Graph, Loop, Op } from "../shared/types";
import { loopFromRow, newId, nowIso, opFromRow, type LoopStore } from "./loop-store";

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}

export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
}

export class D1LoopStore implements LoopStore {
  constructor(private db: D1Database) {}

  // ---- loops ----

  async createLoop(title: string, graph: Graph, actor: Actor): Promise<Loop> {
    const lid = newId();
    const ts = nowIso();
    await this.db
      .prepare(
        "INSERT INTO loops (id,title,author_id,author_kind,author_name," +
          "created_at,updated_at,graph,forked_from,fork_root,published)" +
          " VALUES (?,?,?,?,?,?,?,?,?,?,0)"
      )
      .bind(lid, title, actor.id, actor.kind, actor.name ?? null, ts, ts,
            JSON.stringify(graph), null, lid)
      .run();
    await this.insertOp(lid, actor, "create_loop", { title });
    return (await this.getLoop(lid))!;
  }

  async getLoop(loopId: string): Promise<Loop | null> {
    const row = await this.db.prepare("SELECT * FROM loops WHERE id=?").bind(loopId).first();
    return row ? loopFromRow(row) : null;
  }

  async listLoops(publishedOnly = false): Promise<Loop[]> {
    const { results } = publishedOnly
      ? await this.db
          .prepare("SELECT * FROM loops WHERE published=1 ORDER BY published_at DESC")
          .all()
      : await this.db.prepare("SELECT * FROM loops ORDER BY created_at DESC").all();
    return results.map(loopFromRow);
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
      await this.db
        .prepare("UPDATE loops SET graph=?, title=?, updated_at=? WHERE id=?")
        .bind(JSON.stringify(graph), title, nowIso(), loopId)
        .run();
    } else if (graph !== null) {
      await this.db
        .prepare("UPDATE loops SET graph=?, updated_at=? WHERE id=?")
        .bind(JSON.stringify(graph), nowIso(), loopId)
        .run();
    } else {
      await this.db
        .prepare("UPDATE loops SET title=?, updated_at=? WHERE id=?")
        .bind(title, nowIso(), loopId)
        .run();
    }
    await this.insertOp(loopId, actor, action, payload);
    return (await this.getLoop(loopId))!;
  }

  async publishLoop(loopId: string, actor: Actor): Promise<Loop> {
    const ts = nowIso();
    await this.db
      .prepare("UPDATE loops SET published=1, published_at=?, updated_at=? WHERE id=?")
      .bind(ts, ts, loopId)
      .run();
    await this.insertOp(loopId, actor, "publish", null);
    return (await this.getLoop(loopId))!;
  }

  async forkLoop(parent: Loop, actor: Actor, title: string | null): Promise<Loop> {
    const lid = newId();
    const ts = nowIso();
    const forkRoot = parent.forkRoot || parent.id;
    const forkTitle = title || `Fork of ${parent.title}`;
    await this.db
      .prepare(
        "INSERT INTO loops (id,title,author_id,author_kind,author_name," +
          "created_at,updated_at,graph,forked_from,fork_root,published)" +
          " VALUES (?,?,?,?,?,?,?,?,?,?,0)"
      )
      .bind(lid, forkTitle, actor.id, actor.kind, actor.name ?? null, ts, ts,
            JSON.stringify(parent.graph), parent.id, forkRoot)
      .run();
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
    await this.db
      .prepare(
        "INSERT INTO ops (id,loop_id,actor_id,actor_kind,actor_name," +
          "action,payload,ts) VALUES (?,?,?,?,?,?,?,?)"
      )
      .bind(oid, loopId, actor.id, actor.kind, actor.name ?? null, action,
            payload !== null ? JSON.stringify(payload) : null, ts)
      .run();
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
    const { results } = await this.db
      .prepare("SELECT * FROM ops WHERE loop_id=? ORDER BY ts ASC, rowid ASC")
      .bind(loopId)
      .all();
    return results.map(opFromRow);
  }

  async recentOps(limit = 20): Promise<Op[]> {
    const { results } = await this.db
      .prepare(
        "SELECT ops.*, loops.title AS loop_title FROM ops" +
          " JOIN loops ON loops.id = ops.loop_id" +
          " ORDER BY ops.ts DESC, ops.rowid DESC LIMIT ?"
      )
      .bind(limit)
      .all();
    return results.map(opFromRow);
  }
}
