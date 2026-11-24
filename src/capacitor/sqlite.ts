import type { Database, SqlJsStatic, SqlValue } from "sql.js";

/** The small synchronous SQLite surface used by the existing accounting engine. */
export class WasmDatabase {
  private database: Database;
  isTransaction = false;

  constructor(private readonly SQL: SqlJsStatic, bytes?: Uint8Array) {
    this.database = new SQL.Database(bytes);
    this.database.run("PRAGMA foreign_keys = ON");
  }

  exec(sql: string): void {
    this.database.run(sql);
    if (/\bBEGIN\s+(?:IMMEDIATE|TRANSACTION|DEFERRED|EXCLUSIVE)?\s*;/i.test(sql)) this.isTransaction = true;
    if (/\b(?:COMMIT|ROLLBACK)\s*;/i.test(sql)) this.isTransaction = false;
  }

  prepare(sql: string) {
    const rows = (values: SqlValue[], firstOnly: boolean) => {
      const statement = this.database.prepare(sql);
      try {
        statement.bind(values);
        const result: Record<string, SqlValue>[] = [];
        while (statement.step()) {
          result.push(statement.getAsObject());
          if (firstOnly) break;
        }
        return result;
      } finally {
        statement.free();
      }
    };
    return {
      all: (...values: SqlValue[]) => rows(values, false),
      get: (...values: SqlValue[]) => rows(values, true)[0],
      run: (...values: SqlValue[]) => {
        rows(values, false);
        const changes = this.database.getRowsModified();
        const lastInsertRowid = Number(this.database.exec("SELECT last_insert_rowid()")[0].values[0][0]);
        return { changes, lastInsertRowid };
      },
    };
  }

  export(): Uint8Array {
    if (this.isTransaction) throw new Error("Cannot persist an open transaction.");
    const bytes = this.database.export();
    // sql.js export reopens SQLite and resets connection-local pragmas.
    this.database.run("PRAGMA foreign_keys = ON");
    return bytes;
  }

  replace(bytes: Uint8Array): void {
    const restored = new this.SQL.Database(bytes);
    restored.run("PRAGMA foreign_keys = ON");
    this.database.close();
    this.database = restored;
    this.isTransaction = false;
  }

  close(): void { this.database.close(); }
}

export function encodeBase64(bytes: Uint8Array): string {
  let raw = "";
  for (let i = 0; i < bytes.length; i += 32768) raw += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(raw);
}

export function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), c => c.charCodeAt(0));
}
