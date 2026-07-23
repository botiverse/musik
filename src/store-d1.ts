/** Cloudflare D1 persistence for musik.build.
 *
 * Every loop mutation and its operation record are submitted in one D1
 * batch. Optimistic concurrency is fenced by loops.version, while a unique
 * mutation id prevents a stale writer from emitting an orphan audit row.
 */

import type { Actor, Graph, Loop, Op } from "../shared/types";
import {
  loopFromRow,
  newId,
  nowIso,
  opFromRow,
  type LoopListOptions,
  type LoopStore,
  type Page,
  type PageCursor,
  type SessionRecord,
} from "./loop-store";

export interface D1Result {
  meta?: { changes?: number };
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<D1Result>;
}

export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  batch<T = D1Result>(statements: D1PreparedStatement[]): Promise<T[]>;
}

function pageFromRows<T>(
  rows: Record<string, unknown>[],
  limit: number,
  map: (row: Record<string, unknown>) => T,
  atColumn: string,
): Page<T> {
  const hasMore = rows.length > limit;
  const visible = hasMore ? rows.slice(0, limit) : rows;
  const tail = visible.at(-1);
  return {
    items: visible.map(map),
    nextCursor:
      hasMore && tail
        ? { at: String(tail[atColumn]), id: String(tail.id) }
        : null,
  };
}

export class D1LoopStore implements LoopStore {
  constructor(private db: D1Database) {}

  async createLoop(title: string, graph: Graph, actor: Actor): Promise<Loop> {
    const loopId = newId();
    const opId = newId();
    const ts = nowIso();
    await this.db.batch([
      this.db
        .prepare(
          "INSERT INTO loops (id,title,author_id,author_kind,author_name," +
            "created_at,updated_at,graph,forked_from,fork_root,published,version,last_mutation_id)" +
            " VALUES (?,?,?,?,?,?,?,?,?,?,0,1,?)",
        )
        .bind(
          loopId,
          title,
          actor.id,
          actor.kind,
          actor.name ?? null,
          ts,
          ts,
          JSON.stringify(graph),
          null,
          loopId,
          opId,
        ),
      this.opStatement(opId, loopId, actor, "create_loop", { title }, ts),
    ]);
    return (await this.getLoop(loopId))!;
  }

  async getLoop(loopId: string): Promise<Loop | null> {
    const row = await this.db
      .prepare("SELECT * FROM loops WHERE id=?")
      .bind(loopId)
      .first();
    return row ? loopFromRow(row) : null;
  }

  async listLoops(options: LoopListOptions): Promise<Page<Loop>> {
    const { publishedOnly, ownerId, ownerKind, limit, cursor } = options;
    const size = limit + 1;
    let statement: D1PreparedStatement;
    if (publishedOnly) {
      statement = cursor
        ? this.db
            .prepare(
              "SELECT * FROM loops WHERE published=1 AND " +
                "(published_at < ? OR (published_at = ? AND id < ?)) " +
                "ORDER BY published_at DESC, id DESC LIMIT ?",
            )
            .bind(cursor.at, cursor.at, cursor.id, size)
        : this.db
            .prepare(
              "SELECT * FROM loops WHERE published=1 " +
                "ORDER BY published_at DESC, id DESC LIMIT ?",
            )
            .bind(size);
    } else {
      if (!ownerId || !ownerKind) {
        throw new Error("ownerId and ownerKind are required for draft listings");
      }
      statement = cursor
        ? this.db
            .prepare(
              "SELECT * FROM loops WHERE author_id=? AND author_kind=? AND " +
                "(updated_at < ? OR (updated_at = ? AND id < ?)) " +
                "ORDER BY updated_at DESC, id DESC LIMIT ?",
            )
            .bind(ownerId, ownerKind, cursor.at, cursor.at, cursor.id, size)
        : this.db
            .prepare(
              "SELECT * FROM loops WHERE author_id=? AND author_kind=? " +
                "ORDER BY updated_at DESC, id DESC LIMIT ?",
            )
            .bind(ownerId, ownerKind, size);
    }
    const { results } = await statement.all();
    return pageFromRows(results, limit, loopFromRow, publishedOnly ? "published_at" : "updated_at");
  }

  async countLoopsByAuthor(authorId: string, authorKind: Actor["kind"]): Promise<number> {
    const row = await this.db
      .prepare("SELECT COUNT(*) AS count FROM loops WHERE author_id=? AND author_kind=?")
      .bind(authorId, authorKind)
      .first<{ count: number }>();
    return Number(row?.count ?? 0);
  }

  async updateGraph(
    loopId: string,
    graph: Graph | null,
    actor: Actor,
    action: string,
    payload: Record<string, any> | null,
    expectedVersion: number,
    title: string | null = null,
  ): Promise<Loop | null> {
    const opId = newId();
    const ts = nowIso();
    const updates = ["updated_at=?", "version=version+1", "last_mutation_id=?"];
    const values: unknown[] = [ts, opId];
    if (graph !== null) {
      updates.push("graph=?");
      values.push(JSON.stringify(graph));
    }
    if (title !== null) {
      updates.push("title=?");
      values.push(title);
    }
    values.push(loopId, expectedVersion);
    const update = this.db
      .prepare(
        `UPDATE loops SET ${updates.join(",")} WHERE id=? AND version=?`,
      )
      .bind(...values);
    const insert = this.db
      .prepare(
        "INSERT INTO ops (id,loop_id,actor_id,actor_kind,actor_name,action,payload,ts) " +
          "SELECT ?,?,?,?,?,?,?,? FROM loops WHERE id=? AND last_mutation_id=?",
      )
      .bind(
        opId,
        loopId,
        actor.id,
        actor.kind,
        actor.name ?? null,
        action,
        payload !== null ? JSON.stringify(payload) : null,
        ts,
        loopId,
        opId,
      );
    await this.db.batch([update, insert]);
    const current = await this.db
      .prepare("SELECT * FROM loops WHERE id=?")
      .bind(loopId)
      .first<Record<string, unknown>>();
    return current?.last_mutation_id === opId ? loopFromRow(current) : null;
  }

  async setPublished(
    loopId: string,
    actor: Actor,
    published: boolean,
    expectedVersion: number,
  ): Promise<Loop | null> {
    const opId = newId();
    const ts = nowIso();
    const update = this.db
      .prepare(
        "UPDATE loops SET published=?, published_at=?, updated_at=?, " +
          "version=version+1, last_mutation_id=? WHERE id=? AND version=?",
      )
      .bind(published ? 1 : 0, published ? ts : null, ts, opId, loopId, expectedVersion);
    const insert = this.db
      .prepare(
        "INSERT INTO ops (id,loop_id,actor_id,actor_kind,actor_name,action,payload,ts) " +
          "SELECT ?,?,?,?,?,?,?,? FROM loops WHERE id=? AND last_mutation_id=?",
      )
      .bind(
        opId,
        loopId,
        actor.id,
        actor.kind,
        actor.name ?? null,
        published ? "publish" : "unpublish",
        null,
        ts,
        loopId,
        opId,
      );
    await this.db.batch([update, insert]);
    const current = await this.db
      .prepare("SELECT * FROM loops WHERE id=?")
      .bind(loopId)
      .first<Record<string, unknown>>();
    return current?.last_mutation_id === opId ? loopFromRow(current) : null;
  }

  async forkLoop(parent: Loop, actor: Actor, title: string | null): Promise<Loop> {
    const loopId = newId();
    const opId = newId();
    const ts = nowIso();
    const forkRoot = parent.forkRoot || parent.id;
    const forkTitle = title || `Fork of ${parent.title}`;
    await this.db.batch([
      this.db
        .prepare(
          "INSERT INTO loops (id,title,author_id,author_kind,author_name," +
            "created_at,updated_at,graph,forked_from,fork_root,published,version,last_mutation_id)" +
            " VALUES (?,?,?,?,?,?,?,?,?,?,0,1,?)",
        )
        .bind(
          loopId,
          forkTitle,
          actor.id,
          actor.kind,
          actor.name ?? null,
          ts,
          ts,
          JSON.stringify(parent.graph),
          parent.id,
          forkRoot,
          opId,
        ),
      this.opStatement(
        opId,
        loopId,
        actor,
        "fork",
        {
          from: parent.id,
          fromTitle: parent.title,
          fromAuthor: parent.authorId,
          fromAuthorName: parent.authorName ?? null,
        },
        ts,
      ),
    ]);
    return (await this.getLoop(loopId))!;
  }

  async listOps(
    loopId: string,
    limit: number,
    cursor?: PageCursor | null,
  ): Promise<Page<Op>> {
    const size = limit + 1;
    const statement = cursor
      ? this.db
          .prepare(
            "SELECT * FROM ops WHERE loop_id=? AND " +
              "(ts > ? OR (ts = ? AND id > ?)) ORDER BY ts ASC, id ASC LIMIT ?",
          )
          .bind(loopId, cursor.at, cursor.at, cursor.id, size)
      : this.db
          .prepare("SELECT * FROM ops WHERE loop_id=? ORDER BY ts ASC, id ASC LIMIT ?")
          .bind(loopId, size);
    const { results } = await statement.all();
    return pageFromRows(results, limit, opFromRow, "ts");
  }

  async recentPublishedOps(
    limit: number,
    cursor?: PageCursor | null,
  ): Promise<Page<Op>> {
    const size = limit + 1;
    const base =
      "SELECT ops.*, loops.title AS loop_title FROM ops " +
      "JOIN loops ON loops.id=ops.loop_id WHERE loops.published=1";
    const statement = cursor
      ? this.db
          .prepare(
            `${base} AND (ops.ts < ? OR (ops.ts = ? AND ops.id < ?)) ` +
              "ORDER BY ops.ts DESC, ops.id DESC LIMIT ?",
          )
          .bind(cursor.at, cursor.at, cursor.id, size)
      : this.db
          .prepare(`${base} ORDER BY ops.ts DESC, ops.id DESC LIMIT ?`)
          .bind(size);
    const { results } = await statement.all();
    return pageFromRows(results, limit, opFromRow, "ts");
  }

  async createSession(record: SessionRecord): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO sessions (id,token_ciphertext,expires_at) VALUES (?,?,?) " +
          "ON CONFLICT(id) DO UPDATE SET token_ciphertext=excluded.token_ciphertext," +
          "expires_at=excluded.expires_at",
      )
      .bind(record.id, record.tokenCiphertext, record.expiresAt)
      .run();
  }

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    const row = await this.db
      .prepare("SELECT id,token_ciphertext,expires_at FROM sessions WHERE id=?")
      .bind(sessionId)
      .first<{ id: string; token_ciphertext: string; expires_at: number }>();
    return row
      ? {
          id: row.id,
          tokenCiphertext: row.token_ciphertext,
          expiresAt: Number(row.expires_at),
        }
      : null;
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.db.prepare("DELETE FROM sessions WHERE id=?").bind(sessionId).run();
  }

  async consumeRateLimit(
    bucket: string,
    subject: string,
    limit: number,
    windowSeconds: number,
    nowSeconds: number,
  ): Promise<boolean> {
    const windowStart = Math.floor(nowSeconds / windowSeconds) * windowSeconds;
    const row = await this.db
      .prepare(
        "INSERT INTO rate_limits (bucket,subject,window_start,count) VALUES (?,?,?,1) " +
          "ON CONFLICT(bucket,subject) DO UPDATE SET " +
          "window_start=CASE WHEN rate_limits.window_start=? THEN rate_limits.window_start ELSE excluded.window_start END," +
          "count=CASE WHEN rate_limits.window_start=? THEN rate_limits.count+1 ELSE 1 END " +
          "RETURNING count",
      )
      .bind(bucket, subject, windowStart, windowStart, windowStart)
      .first<{ count: number }>();
    return Number(row?.count ?? limit + 1) <= limit;
  }

  async pruneSecurityState(nowSeconds: number): Promise<void> {
    await this.db.batch([
      this.db.prepare("DELETE FROM sessions WHERE expires_at<=?").bind(nowSeconds),
      this.db
        .prepare("DELETE FROM rate_limits WHERE window_start<?")
        .bind(nowSeconds - 172800),
    ]);
  }

  private opStatement(
    opId: string,
    loopId: string,
    actor: Actor,
    action: string,
    payload: Record<string, any> | null,
    ts: string,
  ): D1PreparedStatement {
    return this.db
      .prepare(
        "INSERT INTO ops (id,loop_id,actor_id,actor_kind,actor_name," +
          "action,payload,ts) VALUES (?,?,?,?,?,?,?,?)",
      )
      .bind(
        opId,
        loopId,
        actor.id,
        actor.kind,
        actor.name ?? null,
        action,
        payload !== null ? JSON.stringify(payload) : null,
        ts,
      );
  }
}
