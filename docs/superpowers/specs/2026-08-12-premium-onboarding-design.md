# Premium Onboarding Design

## Product intent

Morrow's first-run experience should communicate three things within seconds:
this is private software, it becomes personally useful through ordinary work,
and the user remains in control. The experience replaces a conventional setup
wizard with one calm full-viewport stage whose content changes across five
short scenes.

This surface does not replace truthful readiness. Provider and project status
come from their authoritative APIs, and users can leave the stage to complete
either setup task before returning. Users may also explore first; the existing
Home readiness checklist continues to expose unfinished prerequisites.

## Visual direction

The visual idea is **quiet intelligence**: true graphite (`#090b0f`), soft-white
editorial typography, cool gray supporting text, and one cobalt (`#2455ff`)
accent. A museum-like smoked-glass continuity sculpture surrounds a cobalt
core. It appears once as the visual anchor and changes position and opacity by
scene. There are no decorative cards, fake metrics, badges, dashboards,
sparkles, or purple cyberpunk effects.

Generated concept references:

- Desktop welcome:
  `C:/Users/aidan/.codex/generated_images/019ff6ef-a2d6-7f31-bdcd-c779d9b6a4d9/exec-b9a54d0c-a9dd-4c7b-86a2-bd5b50306308.png`
- Desktop personalization:
  `C:/Users/aidan/.codex/generated_images/019ff6ef-a2d6-7f31-bdcd-c779d9b6a4d9/exec-bb9b044d-1c26-42e9-b673-929fa0467839.png`
- Mobile welcome:
  `C:/Users/aidan/.codex/generated_images/019ff6ef-a2d6-7f31-bdcd-c779d9b6a4d9/exec-41c637f3-6d1d-4cc1-8818-b7c5f81e9963.png`
- Production sculpture source:
  `C:/Users/aidan/.codex/generated_images/019ff6ef-a2d6-7f31-bdcd-c779d9b6a4d9/exec-f6afa829-5e8a-4f32-ac75-8e9748e832e7.png`

## Scene architecture

1. **Welcome** — “Your private intelligence, ready to grow with you.” Primary
   action is **Begin**; **Explore first** permanently dismisses onboarding and
   exposes the regular app.
2. **Privacy** — three plain-language promises: local control, visible external
   data flow, and reversible memory. The user records either a **Local-first
   preference** or that configured **Cloud is available**; the copy explicitly
   states that this preference does not enforce provider routing.
3. **Personalization** — optional display name plus one of **Building
   products**, **Research & thinking**, or **Everyday work**. These values are
   persisted to onboarding state; display name and privacy mode also update the
   authoritative assistant profile.
4. **Readiness** — real connected-provider and project status. Missing setup
   has direct links to Connections and Projects. The overlay yields on those
   routes and resumes when the user returns Home. Setup is encouraged but not
   used as a lockout.
5. **Launch** — “Morrow is yours.” Completing this scene marks onboarding
   durable and reveals Home.

The server's `onboardingStep` value allows the experience to resume at the
last persisted scene after refresh or restart. Invalid legacy values fall back
to Welcome. Existing onboarded users never see the stage.

## Components and data flow

- `api/onboarding.ts` owns strict browser schemas and GET/POST calls.
- `features/onboarding/onboarding-experience.tsx` owns scene state, persistence,
  readiness projection, focus management, and rendering.
- `AppShell` mounts the experience once. It renders only on Home and only while
  the onboarding query reports `onboarded: false`.
- Existing assistant-profile, provider, and project clients remain the
  authoritative integration points. Credential values never enter onboarding
  state or React Query mutation variables.

## Interaction and motion

Each scene uses one composition rather than a nested panel. Copy and controls
enter with a 420 ms upward fade stagger. The sculpture uses a low-amplitude
12-second breathing transform. Choice selection sends a brief cobalt trace
through the row. Five bottom hairlines show progress without labels or badges.
All animation is disabled under `prefers-reduced-motion: reduce`, preserving
the exact final layout and every interaction.

The overlay is an accessible modal surface while active: focus enters the
primary action, Tab stays within the experience, background scrolling is
disabled, and all actions remain available by keyboard. Mobile reorders the
sculpture above the headline, makes the primary action full width, respects
safe areas, and keeps targets at least 44 px high.

## Error and recovery behavior

Query loading shows only the graphite canvas to prevent a configured user's
app flashing underneath. A failed onboarding query fails open to the existing
app. Failed persistence leaves the current scene in place and shows a concise
inline error; it never claims completion. Setup status can be refreshed without
reloading the page.

## Release acceptance

- Fresh install can complete or skip the five-scene experience.
- Refresh resumes the persisted scene; onboarded installs bypass it.
- Provider/project readiness is real and links to working destinations.
- Desktop and 390x844 mobile layouts match the concept direction without
  clipping, overflow, or inert controls.
- Keyboard focus, reduced motion, contrast, and error messaging are verified.
- Full tests, check, production build, package validation, and branch freshness
  pass before publication.
