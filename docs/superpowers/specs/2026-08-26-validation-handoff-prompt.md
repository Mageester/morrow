# Handoff prompt — continue Morrow 0.7.1 post-release validation

Copy everything below the line into a new chat.

---

Continue independent post-release validation of Morrow **0.7.1**. A previous
session did the packaging/install/provider half; the process-lifecycle half —
which is what 0.7.1 actually shipped — is untouched. Read
`docs/superpowers/specs/2026-08-26-v0.7.1-post-release-validation.md` on branch
`fix/validation-defects` first; it has all findings with reproductions.

## State

- **Released:** `v0.7.1`, commit `4eab42443dc0264eb6365a676bf0b51bd64bb6de`,
  published 2026-08-26T05:54:59Z. Release workflow `32935191356`, all 7 jobs green.
  Artifact verified: sha256 matches published checksums, provenance matches the
  tag, migrations 68/68 apply on a fresh DB. **The artifact is sound.**
- **Work branch:** `fix/validation-defects` @ `d444077`, in a worktree at
  `/home/dread/Code/morrow-fixes`. Four commits, **unpushed, no upstream**.
  D1 (`7254476`), D2 (`6d9c461`), D3 (`2ba2c4c`) fixed; D4–D7 open.
- **User's live service:** port **4317**, the installed 0.7.1 at
  `~/.local/share/morrow/app`. Leave it alone — use a different port.
- **DB backup:** `/home/dread/morrow-backups/morrow.db.20260826-111456`
  (12M, `integrity_check: ok`).

## Your task

Validate the **published artifact** — never a source build, never the fix branch —
across the matrix that is still unexercised:

1. A substantial end-to-end Build mission (this was interrupted last time)
2. `write_plan`
3. Foreground vs background process handling
4. `keepAlive`
5. Intentional `expectedExitCode`
6. Cancellation during active work
7. Descendant-process cleanup
8. Restart / resume
9. Provider rate-limit, failure, and stall behaviour where practical
10. Truthful, evidence-backed completion (no false "completed" on failed work)
11. **Zero task-owned leaked processes afterwards**

Act adversarially. Hunt for false completion, stale evidence, broken recovery,
and anything that works from source but fails in the released package.

**Do not fix anything during validation.** Preserve exact reproduction evidence
first. If you find a release-blocking defect, report it immediately as:
severity → exact reproduction → expected → observed → evidence → likely cause.

## Setup (learned the hard way — follow it)

```bash
# 1. Isolated home. NEVER test against ~/.morrow.
export MORROW_HOME=/home/dread/morrow-validation/home
mkdir -p "$MORROW_HOME"

# 2. Install the PUBLISHED artifact as a new user would.
curl -fsSL https://morrowproject.getaxiom.ca/install.sh | sh -s -- \
  --prefix /home/dread/morrow-validation/app \
  --bin-dir /home/dread/morrow-validation/bin \
  --no-start --no-modify-path --no-browsers

# 3. Credentials: COPY, never print the values.
cp ~/.morrow/secrets.env "$MORROW_HOME/secrets.env" && chmod 600 "$MORROW_HOME/secrets.env"
cp ~/.morrow/config.json "$MORROW_HOME/config.json"

# 4. Start on a free port (NOT 4317).
/home/dread/morrow-validation/bin/morrow start --port 4455 --host 127.0.0.1

# 5. Cloud providers are blocked until you switch privacy mode.
curl -sS -X PATCH http://127.0.0.1:4455/api/assistant-profile \
  -H 'content-type: application/json' -d '{"defaultPrivacyMode":"controlled_cloud"}'

# 6. Model metadata is NEVER fetched automatically — context/reasoning stay
#    empty until you do this. Catalogue goes 188 -> ~1516 models.
curl -sS -X POST http://127.0.0.1:4455/api/models/refresh
```

## Gotchas that cost the last session real time

- **`/tmp` scratchpad gets wiped mid-session.** It destroyed three isolated
  installs, a 92MB artifact, and the findings doc. Keep anything durable under
  `/home/dread/`, and commit it.
- **Never back up into `~/.morrow/backups/`** — Morrow rotates that directory and
  deleted a DB backup placed there. Use `/home/dread/morrow-backups/`.
- **`--model` does not select the provider.** You must pass `--provider` too, or
  everything routes to deepseek and fails with a confusing error (D5).
  Known-good routes:
  - `--provider opencode-zen --model x-preview-f-free`
  - `--provider tokenrouter --model qwen/qwen3.8-max-free`
  - `--provider deepseek --model deepseek-v4-flash`
  - nvidia-nim works but many catalogue-listed models 404 (D6); use
    `meta/llama-3.1-8b-instruct`.
- **In the RELEASED build, `--help` executes the command** (D2 — fixed on the
  branch, not in the artifact you are testing). `morrow stop --help` will stop a
  service; `morrow start --help` will start one on port 4317. Do not run
  `--help` against the released binary unless `MORROW_HOME` is isolated.
- **`morrow ask` defaults its workspace to the current directory.** Always `cd`
  to a scratch workspace or pass `--in`, or it will operate on the Morrow repo.
- **Shared checkout hazard.** Other agent sessions commit into
  `/home/dread/Code/morrow`. HEAD moves under you, and `reflog` is per-checkout
  so it cannot attribute authorship. Work in a worktree.
- **Pipe exit codes lie:** `timeout … | tail` reports `tail`'s status. Capture
  the command's own exit code when it matters.

## Finish with

Released tag/version · published commit SHA · workflow status · artifact tested ·
install result · provider matrix · major test results · defects found ·
leaked-process check · final verdict: **PASS / PASS WITH KNOWN ISSUES /
RELEASE REGRESSION**.

Answer one question with evidence: **does the exact Morrow 0.7.1 artifact users
can download actually work under real multi-provider, long-running agent
workloads?**
