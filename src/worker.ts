/** Cloudflare Worker entry for musik.build. */

import { createHandler, type ServerConfig } from "./server";
import { D1LoopStore } from "./store-d1";

export default {
  async fetch(request: Request, env: any): Promise<Response> {
    const config: ServerConfig = {
      devAuth: env.DEV_AUTH === "1",
      raftOrigin: env.RAFT_ORIGIN ?? "https://app.raft.build",
      raftApiOrigin: env.RAFT_API_ORIGIN ?? "https://api.raft.build",
      raftClientId: env.RAFT_CLIENT_ID ?? "",
      raftClientSecret: env.RAFT_CLIENT_SECRET ?? "",
      sessionSecret: env.SESSION_SECRET ?? "",
      appOrigin: env.APP_ORIGIN ?? "",
    };
    const handler = createHandler(
      config,
      new D1LoopStore(env.DB),
      (assetRequest) => env.ASSETS.fetch(assetRequest),
    );
    return handler(request);
  },
};
