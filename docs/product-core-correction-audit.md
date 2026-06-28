# Morrow Product-Core Correction Audit

Captured: 2026-06-28

## Reference

- Local Hermes install: `C:\Users\aidan\AppData\Local\hermes\hermes-agent`
- Hermes CLI checked with `hermes --help`, `hermes chat --help`, `hermes model --help`, and `hermes sessions --help`.
- Existing Morrow parity docs reviewed: `docs/HERMES_PARITY_MATRIX.md`, `docs/hermes-parity.md`, `docs/product-vision.md`, `docs/architecture.md`, `docs/design-principles.md`.

## Hermes Vs Morrow

| Area | Hermes behavior | Morrow before correction | Correction target |
|---|---|---|---|
| Entry point | CLI/TUI opens directly into agent work, with `chat`, `model`, `sessions`, resume, TUI, and setup verbs. | Web default emphasized chat and many admin panels. CLI had `ask`, `plan`, `fix`, `yolo`, but no primary `agent` verb. | Default web and CLI lead with Ask, Plan, Agent, model choice, sessions, and visible runs. |
| Model choice | `hermes model` is explicit and provider-aware. | `/model` palette used available status, but backend accepted impossible model/provider pairs. | Provider-backed model list; explicit unavailable models are rejected before task creation. |
| Execution visibility | TUI streams plan, tool output, status, and session state in the main surface. | Plan/tool/evidence lived mostly in a side inspector, so normal use felt like chat. | Active run surface appears in project conversation: mode, status, plan, tool count, evidence, events, routing, fallback. |
| Modes | Command surface makes session intent explicit. | Mode existed in composer state and slash commands, but default UI still said "Message Morrow". | Ask, Plan, Agent become visible segmented controls and are sent as contract-correct request modes. |
| Skills | Skills are available through commands and loaded when needed. | Initial eager skill loading was already removed; skill/admin views remained prominent. | Lazy skill loading preserved; skills moved to advanced navigation; `/help` remains useful without skills. |
| Agents | Delegation is part of agent behavior. | Manual agent management was primary navigation. | Agent Studio remains available under Advanced; normal workflow starts from mission/run intent. |
| CLI | Rich command help, session resume, model selection, setup and diagnostics. | Friendly CLI existed, but agent execution was named `fix`. | `morrow agent` is first-class; `fix` remains compatibility alias. |

## Manual Surfaces

| Surface | Action | Reason |
|---|---|---|
| Agents panel | Hide under Advanced as Agent Studio. | Normal users should not have to manually build agent teams before asking for work. |
| Skills Control Center | Hide under Advanced and lazy-load. | Skills are runtime capabilities, not first-run product chrome. |
| System Health | Hide under Advanced. | Useful for diagnostics, distracting as primary IA. |
| Browser, Files, Memory | Keep contextual/advanced. | These are evidence and inspector surfaces, not top-level default workflows. |
| Approvals | Keep advanced/contextual. | Approval waits should surface inside active runs. |
| Model registry | Keep in Settings, but provider-backed. | Model choice matters; stale static ids must not be selectable silently. |

## Chatbot Root Cause

Morrow already had an `agent_chat` backend and plan/tool persistence, but the default product path hid that agency:

1. The main project surface used chat vocabulary and placeholder copy.
2. Ask/Plan/Agent intent was mostly available through slash commands, not visible product controls.
3. Active plan, tool calls, routing, evidence, and verification were mostly in the right inspector.
4. Manual internal surfaces were primary navigation, making Morrow feel like an admin dashboard around a chatbot.
5. Backend routing allowed explicit model ids to be applied after provider selection, so user intent could silently become a mismatched provider/model request.

## Acceptance Criteria

- Ask sends `mode: "read-only"` and never requests auto-approve.
- Plan sends `mode: "plan-only"` and exposes no write/execute tools.
- Agent sends `mode: "agent"` and shows live execution state in the main project view.
- Explicit provider/model overrides are included in message requests.
- Explicit unavailable provider/model combinations return a visible error before task creation.
- Preset fallback remains allowed only for non-explicit routing and records fallback metadata.
- `/help` opens useful commands even when skill loading fails.
- Slash palette keeps predictive filtering, keyboard navigation, mouse selection, outside-click dismissal, Escape, Enter, Tab, arrow keys, and deleting `/`.
- Skills stay lazy-loaded; app startup does not call `/api/skills`.
- Default navigation focuses on Missions, Active Runs, Settings, and Help/Advanced.
- CLI exposes `morrow ask`, `morrow plan`, `morrow agent`, `morrow model`, `morrow resume`, `morrow sessions`, and `morrow doctor`.
