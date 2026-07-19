# Morrow Capability Recommendations

> **Status (as of beta.32).** Adopted as a tracked capability roadmap. Some
> items already shipped and should be read as *extend*, not *build from zero*:
> browser automation with screenshots, console/DOM inspection, semantic-ref
> interaction, and desktop/tablet/mobile viewport capture landed in **beta.31**
> (`services/orchestrator/src/browser/`, `acceptance/browser-site.ts`). The
> remaining highest-impact gaps are persistent dev-server lifecycle management
> (§2), stronger structured file-editing primitives (§3), and the visual
> regression / accessibility loops (§5–6). See
> [`MORROW_BACKLOG.md`](MORROW_BACKLOG.md) for where this sits in sequencing.

## Goal

Make Morrow substantially more effective while preserving secure, explicit boundaries around secrets, networking, destructive operations, and source-control remotes.

The largest improvement is not unrestricted filesystem or shell access. It is reliable **observation and verification**: being able to build an application, inspect it in a real browser, test it across viewports, and report evidence accurately.

---

## Highest-impact additions

### 1. Browser automation with screenshots and console access

This is the single most valuable addition for frontend work.

Provide a browser tool—ideally backed by Playwright—that can:

- Open local URLs and wait for the page to become ready
- Capture screenshots at defined viewport sizes
  - Desktop: `1440 × 900`
  - Tablet: `768 × 1024`
  - Mobile: `390 × 844`
- Read browser console errors and warnings
- Read failed network requests
- Inspect the DOM and accessibility tree
- Click controls, fill forms, and press keyboard keys
- Emulate `prefers-reduced-motion`
- Assert visibility, focus order, modal focus trapping, and absence of horizontal overflow

Example interface:

```ts
browser.open({ url: "http://127.0.0.1:5173" })
browser.screenshot({ width: 1440, height: 900 })
browser.console()
browser.click({ role: "button", name: "Enter the Observatory" })
browser.press({ key: "Escape" })
browser.emulateMedia({ reducedMotion: "reduce" })
```

Why it matters:

- Prevents unsupported claims such as “visually verified” when visual verification was not available.
- Makes responsive and interaction testing concrete rather than inferred from source code.
- Catches runtime problems that TypeScript and production builds do not.

---

### 2. Persistent development-server management

Provide managed local development-server lifecycle controls:

- Start a server and return a durable server/process handle
- Report the actual command, PID, working directory, port, and bound URLs
- Health-check the URL before declaring the server ready
- Read recent stdout/stderr logs
- Stop and restart by handle
- Discover an available port if the requested port is occupied

Example interface:

```ts
server.start({
  command: ["pnpm", "dev", "--host", "0.0.0.0"],
  readyUrl: "http://127.0.0.1:5173"
})

server.status({ id: "server-id" })
server.logs({ id: "server-id", tail: 100 })
server.stop({ id: "server-id" })
```

Why it matters:

- Removes ambiguity about whether a server is truly running and reachable.
- Makes it possible to diagnose port collisions, Vite startup failures, and networking boundaries.

---

### 3. Stronger file-editing primitives

Large patches and generated CSS are common failure points. Add reliable, structured write operations:

- Direct overwriting of an existing file
- Line-range replacement
- Insert-before and insert-after operations
- Patch validation before application
- Larger safe payload limits
- Structured JSON edits
- Structured TypeScript import edits
- Return a compact diff and final content hash after each operation

Example:

```ts
files.replaceRange({
  path: "src/styles/app.css",
  startLine: 180,
  endLine: 240,
  content: "..."
})
```

Why it matters:

- Avoids repeated failures when large unified diffs are truncated or rejected.
- Makes targeted refinements safer and more deterministic.

---

## Additional high-value capabilities

### 4. Workspace-aware command execution

Extend the safe project command runner with local verification utilities:

- HTTP checks against localhost
- Local port and process inspection
- Better error output and retained command artifacts
- Test report collection
- Image/static artifact inspection
- Optional supported command presets for build, lint, typecheck, test, and preview

Keep restrictions against shell wrappers, privilege escalation, arbitrary host execution, and unbounded external network access.

The purpose is stronger local verification—not unrestricted execution.

---

### 5. Visual review and screenshot-diff workflow

For high-fidelity frontend work, add a visual regression loop:

1. Capture baseline screenshots.
2. Apply changes.
3. Capture revised screenshots.
4. Produce a visual diff.
5. Allow the agent to inspect both images and explain intentional changes.

Useful additions:

- Screenshot annotations
- DOM element bounding boxes
- Contrast checks
- Overflow detection
- Above-the-fold comparison
- Performance and render metrics

This makes subjective requests such as “make it much cleaner” measurable and iterative.

---

### 6. Accessibility tooling

Provide a first-class accessibility verification tool, such as axe-core plus keyboard traversal support:

- Automated accessibility audit
- Keyboard-tab traversal recording
- Focus-visible checks
- Accessible-name checks for controls
- Heading and landmark outline
- Modal focus-trap verification
- Color contrast checks

This is especially valuable for cinematic interfaces, where visual polish can otherwise compromise usability.

---

## Repository and project-context improvements

### 7. Better project understanding

Useful project intelligence features:

- Fast symbol index with call/reference navigation
- Dependency graph
- Test inventory and coverage report
- Git history and blame when explicitly needed
- User-edit detection before applying modifications
- Automatic identification of relevant manifests, instructions, and architecture documents

These reduce unnecessary broad repository ingestion and minimize conflicts with active human work.

### 8. Optional local asset-generation pipeline

For visual projects, local-only asset utilities would help:

- SVG generation and optimization
- Image resizing and format conversion
- Font inspection
- Procedural asset preview
- Palette and contrast analysis

None of these require paid APIs or external keys.

---

## Recommended security model

More access should remain tiered and explicit.

| Capability | Recommended policy |
| --- | --- |
| Read project files | Allowed by default |
| Edit project files | Allowed with a recorded diff |
| Run project-local allowlisted commands | Allowed |
| Start supervised local servers | Allowed |
| Browser automation against localhost | Allowed |
| Install dependencies | Approval or policy-based |
| External network access | Explicit approval |
| Read secrets or `.env` files | Denied by default |
| Git commit, push, or remote actions | Explicit approval |
| File deletion or destructive migrations | Explicit approval |
| OS-level process control outside workspace | Denied or elevated approval |

The optimal model is **high local autonomy inside the workspace, with hard boundaries around secrets, remote/network access, destructive actions, and source-control remotes**.

---

## If only three capabilities are implemented

1. **Playwright-backed browser automation** with screenshots, console inspection, interactions, accessibility inspection, and viewport emulation.
2. **Reliable file overwrite and line-range editing** for deterministic large-file modifications.
3. **Persistent dev-server lifecycle management** with logs and localhost health checks.

Together, these would dramatically improve autonomous frontend delivery, reduce unverified claims, and eliminate many common implementation bottlenecks.
