# Public install-site pipeline

The production install domain is built from a separate repository:

- Repository: `github.com/Mageester/morrow-axiom-site`
- Production branch: `main`
- Build: `npm run build`
- Output: `dist/`
- Hosting: Cloudflare Pages with GitHub-push production deployments

The site repository vendors four security-sensitive public files:

- `public/install.ps1`
- `public/install.sh`
- `public/install.sh.sha256`
- `public/releases/latest.json`

`scripts/sync-install-assets.mjs` in that repository is the only supported way
to update them. It reads installer sources from `Mageester/morrow`, normalizes
PowerShell to CRLF and POSIX shell to LF, hashes the exact normalized
`install.sh` bytes, and enriches the release manifest with the commit resolved
from the published tag.

The site's `Sync Morrow Install Assets` workflow checks for drift every 15
minutes. Its read-only job performs the sync, production build, and full
Playwright install-contract suite. Only verified, allowlisted public assets are
passed to a separate write-scoped job; dependency and test code never receives
repository write credentials. A changed `main` branch then deploys through the
existing Cloudflare Pages Git integration.

Morrow independently runs `Verify Public Install Contract` hourly. The verifier
compares the live installer with the latest released tag, checks the published
SHA-256 against the exact served bytes, and confirms that the public manifest's
version and commit match the resolved tag.

## Manual verification

From the Morrow repository:

```bash
node scripts/verify-public-install.mjs
```

From the site repository:

```bash
node scripts/sync-install-assets.mjs --check --ref vVERSION
npm run build
npx playwright test tests/install-assets.spec.ts
```

Cloudflare configuration is intentionally not changed by either workflow. The
reviewable GitHub repositories remain the source of installer and deployment
truth.
