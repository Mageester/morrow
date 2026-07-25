import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const MIGRATION_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations", "0001_init.sql");

/**
 * A minimal D1Database-shaped adapter over better-sqlite3, running the real
 * migration file — D1 is SQLite under the hood, so this is a faithful test
 * double rather than a hand-rolled reimplementation of SQL semantics.
 */
export function createFakeD1(): D1Database {
  const db = new Database(":memory:");
  db.exec(readFileSync(MIGRATION_PATH, "utf-8"));

  return {
    prepare(sql: string) {
      const stmt = db.prepare(sql);
      return {
        bind(...args: unknown[]) {
          return {
            first: async <T>() => (stmt.get(...args) as T | undefined) ?? null,
            run: async () => {
              stmt.run(...args);
              return { success: true } as unknown;
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}
