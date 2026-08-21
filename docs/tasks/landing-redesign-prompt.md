# Landing site redesign — prompt for Morrow

Paste the block below into `morrow`.

---

The website at https://morrowproject.getaxiom.ca is embarrassing and I want it
gone. Source is `apps/landing`. Rebuild it.

Go look at https://x.ai/bot first. Scroll the whole thing, hover everything,
trigger every animation, drag it down to phone width. That is the bar. Do not
come back to me with something that would look amateur next to it.

Now understand why ours is garbage, because if you miss this you will just
reshuffle the same mess: the entire site is one 253-line `App.tsx` where every
single rule is an inline `style={{}}` object. Inline styles cannot do hover.
Cannot do focus. Cannot do media queries. Cannot do keyframes. Cannot do
scroll-linked motion. The page is flat and dead and unresponsive because it was
built in a way that made all of those impossible. Rip that out. Real
stylesheets, real design tokens for colour and type scale and spacing and
easing, one component per section. No new runtime dependency unless you can
defend it to me.

Then make it move. Real motion, timed properly, triggered on scroll and
interaction — not a fade-in slapped on a div so you can claim it animates.
Honour `prefers-reduced-motion` and do not shift layout or block first paint.

The copy is limp. Rewrite it hard and short. Every claim gets checked against
`README.md` and `docs/` — invent one capability Morrow does not have and the
whole thing is worthless to me. Keep the substance that is there: what Morrow
does, why Morrow, download, one-command install, advanced setup, early-access
warning, footer. Keep the release-manifest fetch and its error state working.

Fix `index.html` while you are in it. `og:url` points at `https://morrow.ai`,
which is not our domain, and there is no `og:image` at all. Real Open Graph and
Twitter cards, real domain.

Non-negotiable: works down to 360px, keyboard navigable, visible focus, AA
contrast, `base: './'` stays in `vite.config.ts` or the deploy breaks, and it
loads instantly — no heavy images, no web fonts you cannot justify.

Do not tell me it is done until you have run it, opened it in the browser
yourself, and screenshotted desktop, tablet, and 360px. Clean console.
`pnpm --filter @morrow/landing build` passes. Then put your screenshots next to
x.ai/bot and tell me straight where you came up short — I will find it anyway,
so do not waste my time pretending it is perfect.

Branch. Do not push, do not deploy. I review first.
