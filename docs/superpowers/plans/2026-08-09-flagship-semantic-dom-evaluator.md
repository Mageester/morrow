# Flagship Semantic DOM Evaluator Repair Plan

**Goal:** Score the documented flagship web contract rather than undocumented DOM identifier spellings.

**Live evidence:** DeepSeek run `a01dfd06-e57b-463a-8ce6-937097a34f61` completed in 45 tool calls and produced a working `Add sample task` button with ID `add-sample-task` plus an initial `0 tasks` element with ID `task-count`. The prompt specifies the visible behavior and text but no IDs. The hidden checker nevertheless requires IDs `add-task` and `count`, producing a false failure.

**Invariant:** Preserve strict checks for scripts, title, visible controls/state, interaction code, responsive CSS, loopback serving, stdin EOF behavior, generated tests, Git evidence, browser health, and supervised-process cleanup. Change only the undocumented ID predicates.

## Task 1: Semantic DOM predicates

Files:
- `services/orchestrator/src/acceptance/flagship-web.ts`
- `services/orchestrator/test/flagship-web.test.ts`

Acceptance criteria:
- Accept a button whose visible text is `Add sample task` regardless of its valid ID spelling.
- Accept an HTML element whose visible text is `0 tasks` regardless of its valid ID spelling.
- Continue rejecting artifacts missing the required button text or initial count text.
- Do not weaken the existing app interaction, generated-test, browser, server, command, or process checks.
- Add a deterministic regression using the exact valid ID spellings from the retained failed artifact.

Verification:
- Focused flagship-web tests.
- Adjacent acceptance/gate tests.
- Orchestrator TypeScript check.
- Full non-live suite.
- Independent evaluator review before one more live canary.

## Task 2: One post-fix canary

After commit and independent approval, run exactly one serialized `deepseek-v4-flash` `flagship-web-v1` canary. Preserve the append-only result. Any failure stops live execution and creates a new repair input.
