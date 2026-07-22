# Chat-first Task 4 independent review

Range: `f8d2168..19604d4`

## Round 1 — Needs fixes

- Draft scope keys could collide.
- Scope changes could save old DOM text under a new conversation.
- Home mission completion could clear the wrong project draft.
- Async success/rejection focus restoration was incomplete.
- Enter could submit while a live task exposed only Stop.
- IME compatibility omitted key code 229.
- Browser tests exercised the legacy mission textarea instead of `ChatComposer`.

## Round 2 — Needs fixes

- Prior lifecycle/security findings were fixed with V2 tuple keys, committed scope ownership, scope-owned outcomes, focus/selection recovery, active-task gating, IME 229 handling, and a direct production-component harness.
- Home still used a passive committed-project boundary with a render-to-effect race.
- Mobile evidence used a desktop project, allowed 40px targets, and did not exercise reduced-height/safe-area behavior.
- Dedicated composer E2E was not part of the default package gate; report contained superseded V1 claims.

## Final verdict — Approved

- Spec compliance: **approved**.
- Task quality and privacy/security: **approved**.
- Critical findings: **0 open**.
- Important findings: **0 open**.
- Mobile/touch coverage uses Android UA, `isMobile`, `hasTouch`, DPR 2.75, 44px targets, tap interactions, reduced 390×500 viewport, internal scrolling, no horizontal overflow, and exact safe-area CSS. Physical nonzero safe-area inset cannot be emulated in Windows headless Chromium and remains an honest bounded limitation.
- Default E2E now always runs production and composer suites. Composer passed 5/5. Production suite has one unrelated existing mobile result snapshot mismatch: expected height 2221px, stable actual 2197px; Task 4 does not touch that route/data/baseline and its CSS is scoped to `.morrow-chat-composer`.

