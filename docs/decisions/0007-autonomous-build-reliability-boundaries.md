# 0007 — Autonomous build reliability boundaries

Status: accepted
Date: 2026-07-30
Branch: `morrow/e2e-build-reliability`

## Context

`morrow build "<objective>" --in <fresh directory>` is the end-to-end product
claim: a user names what they want, points at an empty directory, and gets a
verified working application without expert intervention. Reproducing that
against packaged `0.1.0-beta.34` failed immediately (`✖ No safe project
selected.`, exit 2), and each fix exposed the next boundary that was not
actually being enforced.

This record captures the invariants that were missing, because each one had
the same shape: a check that *looked* like it held, and a code path that could
silently violate it.

## Decisions

### 1. A scoping verb owns creating the workspace it scopes

`build` is a first-class command; `--in` is a declared value flag. `--in`
creates the directory when missing, initializes a repository, and writes
starter ignore rules. `isSafeProjectRoot` is unchanged — creating a directory
never widens what a mission may touch, it only makes an explicitly named empty
scope usable. Without the repository there is no change set, so a mission that
wrote an entire application was reviewed against nothing.

### 2. A route the user pinned is an instruction, not a preference

`RoutingDecision.overridden` now suppresses mid-stream fallback entirely.
Fallback candidates are served with `getProviderDefaultModel(candidate.id)`, so
failing over from an explicitly requested provider/model substituted both. A
pinned route that cannot serve a turn surfaces the typed provider outcome. The
resolved route is durable evidence (`provider.route_selected`,
`mission.route_selected`) recorded before the first provider call.

### 3. Tool arguments are normalized at exactly one boundary

Between parsing and validation, and nowhere else. Every rule is a lossless
rename or container coercion with one possible reading. Validation keeps full
strictness: required fields, types, and the absolute-path refusal are
unchanged, and no schema was loosened. Normalization is a fixed point, so a
resumed or replayed turn cannot drift, and it is reported as
`tool.arguments_normalized` rather than applied silently.

### 4. Recovery fingerprints describe strategies, not workers

`worker:<taskId>` identified the task, and every retry is a new task, so two
identical strategies could never match and stagnation was undetectable by
construction. Fingerprints now encode category, action, and intended
substitution. A strategy already tried for a category escalates along a ladder
of materially different approaches, then stops explicitly.

### 5. Stated requirements are authoritative criteria

Criteria generation depended on the planning model, with a heuristic fallback
asserting only "no unrelated changes" and "a reviewer approves". An objective
naming seven explicit requirements produced exactly those two. Requirements the
user wrote are now extracted deterministically and merged ahead of generated
criteria, keeping the user's wording and classifying by the user's own label.
No command is invented; a requirement with no named command still becomes a
visible criterion that must be answered with evidence.

### 6. A service is adopted only when it belongs to this install

`isMorrowHealth` answered "is something speaking the Morrow API here?", and
every install and dev worktree answers yes on the same fixed port. A packaged
build silently drove an unrelated orchestrator, which makes every check run
against it meaningless. `/api/health` now reports install identity
(`serviceRoot`, `serviceEntry`), the launcher adopts only a matching service,
and `MORROW_PORT` lets a second install run beside an existing one.

### 7. Ending a process is a boundary crossing

Process kills are never scoped to the workspace, and Morrow's own runtime is
one of the processes they match. Selecting by image name or filter is denied;
killing a specific pid always requires explicit approval and is never
auto-approvable. This tightens the boundary — nothing previously denied became
permitted.

### 8. Change tracking shows the work, not the debris

Generated artifacts (installed dependencies, build output, caches, captured
screenshots) are filtered before the change-list bound is applied, so the
bound applies to meaningful source. Lockfiles stay visible: a changed lockfile
is a real consequence of the work.

## Consequences

- A pinned route can now fail where it previously produced an answer from
  elsewhere. That is the intended trade: a wrong-model answer is worse than a
  typed failure.
- Missions gain more criteria than before, so a mission that would previously
  have been graded complete on two generic criteria can now legitimately land
  short. That is the point.
- Two installs can coexist only when the second sets `MORROW_PORT`; otherwise
  it refuses rather than colliding.

## Known gap

A packaged build against a real external model (OpenCode Zen,
`deepseek-v4-flash-free`) produced a complete, working, tested application —
14/14 generated tests passing, API and browser verified at desktop and mobile
viewports, persistence surviving a restart — while the mission itself recorded
**no evidence** and did not reach a verified terminal state. Producing the
artifact and closing the accountability loop are separate problems; only the
first is addressed here. The verification-gate work (dependency install, tests,
typecheck/build, service startup, API health, browser render, console errors,
interaction, viewport checks, each bounded) remains open.
