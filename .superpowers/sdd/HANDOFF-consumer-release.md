# Handoff — consumer release of Morrow

Branch: `feat/morrow-web-app-foundation`, on top of the merged 30-provider work
(`a80b9bd`, PR #64).

Goal stated by Aidan: finish the remaining work, then release so the suite
installs with one command and onboards like a normal consumer product.

## Done and verified

| Commit | What |
|---|---|
| `8a12ef5` | WIP checkpoint of the pairing / hosted-accounts redesign work |
| `a03a456` | Merge of `origin/main` (30-provider suite) into this branch, 5 conflicts resolved |
| `917332b` | Three agent dead ends: vision-vs-size misreport, unactionable budget error, extension allowlist inverted to a binary denylist |
| `ba712c1` | `create_file` correction names the missing field instead of triggering a full payload regeneration |
| `6e6e9b9` | Clay accent (`#bb5836` light / `#d97757` dark, contrast-checked) and two composer modes (Chat / Build) plus an auto-approve switch |
| `c28c869` | Tool-argument retry budget is enforced instead of only relabeled |

Test state: 228/228 web pass. Orchestrator 1251 pass with 20 pre-existing
failures in `pairing.test.ts` and `provider-configure.test.ts`, verified
identical before and after every change here — they are not caused by this work
and should be fixed separately before release.

## Evidence behind the reliability fixes

Taken from the live install DB (`%LOCALAPPDATA%\Morrow\data\morrow.db`), not
from reading code: **8 failed tool calls out of 53**.

The dominant chain, 5 of the 8:

1. Model edits a file with a unified diff, fails twice
2. Morrow escalates: "stop authoring diffs, call `create_file` with path X and the complete content"
3. Model sends 12–15k characters of valid content but omits `path`
4. Rejected; told to "fix the arguments"; regenerates the whole body
5. Reaches 6 attempts against a limit of 2, then dies

`ba712c1` and `c28c869` address steps 4 and 5. Step 3 itself is untouched —
see below.

## Remaining

### 1. `create_file` path recovery (not started)
When Morrow escalates to `create_file` it already knows the target path — it
names the path in its own instruction. A call arriving with valid content and
no `path` could be completed from that known target rather than rejected.
Care needed: only fill in when Morrow itself just instructed that exact path,
never inferred, since this writes files.

### 2. Reasoning selection accuracy (#2, not started)
Per-candidate `translateReasoning` validation exists in `agent.ts`. Unverified
whether the web model picker only offers efforts the selected route accepts.

### 3. Transcript view (#3, not started — largest item)
Aidan's repeated ask: see thinking, file creations and diffs, and terminal
commands, with a customizable view. Backend already stores what is needed —
`message_tool_calls` (args, result, status, timings), reasoning content in the
turn stream, `execution_disclosures`. Gap is a projection API plus the UI and
a persisted per-user view preference.

### 4. Cross-project memory and automatic skills (#6, not started)
Backend exists and is unexposed: `memory_entries` with a `user_global` scope,
`cortex/automatic-skills.ts`, `repositories/learned-skills.ts`. No HTTP routes,
no UI. Needs routes, a Memory surface (currently a "Soon" placeholder in the
sidebar), and a way for the user to see, confirm, and delete what was learned.

### 5. Release (#7, not started)
Blocked on the above. Also needs: version bump from `0.1.0-beta.33`, changelog,
the 20 pre-existing test failures resolved, `scripts/package-release.mjs` run,
a clean-machine install verified, and a one-command install path plus
first-run onboarding confirmed end to end.

## Environment notes

- `.claude/launch.json` has `morrow-web-foundation` (4318) and
  `morrow-orchestrator-foundation` (4317) pointing at this worktree.
- The dev orchestrator binds the same port and **the same database** as the
  installed app. Stop the installed Morrow before running it, and avoid
  triggering agent runs against real data.
- `worktrees/main-preview` is a scratch checkout of `origin/main` created only
  to preview the merged state; it can be removed with `git worktree remove`.
