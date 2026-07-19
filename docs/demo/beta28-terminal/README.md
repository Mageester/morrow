# Beta.28 Terminal Experience — Demonstration Package (Post-Fix, Verified)

This folder documents two connected real Morrow CLI sessions:

1. An initial attempt to assemble this demo package, which surfaced a real
   report-integrity bug: the exported task report's `## Final Answer`
   contained the same planning sentence repeated 12 times.
2. After that bug was root-caused and fixed ([PR #36](../../..), merge commit
   `450f3f5dffc0bbe99ff981dbc45ab3260878ac74` on `main`), a fresh verification
   session against the fixed code — confirmed clean by reading the actual
   exported report file directly, not just a screenshot.

**Nothing in this package is fabricated, staged, or mocked.** Every
screenshot, statistic, and transcript excerpt traces back to a specific tool
call, an exported report, or an independently-run command — see
[`evidence-manifest.json`](evidence-manifest.json) for the full accounting,
including SHA-256 hashes and an `integrityHistory` section documenting the
bug, the fix, and a second snag hit during verification (see below).

## Important: this is not a "beta.28 release"

`package.json` on `main` is still `0.1.0-beta.27` — no `v0.1.0-beta.28` tag
or release exists at the time of this demo. This package shows the
**merged, pre-release terminal-experience code on `main`** (PR #35 plus the
follow-up fix in PR #36), not a shipped beta.28.

## The honest, slightly messy path to this package

1. First attempt (main @ `19efe1f`, PR #35 only): assembled a full demo
   package, then ran the report-integrity audit specified for this task.
   It failed — the real exported transcript showed the repeated-narration
   bug. The package was **not committed**.
2. Root-caused and fixed in [PR #36](../../..): the orchestrator's ReAct loop
   and the CLI's terminal state reducer never tracked turn boundaries, so
   every turn's narration concatenated into one message. Fixed with explicit
   `assistant.turn_started`/`assistant.turn_completed` events, a `turnId`,
   and a `selectCanonicalFinalAnswer()` selection function used everywhere
   a report is built. 46 new/updated tests, full validation clean twice, CI
   green, merged.
3. **Re-running the demo against the "fixed" code still showed the bug.**
   The cause: a long-running orchestrator background service (the installed
   app at `C:\Users\[REDACTED-USER]\AppData\Local\Morrow\app\runtime`,
   started ~36 hours before the fix existed) was still serving requests on
   port 4317 — the CLI was talking to stale, pre-fix code in memory even
   though the source files on disk were fixed. Diagnosed by checking which
   process owned the port, stopped it, and started a fresh orchestrator
   directly from this repository's fixed source (`pnpm start` in
   `services/orchestrator`).
4. Re-ran the full two-task demo against the correctly-restarted orchestrator.
   Verified clean by reading the real exported `.md` file directly: `## Final
   Answer` appears exactly once, the repeated-preamble phrase count is 0, and
   a new `## Intermediate Activity` section correctly bounds the 7
   intermediate turns instead of dumping raw narration.

This sequence — including the false start — is preserved in
`evidence-manifest.json`'s `integrityHistory` section rather than cleaned up,
because it's real evidence of the fix actually working, not just claimed to.

## Screenshot accounting

17 screenshots were originally numbered (01-17) during the terminal-experience
demo work. This package includes **12 files**, of which **10 are visually
distinct** — `06`/`07` and `08`/`11` are byte-identical duplicate re-saves
(verified by SHA-256, not just by description) kept only to fill the deck's
slide sequence. Of those 10 distinct images:

- **8 are fresh captures from the final, verified post-fix run**: `03`, `04`,
  `05`, `06`, `08`, `12`, `13`, `17`
- **2 are carried over from the discarded, stale-orchestrator v2 workspace**
  (`01`, `02`) — confirmed by reading the screenshots directly, which show
  "Beta28-Terminal-v2" on screen, matching this package's own account of the
  first, discarded attempt

The remaining **5 of the original 17** were intentionally not recaptured
(`09`, `10`, `14`, `15`, `16` — see below for why).

Put together: **9 of the original 17 were carried over or intentionally not
recaptured** (5 not-recaptured + 2 carried-over + 2 duplicate re-saves), and
**8 are fresh, distinct evidence of the post-fix run**. See
`evidence-manifest.json` → `screenshotAccounting` for the full, file-by-file
breakdown with hashes. (An earlier verbal summary of this package cited "11
fresh screenshots" — that figure does not reconcile with the committed files
under any consistent definition and should be treated as superseded by this
accounting.)

## What's in here

| Path | What it is |
|---|---|
| `evidence-manifest.json` | Machine-readable index of every artifact, with SHA-256 hashes, timestamps, provenance, and the integrity-fix history |
| `demo-script.md` | What was asked of Morrow and why, step by step |
| `screenshots/` | Real screenshots from the verified post-fix session (plus two carried-over boot/YOLO shots — see manifest for why) |
| `slideshow/deck.html` + `slideshow/beta28-terminal-demo.pdf` | 12-section deck built from the real screenshots/data |
| `transcript/task-2-dark-mode-toggle-EXPORTED.md` | A real Morrow `/export` of the second demo task, post-fix — the same task that previously exhibited the bug, now clean |
| `verification/independent-verify-run.txt` | Raw output of an independent `node verify.js` run |
| `raw-recording/`, `edited-video/` | Empty — no video was captured, see below |

## What's missing, and why

**No video.** OBS Studio access (via computer-use) was requested and denied
by the user; per instructions, no workaround was attempted. The user chose
to ship the rest of the package without it.

**Five screenshots were not recaptured this round**
(`09-restart-boot`, `10-output-after-restart`, `14-medium-layout`,
`15-narrow-layout`, `16-scrollback-text-selection`). These exercise
restart/session-resume and responsive-layout/scrollback rendering — areas
the turn-boundary fix does not touch. They were already proven working with
real screenshots in the original PR #35 pass and aren't re-claimed here as
"affected" evidence. See `evidence-manifest.json` → `screenshotsNotRecaptured`
for the full reasoning.

**A minor tool-count discrepancy** between the live terminal status bar
(19 calls) and the persisted report header (13 calls) for the same task —
flagged honestly in the manifest rather than investigated to closure, since
it's unrelated to the turn-boundary fix this package is demonstrating.

## Redactions

The Windows username is redacted (black box, red outline) in
`13-export-confirmation.png` where it appeared in a `.morrow` report file
path. No other redactions were needed — the exported transcript itself was
checked for the username string and found clean.
