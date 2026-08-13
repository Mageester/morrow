# Morrow Premium UI Reference

This directory is the visual handoff contract for the approved August 13, 2026 Morrow redesign. It is deliberately separate from `docs/redesign/prototypes/`, which captures an older visual direction.

## Source-of-truth order

1. `shots/*.png` defines the intended rendered appearance at the recorded viewport.
2. `reference.css` defines measurable tokens, dimensions, surfaces, typography, and responsive transformations.
3. `reference.js` defines content hierarchy and screen composition.
4. `MOTION_AND_RESPONSIVE.md` defines behavior that a still image cannot show.
5. `ACCEPTANCE.md` defines the implementation gate.

If prose and a screenshot conflict, match the screenshot. If the screenshot does not reveal a measurement, inspect the CSS. Do not treat these files as general inspiration.

## Screen and route mapping

| Reference | Production route | Screenshot |
|---|---|---|
| `?screen=home` | `/app` | `shots/home-desktop.png`, `shots/home-mobile.png` |
| `?screen=chat` | `/app/chats/:conversationId` | `shots/chat-desktop.png`, `shots/chat-mobile.png` |
| `?screen=projects` | `/app/projects` | `shots/projects-desktop.png` |
| `?screen=memory` | `/app/memory` | `shots/memory-desktop.png` |
| `?screen=skills` | `/app/skills` | `shots/skills-desktop.png` |
| `?screen=history` | `/app/chats` | `shots/history-desktop.png` |
| `?screen=connections` | `/app/connections` | `shots/connections-desktop.png` |
| `?screen=settings` | `/app/settings` | `shots/settings-desktop.png` |

Missions, Teams, pairing, onboarding, empty states, failures, approvals, recovery, and dialogs inherit the same tokens and component hierarchy but must preserve their existing behavior. They require production-state verification even when no dedicated static screenshot exists here.

## Viewing

Open `index.html?screen=home` directly in a browser. Replace `home` with any screen name from the table.

Regenerate deterministic screenshots from the repository root:

```powershell
node docs/redesign/premium-reference/capture.mjs
```

The command writes `shots/manifest.json` and exits nonzero on console errors, page errors, empty output, or horizontal overflow.

## Prototype limits

- Static representative content only; it does not replace production APIs or state.
- Buttons demonstrate hierarchy and states, not completed workflows.
- Desktop screenshots are 1600 by 1000. Mobile screenshots are 390 by 844.
- The reference intentionally uses system fonts so it remains offline and inspectable. Production may bundle an approved metrically compatible serif and sans, but must re-baseline screenshots if glyph metrics change.
