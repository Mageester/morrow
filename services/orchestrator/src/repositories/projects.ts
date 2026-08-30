import type Database from "better-sqlite3";
import { ProjectSchema, type Project } from "@morrow/contracts";

type Input = {
  id: string;
  name: string;
  workspacePath: string;
  createdAt: string;
  updatedAt?: string;
};

type RawProject = {
  id: string;
  schema_version: number;
  name: string;
  workspace_path: string;
  created_at: string;
  updated_at: string;
};

const map = (row: unknown): Project => {
  const x = row as Record<string, unknown>;
  return ProjectSchema.parse({
    version: x.schema_version,
    id: x.id,
    name: x.name,
    workspacePath: x.workspace_path,
    createdAt: x.created_at,
  });
};

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function tablesWithProjectId(db: Database.Database): string[] {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  return tables
    .filter(({ name }) => name !== "projects")
    .filter(({ name }) => {
      const table = quoteIdentifier(name);
      return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
        .some((column) => column.name === "project_id");
    })
    .map(({ name }) => name);
}

/**
 * Merge legacy project rows that name the same workspace. The oldest project
 * remains authoritative; all project-scoped rows are reparented before the
 * duplicate is removed, so ON DELETE CASCADE cannot erase task history.
 *
 * This function is also used by a database migration. `better-sqlite3` does
 * not allow a nested transaction, so it participates in the caller's
 * transaction when one is already active.
 */
export function reconcileProjectWorkspaceDuplicates(db: Database.Database): { merged: number } {
  const run = () => {
    const rows = db
      .prepare("SELECT * FROM projects ORDER BY workspace_path ASC, created_at ASC, id ASC")
      .all() as RawProject[];
    const groups = new Map<string, RawProject[]>();
    for (const row of rows) {
      const group = groups.get(row.workspace_path) ?? [];
      group.push(row);
      groups.set(row.workspace_path, group);
    }

    const scopedTables = tablesWithProjectId(db);
    const reparent = new Map(
      scopedTables.map((table) => [
        table,
        db.prepare(`UPDATE ${quoteIdentifier(table)} SET project_id = ? WHERE project_id = ?`),
      ]),
    );
    const remove = db.prepare("DELETE FROM projects WHERE id = ?");
    let merged = 0;

    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const keeper = group[0]!;
      for (const duplicate of group.slice(1)) {
        for (const statement of reparent.values()) statement.run(keeper.id, duplicate.id);
        remove.run(duplicate.id);
        merged++;
      }
    }
    return { merged };
  };

  return db.inTransaction ? run() : db.transaction(run)();
}

export function projectRepository(db: Database.Database) {
  const create = db.prepare(
    "INSERT INTO projects(id,schema_version,name,workspace_path,created_at,updated_at) VALUES(@id,1,@name,@workspacePath,@createdAt,@updatedAt)",
  );
  const get = db.prepare("SELECT * FROM projects WHERE id=?");
  const getByWorkspacePath = db.prepare(
    "SELECT * FROM projects WHERE workspace_path=? ORDER BY created_at ASC,id ASC LIMIT 1",
  );
  const list = db.prepare("SELECT * FROM projects ORDER BY created_at ASC,id ASC");
  const del = db.prepare("DELETE FROM projects WHERE id=?");

  return {
    createProject(input: Input) {
      // The API canonicalizes existing directories before this boundary. Keep
      // the lookup here so every caller, including startup helpers, gets
      // idempotent registration without relying on the HTTP route.
      const existing = getByWorkspacePath.get(input.workspacePath);
      if (existing) return map(existing);
      const updatedAt = input.updatedAt ?? input.createdAt;
      create.run({ ...input, updatedAt });
      return this.getProjectById(input.id)!;
    },
    getProjectById(id: string) {
      const row = get.get(id);
      return row ? map(row) : undefined;
    },
    listProjects() {
      return list.all().map(map);
    },
    deleteProject(id: string) {
      del.run(id);
    },
  };
}
