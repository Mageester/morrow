# Authoritative Externalized Reads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep oversized tool results durably externalized while making an oversized file read appear to the model as authoritative bounded content, with an exact continuation action instead of a storage pointer.

**Architecture:** Preserve the complete raw result in `tool_artifacts` and `result_json`. Add a read-specific model projection that carries an exact bounded content prefix, file metadata, and a machine-actionable next offset. Treat an already bounded `read_artifact` page as a direct content response so it cannot be externalized recursively.

**Tech Stack:** TypeScript, Vitest, SQLite-backed tool artifact repository, Morrow provider projection.

**Spec:** User request in the task conversation: fix externalized `read_file`/`read_artifact` context without removing byte bounds, add write-read-continue regression coverage, and run the orchestrator suite plus `pnpm check`.

## Global Constraints

- Keep complete oversized results in the durable artifact store; do not inline an unbounded payload into provider context.
- The model-facing read projection must describe file content and continuation in file/tool terms, not Morrow persistence internals.
- `read_artifact` remains read-only and may serve only artifact ids already offered to the task.
- Preserve secret redaction, UTF-8 boundary safety, existing write projections, and legacy context materialization.
- Add regression tests for behavior and run `cd services/orchestrator && npx vitest run`, then `pnpm check`.

---

### Task 1: Lock the read projection contract with failing tests

**Files:**
- Modify: `services/orchestrator/test/artifact-externalization.test.ts`
- Modify: `services/orchestrator/test/read-artifact-tool.test.ts`
- Modify: `services/orchestrator/test/agent-trusts-successful-writes.test.ts` or add the focused integration test beside it

**Interfaces:**
- The tests consume the existing artifact externalizer and agent/provider test seams.
- The tests establish a read-specific renderer that returns bounded JSON containing direct `content`, `read_succeeded`, the source path/range, and an exact next action when the visible page is incomplete.

- [x] **Step 1: Write the failing pure projection tests**

Use an oversized source body and assert that rendering an externalized `read_file` result with its read metadata produces direct content, does not expose `truncatedForContext` or a durable-storage explanation, and gives the next file offset without replaying the full body. Add a `read_artifact` page case asserting the same direct-content contract for a page larger than the normal context bound.

- [x] **Step 2: Write the failing write-read-continue regression**

Run a real YOLO agent against a temporary workspace. Have a conditional test provider create `public/app.js` with a body over 8 KiB, read it, and inspect the returned tool message. The provider must issue a second equivalent `create_file` only when the read message lacks direct authoritative content; otherwise it returns a final continuation. Assert that the recorded calls contain exactly one `create_file` for that path and that its body is the original body.

- [x] **Step 3: Run only the new tests and verify they fail for the current pointer behavior**

Run:

```bash
cd services/orchestrator && npx vitest run test/artifact-externalization.test.ts test/read-artifact-tool.test.ts test/agent-trusts-successful-writes.test.ts
```

Expected: the new assertions fail because the externalized read is currently an artifact metadata pointer and a `read_artifact` page can be externalized again.

---

### Task 2: Implement bounded authoritative read rendering

**Files:**
- Modify: `services/orchestrator/src/execution/artifact-externalization.ts`
- Modify: `services/orchestrator/src/execution/agent.ts:484-508,3360-3375,5912-7415`

**Interfaces:**
- Add a typed read presentation input containing `path`, `offset`, `size`, `eof`, and the raw page `content`.
- Extend `renderExternalizedForContext` with an optional read presentation; when present, render direct bounded content instead of artifact metadata.
- Add a bounded `read_artifact` page renderer that accepts its raw JSON result and returns direct content plus continuation metadata, or returns `null` for malformed/non-page results so the ordinary externalizer remains the fallback.

- [x] **Step 1: Add UTF-8-safe bounded content helpers and read renderers**

Use a byte-based prefix that backs up over UTF-8 continuation bytes. Keep the model-facing JSON below the existing 8 KiB result bound by reserving space for metadata and instructions. Mark the displayed range authoritative, include `read_succeeded: true`, and emit `{ tool: "read_file", arguments: { path, offset } }` or the corresponding `read_artifact` call when more content is needed.

- [x] **Step 2: Pass read metadata from the live `read_file` branch**

Capture the already validated `fileData` metadata and content for the current tool call. Pass it through the model-visible result path so only the bounded projection changes; keep `resultStr` and the artifact row complete.

- [x] **Step 3: Keep `read_artifact` pages direct and bounded**

Before the generic `capToolResult` externalizer handles a terminal result, recognize a valid `read_artifact` page and compact only its `content` field. Preserve exact offsets and next offsets after compaction so a model can request the next page without guessing.

- [x] **Step 4: Run the focused tests and confirm green**

Run the three focused test files from Task 1. Expected: all pass, including the conditional integration test with no equivalent second write.

---

### Task 3: Preserve the contract across durable reconstruction

**Files:**
- Modify: `services/orchestrator/src/repositories/conversations.ts:14-27,333-345,384-407`
- Modify: `services/orchestrator/src/execution/provider-projection.ts` only if the new bounded read envelope needs an explicit preservation branch
- Modify: `services/orchestrator/test/agent-file-creation.test.ts` or the focused read test for legacy materialization coverage

**Interfaces:**
- Derive read metadata from the recorded `args_json` and `result_json` when materializing a legacy terminal row with no `context_result_json`.
- Keep current restart projection and artifact permission recovery behavior intact.

- [x] **Step 1: Add a legacy materialization assertion**

Seed a terminal `read_file` row with a large result and no context projection, materialize it, and assert that the saved context contains direct bounded content and an exact next action rather than only `artifactId` metadata.

- [x] **Step 2: Pass recorded read arguments into context derivation**

Use the recorded path and offset for plain-text `read_file` results; recognize the structured `readWorkspaceFile` envelope when present. Keep all other tools on the existing artifact-backed derivation path.

- [x] **Step 3: Verify restart projection stays bounded and direct**

Run the focused legacy test and provider projection tests. Confirm the direct read envelope remains under the model-facing byte bound and is not converted into a generic truncation object.

---

### Task 4: Document and verify the completed change

**Files:**
- Modify: `docs/decisions/0014-bounded-harness-convergence.md` with the read-side projection invariant and rollback consequence

- [x] **Step 1: Record the invariant**

Document that artifact storage remains the durable byte-bound mechanism, while successful externalized reads are projected as authoritative bounded content with an exact continuation instruction; the model does not need to inspect Morrow storage to trust a file read.

- [x] **Step 2: Run the requested orchestrator suite**

Run:

```bash
cd services/orchestrator && npx vitest run
```

Expected: exit code 0 with no failed tests.

- [x] **Step 3: Run repository type and invariant checks**

Run:

```bash
pnpm check
```

Expected: exit code 0 with no type or repository validation errors.

- [x] **Step 4: Review the diff and report evidence**

Confirm only the planned source, tests, and architecture record changed in this task; preserve unrelated pre-existing working-tree edits. Report commands, test counts/output, security/privacy impact, and any limitations.
