### Task 9: Build Adaptive Work and Premium Result Views

**Files:**
- Create/modify: `work-tab.tsx`, `result-tab.tsx`, `artifact-frame.tsx`, and tests.

**Interfaces:**
- Consumes: `WebMissionArtifact[]` and `WebVerificationSummary`.
- Produces a consistent artifact frame and result delivery package.

- [ ] **Step 1: Write artifact and result tests**

Prove file, source, document, and code-diff metadata render through the same frame; unknown artifact kinds render a safe fallback; failed verification cannot render “Completed and verified”; caveats remain visible without expansion.

- [ ] **Step 2: Implement the initial artifact registry**

```ts
const artifactRenderers: Record<WebMissionArtifact["kind"], ArtifactRenderer> = {
  file: FileArtifact,
  document: TextArtifact,
  source: SourceArtifact,
  code_diff: DiffArtifact,
  browser_capture: MetadataArtifact,
  data: MetadataArtifact,
  email: MetadataArtifact,
  calendar: MetadataArtifact,
  other: MetadataArtifact,
};
```

This slice previews metadata and safe text only. It does not execute HTML, scripts, office macros, or arbitrary downloaded content.

- [ ] **Step 3: Implement Result hierarchy**

Order:

1. completion label derived from verification state;
2. plain-language summary;
3. primary artifacts;
4. verification checklist/evidence count;
5. caveats and unresolved risks;
6. secondary actions.

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @morrow/web test -- work-tab.test.tsx result-tab.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/components/artifact-frame.tsx apps/web/src/features/missions/work-tab.tsx apps/web/src/features/missions/result-tab.tsx
git commit -m "feat(web): add adaptive work and verified results"
```

---

