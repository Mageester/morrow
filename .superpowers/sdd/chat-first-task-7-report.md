# Task 7 report — Modes and model selection

Base commit: `adfb736`. Branch `feat/morrow-web-app-foundation` (PR #64, kept open/draft/unmerged).

## Objective delivered

Added a searchable model catalogue to the chat composer. The user can choose Auto (recommended), a preset, or a specific model; the choice is sent as an explicit override that the backend already honors and freezes as routing evidence. No Task 8 (missions-in-chat) work was pulled in.

## Implementation

- **Model catalogue client** (`api/models.ts`): `modelQueries.catalogue()` over `GET /api/models` (validated `ModelStatus[]`) and `modelQueries.presets()` over `GET /api/presets` (`PresetStatus[]`). Read-only, secret-free.
- **Searchable picker** (`features/chat/model-picker.tsx`): a pure, props-driven component (no data fetching of its own). A trigger shows the current selection (default "Auto — recommended"); the panel offers a search box, an Auto option, a Presets group, and a Models group. Each model row shows provider, context window, and badges for Local / Free / Vision / Tools / Legacy / Deprecated, and an **Unavailable** flag with the reason. Escape closes; options are native buttons (`aria-pressed`), so keyboard and screen readers work without custom listbox ARIA.
- **Safe fallback**: when the saved selection's model is absent from the catalogue, the trigger keeps showing it with an Unavailable flag and the panel explains it is no longer available and that Morrow uses its recommended route until the user picks a live one.
- **Composer wiring** (`features/chat/chat-composer.tsx`): a new optional `modelCatalogue` prop. When present, the picker replaces the simple route `<select>`; the picker's selection drives the submission's `providerId`/`model` (or a `preset`, or nothing → recommended). When absent, the existing Slice 4 route-select path is unchanged, so every Slice 4 composer test stays valid.
- **Conversation integration** (`features/chat/conversation-page.tsx`): the `ConversationPage` wrapper fetches the catalogue + presets once and passes them to `ConversationPageContent`, which forwards them to the composer. `ConversationPageContent` keeps an optional prop, so the Slice 5 conversation tests (which render it without a catalogue) are unaffected.
- **Styles** (`styles/app.css`): a scoped popover — trigger, search, grouped list, option rows with 44px targets, unavailable flag, and empty state.

## Backend routing — already satisfied (no change needed)

Explicit overrides are already honored and recorded, so no routing-internals churn was warranted:
- `mission/task-dispatcher.ts` builds a routing override from `body.providerId`/`body.model` and applies `overridden: true`; the resolved `RoutingDecision` is persisted per task and reused verbatim on retry/resume (frozen decision).
- `SendMessage` carries `mode`, `autoApprove`, `preset`, `providerId`, `model`, `reasoning`; the request fingerprint includes `providerId` (and the other execution-affecting fields), so Slice 5's "idempotent across all execution-affecting fields" coverage already exercises model/provider override. The composer's mode mapping (Ask→read-only, Plan→plan-only, Build→agent, Build Auto→agent+autoApprove) is unchanged from Slice 4.

## Commands / results

- `vitest run` (web): **23 files, 192 tests passed** (adds `model-picker.test.tsx`; all Slice 4/5 composer + conversation tests unchanged and green).
- `tsc -p tsconfig.json`: clean.
- Real-browser acceptance (Chromium against a seeded `/api/models` catalogue): the picker opens in the conversation composer and lists Claude Opus / Claude Sonnet / GPT-5 / Qwen2.5-Coder (Unavailable) / DeepSeek with provider · context · modality metadata, in light and dark. Screenshots in `docs/redesign/slice7-acceptance/`. Inspected manually.

## Known limitations

- Preset rendering in the picker is implemented but unit-covered only indirectly (the isolated test uses `presets: []`); presets are exercised in the browser via `/api/presets`.
- Full keyboard arrow-key roving within the option list is not implemented; options are individually tab-focusable buttons (accessible, if more key-presses to traverse). A future a11y pass (Task 13) can add roving `tabindex`.
- Backend routing internals were intentionally not modified; the plan's routing/presets/router edits proved unnecessary because overrides are already honored and frozen (verified in code + Slice 5 tests).

## Rollback

`git revert <this commit>` removes `api/models.ts`, the picker, and the composer's `modelCatalogue` branch, restoring the Slice 6 composer. Frontend-only; no data migration.
