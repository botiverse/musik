/** Runtime-neutral store contract + helpers shared by the bun:sqlite store
 *  (src/store.ts) and the Cloudflare D1 store (src/store-d1.ts).
 *
 *  This module must stay free of runtime-specific imports (no bun:sqlite,
 *  no node:*, no D1 types) so both store implementations and the Worker
 *  entry can import it.
 */

import type { Actor, Graph, Loop, Op } from "../shared/types";

/** Async persistence interface for loops and the operation log.
 *  Implementations: Store (bun:sqlite, sync driver under async signatures)
 *  and D1LoopStore (Cloudflare D1). */
export interface LoopStore {
  createLoop(title: string, graph: Graph, actor: Actor): Promise<Loop>;
  getLoop(loopId: string): Promise<Loop | null>;
  listLoops(publishedOnly?: boolean): Promise<Loop[]>;
  updateGraph(
    loopId: string,
    graph: Graph | null,
    actor: Actor,
    action: string,
    payload: Record<string, any> | null,
    title?: string | null
  ): Promise<Loop>;
  publishLoop(loopId: string, actor: Actor): Promise<Loop>;
  forkLoop(parent: Loop, actor: Actor, title: string | null): Promise<Loop>;
  insertOp(
    loopId: string,
    actor: Actor,
    action: string,
    payload: Record<string, any> | null
  ): Promise<Op>;
  listOps(loopId: string): Promise<Op[]>;
  recentOps(limit?: number): Promise<Op[]>;
}

/** ISO-8601 UTC with milliseconds, in the same shape as Python's
 *  datetime.now(timezone.utc).isoformat(timespec="milliseconds")
 *  (e.g. 2026-07-17T09:48:54.384+00:00). */
export function nowIso(): string {
  return new Date().toISOString().replace("Z", "+00:00");
}

/** 32-hex uuid, no dashes (same as uuid4().hex). */
export function newId(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

/** Map a loops-table row (snake_case columns) to the wire Loop shape. */
export function loopFromRow(row: any): Loop {
  return {
    id: row.id,
    title: row.title,
    authorId: row.author_id,
    authorKind: row.author_kind,
    authorName: row.author_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    graph: JSON.parse(row.graph),
    forkedFrom: row.forked_from,
    forkRoot: row.fork_root,
    published: !!row.published,
    publishedAt: row.published_at,
  };
}

/** Map an ops-table row to the wire Op shape. Rows from recentOps carry a
 *  joined loop_title column; per-loop listings expose loopTitle: null. */
export function opFromRow(row: any): Op {
  return {
    id: row.id,
    loopId: row.loop_id,
    loopTitle: "loop_title" in row ? row.loop_title : null,
    actorId: row.actor_id,
    actorKind: row.actor_kind,
    actorName: row.actor_name,
    action: row.action,
    payload: row.payload ? JSON.parse(row.payload) : null,
    ts: row.ts,
  };
}
