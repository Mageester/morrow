# Morrow Hosted Accounts — Design Gate

> Approval package for the hosted-accounts surface (`apps/dashboard`) plus the
> two new screens added to the existing local `apps/web`. This gate authorizes
> frontend implementation planning only. It does **not** authorize production
> UI implementation, Cloudflare resource creation, or Clerk/Stripe integration
> wiring — those are separate confirmed steps in
> [`Plans/generic-sprouting-dragon.md`](../../../Plans/generic-sprouting-dragon.md).

## Decision requested

Approve, reject, or request changes to this direction:

1. **The dashboard is a thin, separate surface** — account, billing, and
   device pairing only. It is not a second copy of the chat/mission product;
   `apps/web` remains the only place work happens.
2. **Five screens total.** Login, Signup, Account, Billing/plan, and Pair —
   no settings sprawl, no admin console. Free/unpaired and single-paid-tier
   are the only two states in v1 (per the confirmed plan).
3. **Pairing is a code, not a wizard.** One short code, one paste field, one
   confirmation state — mirrors how CLI tools (`npm login`, `gh auth login`)
   already teach this pattern, no new mental model.
4. **The local app gets one banner, not a settings page.** `apps/web` only
   grows a dismissible-but-persistent entitlement banner and a `/pair` entry
   screen. Everything else about the local app is unchanged.
5. **Visual language matches the existing product exactly** — same tokens
   (`packages/ui/src/styles/tokens.css`), same restrained-violet-accent,
   warm-off-white/deep-neutral theme pair already shipped. This is not a
   rebrand; a returning user should recognize it as the same product.

## Working prototype

- Prototype: [`prototypes/hosted-accounts.html`](prototypes/hosted-accounts.html)
- Static interaction prototype with realistic mock data. No live Clerk/Stripe
  calls, no real pairing code generation, no orchestrator calls.
- Screen picker: `?screen=login|signup|account|billing|pair|banner`,
  `&theme=light|dark`.

## Information architecture

| Surface | Lives in | Primary job |
|---|---|---|
| Login | `apps/dashboard` | Return access to an existing account |
| Signup | `apps/dashboard` | Create an account, start free |
| Account | `apps/dashboard` | Identity, connected local installs, sign-out |
| Billing | `apps/dashboard` | See plan, upgrade, manage payment (Stripe Portal handoff) |
| Pair | `apps/web` (new) | Redeem a pairing code from a signed-in local install |
| Entitlement banner | `apps/web` (new, global) | Honest state of pairing/subscription — never blocks local work |

No sidebar navigation in `apps/dashboard` — five screens don't need one. A
simple top bar (wordmark, account menu) is sufficient, consistent with the
"thin surface" decision above.

## Journeys

| Journey | Prototype evidence | Gate health |
|---|---|---|
| New user signs up, sees free state | `signup` → `account` (free) | No payment required to see the product exists |
| User upgrades | `billing` (free) → click Upgrade → `billing` (active) | Copy makes clear this hands off to Stripe Checkout, not an in-page form |
| User pairs a local install | `pair` (empty) → enter code → `pair` (success) | Matches the outbound-only, no-tunnel model from the plan — copy never implies remote access |
| Subscription lapses | `banner` (inactive) | Soft banner in `apps/web`, explicitly says local work is unaffected — matches the plan's "never brick a paying user's local tool" requirement |
| Never paired | `banner` (unpaired) | Distinguishes "unpaired" from "inactive subscription" — different problem, different copy |

## Visual direction

- Reuses `packages/ui` tokens verbatim (`--morrow-bg`, `--morrow-surface`,
  `--morrow-accent`, `--morrow-radius-*`, `--morrow-space-*`) — no new color
  or spacing scale introduced.
- `apps/dashboard` auth screens (login/signup) use a centered single-column
  card, consistent with the "calm, personal" direction from the existing
  `05-design-gate.md` product reset — not a split-screen marketing layout.
- Account/Billing use the same `Surface`/`StatusPill`/`Button` component
  vocabulary already exported from `@morrow/ui` (`packages/ui/src/index.ts`).
- The entitlement banner in `apps/web` reuses the existing banner/callout
  pattern already in `app.css` rather than introducing a new component.

## Preserve vs. replace

### Preserve
- All of `apps/web`'s existing chat/mission/project UI — zero changes beyond
  the banner and one new route.
- `@morrow/ui` component set and token system, unchanged.
- The local orchestrator's loopback-only trust model — the pairing screen's
  copy must never imply the dashboard can reach the local install directly.

### Add
- `apps/dashboard` as a net-new package — nothing to migrate, nothing to
  deprecate.
- One banner component and one route in `apps/web`.

## Known prototype limitations

- Static mock data; no live Clerk session, no real Stripe Checkout redirect,
  no real pairing-code generation or orchestrator round trip.
- Password reset, email verification, and Clerk's own hosted-component
  variants are not prototyped — Phase 5 will use Clerk's headless hooks
  against these visual shells, not build custom auth forms from scratch.
- Does not prototype error states for expired/invalid pairing codes beyond
  one representative "code not recognized" state.

## Exact approval checklist

Please approve or request changes to:

- the five-screen scope (login, signup, account, billing, pair) and the
  "dashboard is thin, apps/web is where work happens" split;
- the pairing-as-a-code interaction pattern;
- the entitlement-banner-not-lockout behavior in `apps/web`;
- the visual language reusing existing tokens/components with no new system.

No `apps/dashboard` implementation code, Clerk/Stripe wiring, or Cloudflare
resource creation begins until this gate is explicitly approved.

## Approval

Approved 2026-07-24. `apps/dashboard` implementation may proceed. Clerk/Stripe
wiring and real Cloudflare resource creation remain separately blocked on
credentials/confirmation per `Plans/generic-sprouting-dragon.md`.
