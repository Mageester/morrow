# Redesign — chat-first execution transcript

Design deliverables for the chat-first redesign. **Nothing here is wired into
`apps/web`.** These are prototypes for review; the production frontend is not
touched until the design is explicitly approved.

## Prototypes

| File | What it shows |
| --- | --- |
| [`execution-transcript.html`](execution-transcript.html) | The primary task screen at 1440×900 — sidebar, ordered transcript, inspector, composer. |

Open directly in a browser. Self-contained: no build step, no network requests,
no external fonts.

## The thesis

A task is **one ordered execution story**, told top to bottom in the order it
actually happened:

```
request → objective → acceptance criteria → plan → actions → file changes → verification → result
```

Everything else in the screen serves that ordering. The right inspector
summarizes the transcript; it never replaces it. File edits appear at the point
in the sequence where they happened, never relocated to a separate "changes"
view. Repeated failures collapse into one grouped event rather than flooding
the sequence.

## Structure

- **Left (236px)** — wordmark, New Task, projects, recent conversations.
- **Centre (fluid)** — three grid rows: sticky header, scrolling transcript,
  composer. The composer owns a row, so it cannot overlap transcript content;
  that is a layout guarantee rather than a z-index arrangement.
- **Right (300px)** — Plan / Changes / Evidence tabs. Rows scroll the
  transcript to the step they describe.

The numbered rail (01–05) is load-bearing: it exists because the content
genuinely is a sequence, and the number is how a reader re-finds a step
referenced from the inspector.

## Tokens

Defined as custom properties at the top of the prototype.

- **Ground** — near-black neutrals biased cool toward the accent
  (`#0B0C10` → `#171A23`) so the greys read as chosen rather than default.
- **Accent** — a single restrained iris (`#7C6BF5`), spent only on *current
  state* and the primary action.
- **Semantic** — pass `#3FB950`, pending `#D2A24C`, fail `#F0616D`. Deliberately
  separate from the accent, so "where you are" is never confused with "how it
  went".
- **Type** — platform UI stack for prose; monospace for everything the agent
  measures (step numerals, paths, timings, counts, diffs), with
  `tabular-nums` wherever digits align. No webfont is linked: the artifact CSP
  blocks font CDNs and a silent fallback is worse than a deliberate stack.

The app screen commits to dark as the product's identity. Only the surrounding
page chrome answers the viewer's light/dark preference, so the mockup is never
shown as a washed-out inversion of itself.

## Known deviation from the brief

The brief specified the Plan panel read "4 of 5 steps complete". Step 04 is
`Active` and 01–03 are the completed ones, so that string would contradict the
timeline directly beside it — the ambiguous-progress failure the brief asks to
avoid. The panel instead shows `Step 4 / 5` as the pointer with an honest
breakdown beneath: `3 complete · 1 running · 1 pending`.

## Still to prototype

The ordering design has only been tested against the healthy path. The states
that stress it are not yet drawn:

- a failed step, with error and recovery in sequence
- the criteria-approval gate (`awaiting_criteria_approval`) before execution
- no-provider recovery
- a hard-failure group, distinct from the retry group already shown
