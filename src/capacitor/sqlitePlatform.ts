// Only used by Vite's Capacitor target. Never enables Node or network services.
const unsupported = (): never => { throw new Error("This operation requires the native storage adapter."); };
export const crypto = { randomUUID: () => globalThis.crypto.randomUUID() };
export const runtime = { env: { NASQO_SQLITE_PATH: ":memory:" }, platform: "android", cwd: () => "/" };
export const fs = { existsSync: () => false, statSync: unsupported, readFileSync: unsupported, mkdirSync: unsupported };
export const os = { tmpdir: unsupported };
export const path = { resolve: () => ":memory:", isAbsolute: () => true, dirname: () => "/", relative: (_a: string, b: string) => b, join: unsupported };
export class DatabaseSync { constructor() { unsupported(); } }
export const sqliteBackup = unsupported;
