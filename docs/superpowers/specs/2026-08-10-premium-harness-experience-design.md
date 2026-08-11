# Premium Harness Experience Design

**Date:** 2026-08-10  
**Status:** Approved direction; implementation-ready  
**Scope:** Existing local Morrow web conversation surface plus a bounded model-efficiency evidence pass

## Intent

Morrow should feel like the Porsche of agent harnesses: quiet confidence, precise controls, high-quality materials, and immediate feedback. Premium means every visible response has a purpose. It does not mean gradients everywhere, decorative motion, glassmorphism, or a second state machine in the browser.

The work is split into two independently testable slices:

1. **Experience slice:** make the existing conversation surface feel tactile, polished, and fast while preserving its current information architecture and accessibility behavior.
2. **Efficiency slice:** measure and improve the model-facing path so Morrow can reduce avoidable provider work, context waste, and recovery amplification. No superiority claim is allowed without comparable task records.

## Current problem

The current app has the correct controls but they read as plain HTML grouped inside a dark panel. The reasoning control exposes capability-aware values but the track, thumb, labels, and selected state do not form a coherent interaction. Model selection, mode changes, navigation, and streaming states use inconsistent feedback. Existing reasoning disclosure has a useful chronological rail, but its open/streaming states need a clearer sense of progression and a stronger relationship to the active work.

The runtime already carries model capability metadata, context limits, reasoning configuration, provider routing, and durable activity records. The first pass should reuse those seams rather than inventing browser-only estimates or a parallel telemetry system.

## Design direction

### Visual character

- Dark graphite surfaces with the existing clay accent, restrained contrast steps, and no new decorative color family.
- Strong hierarchy through spacing, type weight, and alignment rather than cards nested inside cards.
- Controls should feel machined: clear edges, small deliberate highlights, consistent radii, and no oversized pill treatment except for compact status labels already present in the product.
- The active state is communicated by one clear accent signal: edge, track fill, marker, or text—not multiple competing glows.
- Keep the existing sidebar, project context, conversation timeline, activity inspector, and progressive disclosure model.

### Motion language

Motion is functional feedback, not decoration.

- Control feedback: 120–180ms, using opacity, color, border, and transform only.
- State transitions: 240–380ms, using a decelerating ease-out curve.
- Streaming/progress: one restrained pulse or shimmer only where work is actively changing; no idle looping animation.
- Reasoning slider: animate the fill and visual thumb state when the value changes; enlarge the focus ring slightly on pointer/keyboard focus; update the visible value with a short crossfade or transform rather than a jump.
- Composer focus: a shallow border/halo response that makes the input feel available without lifting the entire panel.
- Model picker: the panel should enter/exit with a short opacity/translate transition and preserve focus and keyboard behavior.
- Reasoning entries: new steps should reveal with a small rail/marker transition; expanding content should use a bounded height/opacity transition that does not animate the entire transcript.
- Buttons: hover and pressed states should have visible but small movement/contrast changes. Send and stop should distinguish ready, busy, and disabled states without changing layout.
- Respect `prefers-reduced-motion`; reduced motion removes transforms, keyframes, and smooth scrolling while retaining state/color changes and accessible focus.

### Component behavior

#### Composer

- Keep Build/Chat, Trusted workspace, model, reasoning, reasoning disclosure, context meter, and send/stop controls in the current progressive-disclosure structure.
- Make the selected model and reasoning state visually legible at a glance without adding a permanent settings panel.
- The reasoning slider remains capability-driven. It is disabled only when the selected route cannot expose adjustable effort/budget, with a truthful explanation.
- Slider keyboard semantics remain native: arrow/home/end changes the same normalized configuration as pointer interaction.
- The send control remains a real submit button and must not be replaced by animation-only affordances.

#### Model picker

- Keep connected models first and unavailable providers collapsed.
- Add a clear selected marker and a small transition when the route changes.
- Preserve the current honest context/capability badges; do not invent latency, cost, or availability claims.
- Opening and closing must not cause page scroll or lose the search field focus.

#### Reasoning disclosure

- Preserve provider-supplied-only semantics and the opt-in request behavior.
- Keep chronological step ordering, latest-step auto-open, follow-latest scrolling, and the jump-to-latest affordance.
- Strengthen active/latest styling through marker and rail motion, not through constant animation.
- Keep raw reasoning out of ordinary browser payloads unless the user has opted into the disclosure.

#### Shell and activity

- Give nav links, action buttons, activity rows, and status indicators a consistent interaction vocabulary.
- Animate only elements that change state. Do not add route-wide page transitions that delay navigation or interfere with assistive technology.
- Use existing activity and transcript records as the source for progress; do not create client-authored fake progress.

## Efficiency design

Morrow's model-efficiency work is evidence-first. The existing standalone harness-economics artifact remains outside the product runtime and accepts explicit task records.

For a bounded live pass, collect one record per task with:

- harness and exact model/provider
- task fixture and pass definition
- wall-clock duration
- provider input, cached-input, and output tokens when available
- measured or explicitly estimated cost
- provider-call count and tool-call count
- repeated observation/retry count
- context compaction/recovery count
- user interventions and final outcome

The same task set, provider/model class, machine, permissions, and pass definition must be used for each compared harness. The run is serialized and capped at the user's remaining API budget. Existing deterministic suites run first; a live run is skipped when the provider route or credentials are unavailable rather than silently substituting a fake result.

The first high-leverage optimization targets are:

1. avoid duplicate read-only observations and replayed completed-write markers;
2. preserve compacted context without recursively re-sending stale narration;
3. make tool-bearing turns provisional and stop reasoning-only retry amplification at the owning completion boundary;
4. route to the selected model's verified context/reasoning capabilities without hidden fallback requests;
5. expose enough durable usage evidence to explain cost and latency without adding telemetry or external services.

These targets build on the current provider projection, context manager, reasoning translator, and recovery boundaries. Any optimization must retain approvals, permission checks, local-first behavior, and honest failure states.

## Performance and accessibility constraints

- Prefer CSS transforms/opacity and composited pseudo-elements over layout animation.
- Do not add a dependency for motion; use existing CSS and React state boundaries.
- Keep long activity and reasoning lists virtualizable/content-visible where already supported.
- Avoid new per-frame React state updates. Slider drag feedback remains native and visual state updates are discrete by option.
- Preserve minimum touch targets and visible keyboard focus.
- Verify desktop and mobile layouts, including composer wrapping and picker viewport containment.
- Verify no console errors/warnings on the target flow.

## Verification

### Experience acceptance

1. A fresh conversation renders with no blank shell or framework overlay.
2. Selecting DeepSeek V4 Pro or Flash exposes the correct capability-aware reasoning options and updates the normalized selected value.
3. Selecting a different reasoning level visibly animates the track/thumb state without changing the control's geometry or losing focus.
4. Build/Chat, Trusted workspace, model picker, reasoning disclosure, send/stop, and activity controls retain real state transitions and accessible names.
5. Reasoning entries animate only when they are revealed or updated; reduced-motion mode removes motion while retaining the same information.
6. Desktop and mobile screenshots show no clipping, overflow, accidental wrapping, or unreadable labels.
7. Web unit tests, type checks, build, and browser QA pass.

### Efficiency acceptance

1. Deterministic tests cover every new efficiency invariant before any provider call.
2. The benchmark record preserves missing-cost/missing-usage honesty and never fabricates a provider measurement.
3. Any live result includes the exact task set, model, provider, route, costs, durations, calls, interventions, and limitations.
4. Morrow is only described as more efficient when the same-task comparison supports that conclusion; otherwise the result is reported as inconclusive.
5. No credentials, provider tokens, telemetry, external hosted dependencies, or append-only campaign evidence are modified by the benchmark.

## Out of scope

- Replacing the product's visual language with a marketing site or a dashboard.
- Adding a hosted analytics system, client telemetry, or browser-visible provider credentials.
- Rewriting the protected prototype surfaces or rebuilding the conversation page architecture.
- Claiming Hermes superiority from a single live run or from deterministic tests alone.
- Adding new model providers, broad tool permissions, or unrelated feature areas.
