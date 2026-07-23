/** Runtime-neutral store contract and row-mapping helpers.
 *
 * This module stays free of D1-specific types so the handler can use a
 * focused in-memory test implementation.
 */

import type { Actor, Graph, Loop, Op } from "../shared/types";

export interface PageCursor {
  at: string;
  id: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: PageCursor | null;
}

export interface SessionRecord {
  id: string;
  tokenCiphertext: string;
  expiresAt: number;
}

export interface LoopListOptions {
  publishedOnly: boolean;
  ownerId?: string;
  ownerKind?: Actor["kind"];
  limit: number;
  cursor?: PageCursor | null;
}

/** Async persistence interface for loops, operations, and app sessions. */
export interface LoopStore {
  createLoop(title: string, graph: Graph, actor: Actor): Promise<Loop>;
  getLoop(loopId: string): Promise<Loop | null>;
  listLoops(options: LoopListOptions): Promise<Page<Loop>>;
  countLoopsByAuthor(authorId: string, authorKind: Actor["kind"]): Promise<number>;
  updateGraph(
    loopId: string,
    graph: Graph | null,
    actor: Actor,
    action: string,
    payload: Record<string, any> | null,
    expectedVersion: number,
    title?: string | null
  ): Promise<Loop | null>;
  setPublished(
    loopId: string,
    actor: Actor,
    published: boolean,
    expectedVersion: number
  ): Promise<Loop | null>;
  forkLoop(parent: Loop, actor: Actor, title: string | null): Promise<Loop>;
  listOps(loopId: string, limit: number, cursor?: PageCursor | null): Promise<Page<Op>>;
  recentPublishedOps(limit: number, cursor?: PageCursor | null): Promise<Page<Op>>;
  createSession(record: SessionRecord): Promise<void>;
  getSession(sessionId: string): Promise<SessionRecord | null>;
  deleteSession(sessionId: string): Promise<void>;
  consumeRateLimit(
    bucket: string,
    subject: string,
    limit: number,
    windowSeconds: number,
    nowSeconds: number
  ): Promise<boolean>;
  pruneSecurityState(nowSeconds: number): Promise<void>;
}

/** ISO-8601 UTC with milliseconds (for example 2026-07-17T09:48:54.384+00:00). */
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
    version: Number(row.version ?? 1),
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
