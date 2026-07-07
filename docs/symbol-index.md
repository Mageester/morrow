# Symbol Index

Morrow keeps a local, project-scoped symbol index so agents can find definitions
without reading an entire repository into context.

## What Is Indexed

- TS, TSX, JS, JSX: functions, classes, methods, interfaces, type aliases,
  variables, enums, nested symbols, export status, parent names, and source
  locations.
- JSON: object property paths useful for config files, such as `scripts.test`
  and `dependencies.zod`.
- Per file: language, SHA-256 fingerprint, parser/indexer version, last indexed
  time, and parse diagnostics.

File contents are not stored in the symbol tables.

## Operations

- `morrow symbols rebuild` clears and rebuilds the project index.
- `morrow symbols refresh` reindexes changed files, adds new files, removes
  deleted files, and treats renames as delete plus add.
- `morrow symbols status` reports indexed files, symbols, diagnostics, and
  parser/indexer versions.
- `morrow symbols search <query>` searches names and qualified names.
- `morrow symbols definition <name>` returns the best matching definition.
- `morrow symbols file <path>` lists symbols for one indexed file.

The same operations are available through project-scoped API routes under
`/api/projects/:projectId/symbols/*`.

## Agent Tool

Agents can call `search_symbols` in read-only and agent modes. The result is a
small list of symbol metadata and locations:

```json
{
  "query": "add",
  "status": "ready",
  "symbols": [
    { "name": "add", "fqName": "add", "kind": "function", "filePath": "src/math.ts", "startLine": 4 }
  ]
}
```

Plan-only mode exposes no tools.

## Privacy And Limits

The indexer stays local and inside the registered project root. It skips
`.morrow`, secret-like paths, `node_modules`, build output, dependency caches,
generated files, and patterns from `.gitignore` and `.morrowignore`. Resource
limits cap scanned files and per-file bytes, and cancellation stops a rebuild or
refresh before more filesystem work proceeds.

## Known Limitations

This is a symbol index, not embedding-based semantic search. It uses structured
parsing for TS/JS-family files and JSON configs, but it does not run a language
server or resolve cross-file type references yet.
