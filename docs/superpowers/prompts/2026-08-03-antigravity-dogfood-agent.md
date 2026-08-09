# Antigravity dogfooding prompt — paste this into Gemini

---

You are dogfooding **Morrow**, a local-first AI coding agent, by actually
using it to build real things and fixing whatever breaks. This is not a
one-off bug report — it's a loop: build something real, watch what goes
wrong, fix the root cause in Morrow's own source, repeat.

## Where things are

- Repo: `C:\Users\aidan\OneDrive\Documents\Morrow\Morrow`
- Read `AGENTS.md` in the repo root now and follow it for everything not
  covered below — branch discipline, commit style, what counts as done.
- Read `README.md` for what Morrow is.
- The installed app is already configured with working provider keys
  (DeepSeek and OpenCode Zen). **Do not read, print, log, or commit any
  credential file** (`secrets.env`, `config.json` under `~/.morrow` or
  `%LOCALAPPDATA%\Morrow\data`). You don't need the key values — the CLI
  already has them.

## Before you touch source: set up your workspace

1. Create your own git worktree so you never edit `main` directly:
   ```
   git worktree add .worktrees/antigravity-dogfood -b agent/antigravity-dogfood
   ```
   Do all source edits inside that worktree.
2. Confirm the baseline is green before you change anything:
   ```
   pnpm check
   pnpm test
   ```
   If either fails before you've touched anything, stop and report — don't
   build on top of a broken baseline.
3. Explicitly select a known-good model before running any build. **Do not
   trust the default** — a prior investigation found the local config
   defaulting to an unverified custom route (`openai-compatible` /
   `hy3-free`) that is a plausible cause of slow, wandering runs on its own,
   separate from any orchestration bug. Run:
   ```
   morrow model select deepseek/deepseek-v4-flash
   ```
   or `opencode-zen/deepseek-v4-flash-free` — both are the two providers this
   project actually verifies against. If model selection itself fails or
   errors, that's a finding — report it, don't route around it.

## The loop

For each build task:

1. Pick or invent a **small, real, verifiable** build spec — something with
   an unambiguous "did it work" check. Vary the shape across runs so you
   exercise different capability classes:
   - a CLI tool with a single command and one test file
   - a small script that reads/writes a local file
   - something that needs an `npm install` of a real dependency
   - something whose task explicitly says "write tests and make sure they
     pass" — this exercises the exact path that was just fixed (a test
     runner hanging because it never saw a non-interactive signal), so
     include it deliberately, not by accident.
2. Run it in a fresh temp directory, non-interactively:
   ```
   morrow build "<your spec>" --in <fresh temp dir>
   ```
   `morrow build` auto-approves by default (no `--yolo` needed). Give it a
   real wall-clock budget — a few minutes — and note if it ever seems to sit
   doing nothing.
3. Judge the result against the spec, not against what the agent *claims*.
   Did the file actually get written? Does it run? If it was supposed to
   have passing tests, do they actually pass when you run them yourself?
4. **If it worked**, move to the next spec.
5. **If it didn't** — hung, crashed, produced something that doesn't run,
   or claimed success when it wasn't — that is a Morrow defect, not a
   defect in the generated app. Switch into diagnosis mode:
   - Do not stare at the generated project's code looking for "what the
     model did wrong." Look at Morrow's own durable evidence instead:
     `morrow logs`, the task's event/checkpoint history, `~/.morrow` (or
     `%LOCALAPPDATA%\Morrow\data`) — what tool calls were made, what the
     provider actually returned, where it stopped.
   - Find the actual mechanism in `services/orchestrator/src/`. Don't
     guess — read the code path that produced the bad behavior.
   - **Reproduce it as a small, direct test before writing any fix.** A
     failing test you wrote, run, and watched fail is evidence. A plausible
     story about what might be wrong is not. If you can't reproduce it
     directly, say so explicitly rather than fixing blind.
   - Write the smallest fix that addresses the actual mechanism, not a
     workaround in the generated project. Add a regression test in the
     matching `services/orchestrator/test/*.ts` file whose docstring states
     the failure mode in plain terms — how it was found, what broke, what
     the fix changes. Match the style already in that directory.
   - Run the full gate before considering the fix real:
     ```
     pnpm check
     pnpm test
     ```
     Every test must still pass — a fix that breaks something else isn't a
     fix. Do not weaken, skip, or delete an existing assertion to make the
     suite green.
   - Commit with a Conventional Commit message that states the mechanism,
     not just the symptom (`fix(execution): ...`, `fix(provider): ...`).
     One defect per commit.
6. Continue to the next build spec. Keep a running list of every defect
   found and fixed, with commit hashes, so it can be reported back cleanly.

## Hard limits

- **Never edit `main` directly, never push, never merge.** Everything
  lands as commits on your worktree branch for review.
- **Never touch version or release files** (`package.json` version,
  `CHANGELOG.md`, `apps/cli/src/service/update.ts`, `README.md` status
  line, anything under `dist/`) — releases are cut separately.
- **Never commit a credential, key, or anything from `~/.morrow` or
  `%LOCALAPPDATA%\Morrow\data`.**
- **Bound your own loop.** Cap total build attempts per session (start
  with ~10) and cap wall-clock time per attempt (a few minutes). If a
  single build attempt seems to hang, that itself is the finding — capture
  what you can from the logs, kill it, and move on rather than waiting
  indefinitely.
- If you get blocked on something outside your control — a provider
  billing/auth error, a missing model — **report it plainly and stop**,
  don't invent a workaround that masks it.

## When you're done (or blocked)

Write a short summary: every build spec tried, pass/fail, and for each
defect found — the commit hash, the one-sentence mechanism, and the
regression test that proves it. State plainly anything you suspected but
could not reproduce; don't round an unreproduced hunch up to a fix.
