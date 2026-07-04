import type Database from "better-sqlite3";

export type SymbolKind =
  | "function"
  | "class"
  | "method"
  | "interface"
  | "type"
  | "variable"
  | "enum"
  | "json-property";

export type SymbolRecord = {
  id: string;
  projectId: string;
  filePath: string;
  language: string;
  fileFingerprint: string;
  name: string;
  fqName: string;
  kind: SymbolKind;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  parentName: string | null;
  exported: boolean;
  indexedAt: string;
  indexerVersion: string;
  parserVersion: string;
};

export type SymbolDiagnostic = {
  filePath: string;
  line: number;
  column: number;
  code: string;
  message: string;
};

export type IndexedFileRecord = {
  projectId: string;
  filePath: string;
  language: string;
  fileFingerprint: string;
  status: "indexed" | "diagnostic";
  diagnostics: SymbolDiagnostic[];
  indexedAt: string;
  indexerVersion: string;
  parserVersion: string;
};

export type SymbolIndexStatus = {
  projectId: string;
  fileCount: number;
  symbolCount: number;
  diagnosticCount: number;
  latestIndexedAt: string | null;
  indexerVersion: string | null;
  parserVersion: string | null;
};

export type ReplaceFileInput = Omit<IndexedFileRecord, "projectId"> & {
  projectId: string;
  symbols: Array<Omit<SymbolRecord, "id" | "projectId" | "indexedAt" | "indexerVersion" | "parserVersion" | "fileFingerprint" | "language">>;
};

const mapSymbol = (row: any): SymbolRecord => ({
  id: row.id,
  projectId: row.project_id,
  filePath: row.file_path,
  language: row.language,
  fileFingerprint: row.file_fingerprint,
  name: row.name,
  fqName: row.fq_name,
  kind: row.kind,
  startLine: Number(row.start_line),
  startColumn: Number(row.start_column),
  endLine: Number(row.end_line),
  endColumn: Number(row.end_column),
  parentName: row.parent_name ?? null,
  exported: Number(row.exported) !== 0,
  indexedAt: row.indexed_at,
  indexerVersion: row.indexer_version,
  parserVersion: row.parser_version,
});

const parseDiagnostics = (json: string): SymbolDiagnostic[] => {
  try {
    const value = JSON.parse(json);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
};

const mapFile = (row: any): IndexedFileRecord => ({
  projectId: row.project_id,
  filePath: row.file_path,
  language: row.language,
  fileFingerprint: row.file_fingerprint,
  status: row.status,
  diagnostics: parseDiagnostics(row.diagnostics_json),
  indexedAt: row.indexed_at,
  indexerVersion: row.indexer_version,
  parserVersion: row.parser_version,
});

export function symbolIndexRepository(db: Database.Database) {
  const insertFile = db.prepare(`
    INSERT INTO symbol_index_files(project_id,file_path,language,file_fingerprint,status,diagnostics_json,indexed_at,indexer_version,parser_version)
    VALUES(@projectId,@filePath,@language,@fileFingerprint,@status,@diagnosticsJson,@indexedAt,@indexerVersion,@parserVersion)
    ON CONFLICT(project_id,file_path) DO UPDATE SET
      language=excluded.language,
      file_fingerprint=excluded.file_fingerprint,
      status=excluded.status,
      diagnostics_json=excluded.diagnostics_json,
      indexed_at=excluded.indexed_at,
      indexer_version=excluded.indexer_version,
      parser_version=excluded.parser_version
  `);
  const deleteSymbolsForFile = db.prepare("DELETE FROM symbols WHERE project_id=? AND file_path=?");
  const insertSymbol = db.prepare(`
    INSERT INTO symbols(id,project_id,file_path,language,file_fingerprint,name,fq_name,kind,start_line,start_column,end_line,end_column,parent_name,exported,indexed_at,indexer_version,parser_version)
    VALUES(@id,@projectId,@filePath,@language,@fileFingerprint,@name,@fqName,@kind,@startLine,@startColumn,@endLine,@endColumn,@parentName,@exported,@indexedAt,@indexerVersion,@parserVersion)
  `);
  const replaceFileTx = db.transaction((input: ReplaceFileInput) => {
    deleteSymbolsForFile.run(input.projectId, input.filePath);
    insertFile.run({
      ...input,
      diagnosticsJson: JSON.stringify(input.diagnostics),
    });
    for (const symbol of input.symbols) {
      insertSymbol.run({
        id: crypto.randomUUID(),
        ...symbol,
        projectId: input.projectId,
        filePath: input.filePath,
        language: input.language,
        fileFingerprint: input.fileFingerprint,
        indexedAt: input.indexedAt,
        indexerVersion: input.indexerVersion,
        parserVersion: input.parserVersion,
        exported: symbol.exported ? 1 : 0,
      });
    }
  });
  const deleteFileTx = db.transaction((projectId: string, filePath: string) => {
    deleteSymbolsForFile.run(projectId, filePath);
    db.prepare("DELETE FROM symbol_index_files WHERE project_id=? AND file_path=?").run(projectId, filePath);
  });

  return {
    replaceFile(input: ReplaceFileInput) {
      replaceFileTx(input);
    },
    deleteFile(projectId: string, filePath: string): boolean {
      const existing = db.prepare("SELECT 1 FROM symbol_index_files WHERE project_id=? AND file_path=?").get(projectId, filePath);
      deleteFileTx(projectId, filePath);
      return Boolean(existing);
    },
    clearProject(projectId: string): number {
      const count = (db.prepare("SELECT COUNT(*) AS count FROM symbol_index_files WHERE project_id=?").get(projectId) as { count: number }).count;
      db.transaction(() => {
        db.prepare("DELETE FROM symbols WHERE project_id=?").run(projectId);
        db.prepare("DELETE FROM symbol_index_files WHERE project_id=?").run(projectId);
      })();
      return Number(count);
    },
    listFiles(projectId: string): IndexedFileRecord[] {
      return (db.prepare("SELECT * FROM symbol_index_files WHERE project_id=? ORDER BY file_path ASC").all(projectId) as any[]).map(mapFile);
    },
    search(projectId: string, query: string, opts: { limit?: number } = {}): SymbolRecord[] {
      const limit = Math.min(Math.max(Math.floor(opts.limit ?? 50), 1), 200);
      const q = query.trim().toLowerCase();
      const rows = q
        ? db.prepare(`
            SELECT * FROM symbols
            WHERE project_id=? AND (lower(name) LIKE ? OR lower(fq_name) LIKE ?)
            ORDER BY exported DESC, file_path ASC, start_line ASC, start_column ASC
            LIMIT ?
          `).all(projectId, `%${q}%`, `%${q}%`, limit)
        : db.prepare(`
            SELECT * FROM symbols
            WHERE project_id=?
            ORDER BY file_path ASC, start_line ASC, start_column ASC
            LIMIT ?
          `).all(projectId, limit);
      return (rows as any[]).map(mapSymbol);
    },
    findDefinition(projectId: string, name: string): SymbolRecord | undefined {
      const q = name.trim();
      if (!q) return undefined;
      const row = db.prepare(`
        SELECT * FROM symbols
        WHERE project_id=? AND (name=? OR fq_name=?)
        ORDER BY exported DESC, CASE WHEN fq_name=? THEN 0 ELSE 1 END, file_path ASC, start_line ASC
        LIMIT 1
      `).get(projectId, q, q, q);
      return row ? mapSymbol(row) : undefined;
    },
    listFileSymbols(projectId: string, filePath: string): SymbolRecord[] {
      return (db.prepare(`
        SELECT * FROM symbols
        WHERE project_id=? AND file_path=?
        ORDER BY start_line ASC, start_column ASC, name ASC
      `).all(projectId, filePath) as any[]).map(mapSymbol);
    },
    diagnostics(projectId: string): SymbolDiagnostic[] {
      return this.listFiles(projectId).flatMap((file) => file.diagnostics);
    },
    status(projectId: string): SymbolIndexStatus {
      const files = this.listFiles(projectId);
      const symbolCount = (db.prepare("SELECT COUNT(*) AS count FROM symbols WHERE project_id=?").get(projectId) as { count: number }).count;
      const latest = files.reduce<IndexedFileRecord | null>((best, file) => (!best || file.indexedAt > best.indexedAt ? file : best), null);
      return {
        projectId,
        fileCount: files.length,
        symbolCount: Number(symbolCount),
        diagnosticCount: files.reduce((total, file) => total + file.diagnostics.length, 0),
        latestIndexedAt: latest?.indexedAt ?? null,
        indexerVersion: latest?.indexerVersion ?? null,
        parserVersion: latest?.parserVersion ?? null,
      };
    },
  };
}
