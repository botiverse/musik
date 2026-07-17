/** Shared contract types for musik.build — imported by the backend (src/)
 *  and later by the frontend. Field names match the wire format exactly
 *  (camelCase JSON), which mirrors the Python reference implementation.
 */

export type ActorKind = "human" | "agent";

/** Authenticated identity. `handle` is only present for Raft-resolved
 *  actors; dev actors (X-Dev-Actor) omit it. */
export interface Actor {
  id: string;
  kind: ActorKind;
  name: string | null;
  handle?: string | null;
  picture: string | null;
}

/** Loop graph. Semantics are opaque to the backend; only the presence of
 *  nodes[] and edges[] arrays is validated. */
export interface Graph {
  nodes: any[];
  edges: any[];
  startId?: string;
  [k: string]: any;
}

export interface Loop {
  id: string; // 32-hex uuid, no dashes
  title: string;
  authorId: string;
  authorKind: ActorKind;
  authorName: string | null;
  createdAt: string; // ISO-8601 UTC, milliseconds
  updatedAt: string;
  graph: Graph;
  forkedFrom: string | null;
  forkRoot: string;
  published: boolean;
  publishedAt: string | null;
}

export interface Op {
  id: string;
  loopId: string;
  /** Only set by GET /api/ops (join); null in per-loop op listings. */
  loopTitle?: string | null;
  actorId: string;
  actorKind: ActorKind;
  actorName: string | null;
  action: string;
  payload: Record<string, any> | null;
  ts: string; // ISO-8601 UTC, milliseconds
}

/** Error body shape for all non-2xx API responses. */
export interface ApiError {
  error: string;
  code: string; // UNAUTHORIZED | FORBIDDEN | NOT_FOUND | BAD_JSON | BAD_GRAPH | BAD_REQUEST
}
