/** Cloudflare Worker entry for musik.build.
 *
 * Reuses the exact request handler from src/server.ts (createHandler) with
 * the D1 store; only non-API traffic diverges — it goes to Workers Static
 * Assets (env.ASSETS, the ./public directory) instead of Bun's fs serving.
 *
 * Config comes from env bindings ([vars] + secrets in wrangler.toml), never
 * process.env. DEV_AUTH should stay unset/"0" in production.
 */

import { createHandler, type ServerConfig } from "./server";
import { D1LoopStore } from "./store-d1";

/** Routes owned by the API handler; everything else is static assets. */
const HANDLER_EXACT = new Set([
  "/login",
  "/login/raft/callback",
  "/logout",
  "/.well-known/slock-agent-manifest.json",
]);

export default {
  async fetch(request: Request, env: any, _ctx: any): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (!pathname.startsWith("/api/") && !HANDLER_EXACT.has(pathname)) {
      return env.ASSETS.fetch(request);
    }
    const config: ServerConfig = {
      port: 0, // unused on workers (Host header is always present)
      dbPath: "", // D1 binding replaces the file path
      devAuth: env.DEV_AUTH === "1",
      raftOrigin: env.RAFT_ORIGIN ?? "https://app.raft.build",
      raftApiOrigin: env.RAFT_API_ORIGIN ?? "https://api.raft.build",
      raftClientId: env.RAFT_CLIENT_ID ?? "",
      raftClientSecret: env.RAFT_CLIENT_SECRET ?? "",
      appOrigin: env.APP_ORIGIN ?? "",
    };
    const handler = createHandler(config, new D1LoopStore(env.DB));
    return handler(request);
  },
};
