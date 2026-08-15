# Design QA

Release candidate: premium product UI refresh

- Target flow: move through every primary route, choose a model on Home, start or resume a conversation, and operate chat reasoning controls without visual or interaction regressions.
- Desktop evidence: Home, chat, Projects, Memory, Skills, History, Connections, and Settings captured at 1600 x 1000.
- Mobile evidence: Home and chat captured at 390 x 844.
- Interaction evidence: the custom Home model picker opened, accepted a different provider/model, and reflected the chosen route in its trigger.
- Runtime evidence: all captured routes rendered without horizontal overflow, page errors, or console errors.
- Accessibility evidence: WCAG 2 A/AA axe sweep, keyboard focus sweep, and reduced-motion sweep passed across ten product routes.
- Mismatch ledger: no remaining P0, P1, or P2 visual defects. The intentionally floating chat composer remains anchored above the mobile navigation so controls stay reachable during long-running work.

final result: passed
