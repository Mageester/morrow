# Premium chat recovery design

## Objective

Restore the conversation workspace to the approved premium Morrow direction while fixing the live approval deadlock: a pending approval must always be visible, keyboard reachable, and clickable above the composer.

## Interaction design

- The transcript is the primary surface. The composer anchors at the bottom without covering transcript content; the scrollable transcript receives enough bottom clearance for the composer at every supported viewport.
- Pending approvals are urgent, in-flow decision cards. They appear immediately above the composer, use a clear action hierarchy, and remain visible above the composer stacking context.
- The composer uses a quiet writing surface: message field first, a compact mode/model row second, and a deliberately separated reasoning/detail row. Supporting text is concise and never competes with the input.
- The web surface names the current permission posture accurately. `Trusted workspace` remains scoped to auto-approvable workspace actions; it must not claim to be unrestricted autonomy. A future web YOLO control is separate product work because it changes an execution permission boundary.

## Visual system

- Reuse the existing editorial type scale, deep charcoal surfaces, copper emphasis, fine borders, restrained glow, and dense-but-breathable spacing from the premium reference pack.
- Remove redundant visual containers and control density where they make the composer appear like a prototype toolbar.
- Preserve desktop three-column conversation workspaces and make the mobile conversation a clear, single-column chronology without horizontal overflow.

## Verification

- Add regression coverage proving a pending approval renders above the composer in DOM order and remains keyboard reachable.
- Add focused component coverage for the revised composer hierarchy and truthful permission copy.
- Render the conversation at desktop and mobile viewports, verify the approval action is clickable, inspect console health, and check that no meaningful empty-state text is obscured by the composer.
