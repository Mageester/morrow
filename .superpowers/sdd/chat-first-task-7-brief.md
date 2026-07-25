# Task 7 brief — Modes and model selection

Base commit: `adfb736` (Slice 6). Branch `feat/morrow-web-app-foundation` (PR #64, open/draft/unmerged).

## Objective

Give the chat composer a real, searchable model catalogue so the user can pick Auto (recommended), a preset, or a specific model, and have that choice honored truthfully on send. Keep the selection stable per conversation and record intentional routing changes. Do not implement Task 8 missions-in-chat.

## Required behavior

- A searchable model picker in the composer showing, per option: availability, provider, context window, modalities, capability, price/free state, and stale/lifecycle status. Presets and an Auto (recommended) default are offered.
- Safe fallback: a saved selection whose model has disappeared from the catalogue stays visible and is flagged, and the user can pick a live one; Morrow uses its recommended route until they do.
- The chosen model/provider is sent as an explicit override and honored by the backend across quick chat, persistent chat, mission dispatch, and retry; intentional changes are recorded as routing evidence.
- Never expose credentials; the catalogue projection carries no secrets.

## Constraints

- Smallest coherent change; reuse existing contracts, model catalogue routes, and the composer. Do not weaken Slice 1–6 boundaries.
- Commit locally with a Conventional Commit; push; keep PR #64 open/draft/unmerged.
