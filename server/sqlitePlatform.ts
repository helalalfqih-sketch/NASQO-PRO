// Platform boundary. The Capacitor build substitutes its local SQLite adapter.
export { default as crypto } from "node:crypto";
export { default as fs } from "node:fs";
export { default as os } from "node:os";
export { default as path } from "node:path";
export { DatabaseSync, backup as sqliteBackup } from "node:sqlite";
export const runtime = process;
