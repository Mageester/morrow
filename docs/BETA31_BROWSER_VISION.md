# Beta.31 controlled browser and vision

Beta.31 connects Morrow's hardened Playwright controller to the durable agent runtime. Browser tools are exposed progressively for browser and frontend requests, so unrelated coding turns do not pay the context cost of browser schemas.

## Runtime behavior

- `browser_open` creates a task-scoped session only after a durable approval for the exact HTTP(S) origin. Agent auto-approval may resolve that record only when the user selected agent auto-approval.
- Snapshot, console, click, fill, key, select, viewport, screenshot, download, and close operations use the approved session. The session is closed on every task exit path.
- Screenshots and downloads stay under `MORROW_HOME/artifacts/browser/<task-id>`. Screenshot evidence records route, viewport, byte size, SHA-256, and whether vision attachment was allowed.
- PNG bytes are attached ephemerally only when the selected model has non-unknown, positive vision metadata. OpenAI Chat, OpenAI Responses/Codex, Anthropic Messages, and Gemini transports have tested native image serialization. Base64 is not stored in conversation text, tool output, events, or audit records.
- Screenshot budget accounting uses verified viewport pixels (with a conservative overhead) rather than treating base64 transport bytes as text tokens. Recovered legacy images without dimensions use a conservative decoded-byte estimate.
- A durable restart may reattach the latest screenshot only after artifact-root containment, symlink, size, and SHA-256 checks pass.
- Packaged Windows sessions default to the installed Microsoft Edge channel. Source/development sessions retain Playwright's normal browser selection, and an explicit configured browser still wins.

Frontend changes have a deterministic post-change completion gate. Completion requires an approved navigation, explicit DOM snapshot, console/page-error inspection, at least one relevant interaction, and vision-attached screenshots at 1440x900, 768x1024, and 390x844. Missing evidence interrupts the task or returns a mission worker to Guardian validation; model narration cannot bypass the gate.

## Security boundaries

- Page text is untrusted and prompt-injection patterns are neutralized before model exposure.
- URL credentials and non-HTTP(S) schemes are rejected. Loopback/private targets require the approved hostname; intercepted subrequests remain on approved domains.
- Password inputs are absent from semantic refs. Credential, token, secret, payment-card, purchase, transfer, destructive account, release, deploy, publish, and push interactions are categorically blocked from autonomous browser actions.
- Upload/download containment resolves real paths and rejects symlink escapes. Screenshot recovery applies the same real-path boundary.
- Browser approval does not authorize unrelated filesystem access, credentials, purchases, releases, deployment, Git push, or destructive database operations.

## Evidence and rollback

Focused proof lives in `agent-browser.test.ts`, `browser-injection.test.ts`, `provider-vision.test.ts`, `context-budget.test.ts`, and `tools-catalog.test.ts`. The packaged `durable-autonomy-v1` acceptance scenario additionally creates a real responsive site through agent file tools, launches a browser against an approved loopback server, runs the source test, DOM snapshot, console checks, semantic interaction, and captures vision-attached PNGs at 1440x900, 768x1024, and 390x844.

Rollback removes the agent browser tool definitions and provider image fields while leaving task artifacts and audit history intact. It must not delete user workspaces, screenshots, downloads, approvals, or mission evidence.
