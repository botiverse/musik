/** Static file serving for the Bun entrypoint — serves ./public on the same
 *  origin as the API (the CF Worker path uses Workers Static Assets instead).
 *  Bun/node-only: imported dynamically from the import.meta.main entrypoint
 *  in server.ts, never from the worker bundle.
 */

/// <reference path="./runtime-shims.d.ts" />
import { statSync } from "node:fs";
import type { FallbackHandler } from "./server";

/** Create the fallback handler for non-API GET requests. `publicDir` is an
 *  absolute path without a trailing slash. Path handling mirrors the Python
 *  server: the URL path is used verbatim (percent-escapes stay literal),
 *  ".." segments are resolved and then rejected if they escape publicDir. */
export function createStaticHandler(publicDir: string): FallbackHandler {
  const rootUrl = new URL(`file://${publicDir}/`);
  const rootPath = rootUrl.pathname;

  return function serveStatic(_request: Request, pathname: string): Response {
    let p = pathname;
    if (p === "/" || p === "") p = "/index.html";
    // URL resolution collapses ./ and ../ segments like path.resolve does.
    const target = new URL(`.${p}`, rootUrl).pathname;
    let isFile = false;
    if (target.startsWith(rootPath)) {
      try {
        isFile = statSync(target).isFile();
      } catch {
        isFile = false;
      }
    }
    if (!target.startsWith(rootPath) || !isFile) {
      if (p === "/index.html") {
        return new Response("musik.build API up (no frontend bundled yet)\n", {
          status: 200,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }
      return new Response(JSON.stringify({ error: "not found", code: "NOT_FOUND" }), {
        status: 404,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }
    const dot = target.lastIndexOf(".");
    const slash = target.lastIndexOf("/");
    const ext = dot > slash ? target.slice(dot) : "";
    const ctype =
      {
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".png": "image/png",
        ".json": "application/json",
      }[ext] ?? "application/octet-stream";
    const contentType =
      ctype.startsWith("text") || ctype === "application/json"
        ? `${ctype}; charset=utf-8`
        : ctype;
    return new Response((globalThis as any).Bun.file(target), {
      headers: { "Content-Type": contentType },
    });
  };
}
