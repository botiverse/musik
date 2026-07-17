/** Minimal ambient declarations for runtime-specific modules used only on
 *  the Bun entrypoint path (server.ts's import.meta.main block, store.ts,
 *  static-bun.ts), so the worker import graph can be typechecked with plain
 *  tsc and no @types/node / bun-types. Not needed at runtime (Bun provides
 *  the real modules). */

declare module "node:fs" {
  export function statSync(path: string): { isFile(): boolean };
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
}

declare module "bun:sqlite" {
  export class Database {
    constructor(path: string);
    exec(sql: string): void;
    query(sql: string): {
      run(...params: any[]): unknown;
      get(...params: any[]): any;
      all(...params: any[]): any[];
    };
  }
}
