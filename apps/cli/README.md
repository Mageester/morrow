# Morrow CLI

`@morrow/cli` is Morrow's local terminal client. It starts or connects to the same orchestrator, SQLite database, provider registry, conversations, routing presets, read-only tools, evidence, audit, and memory used by the web product. It does not maintain a separate runtime or provider database.

## Local development (PowerShell)

```powershell
pnpm install --frozen-lockfile
pnpm setup
```

Restart PowerShell, then:

```powershell
cd apps\cli
pnpm link
morrow --version
morrow doctor
```

If dependencies change locally, refresh the lockfile first with `pnpm install --no-frozen-lockfile`, then rerun the frozen install command.

## First run

```powershell
morrow onboard
morrow providers configure openai
morrow models select
morrow presets select Coding
morrow
```

`morrow serve --detach` starts a background local orchestrator. `morrow status`, `morrow doctor`, and `morrow logs` report its actual health, diagnostics, and log file. Most API-backed commands auto-start a local service unless `service.baseUrl` points to an external service.

## Configuration and secrets

Non-secret configuration uses `config.json` in `MORROW_HOME` (default: `~/.morrow`) and optional `.morrow/cli.json` in a workspace. Precedence is CLI flags, project config, user config, environment, then defaults. `morrow config list` never prints secret values.

Provider credentials are stored only in Morrow's dedicated `secrets.env` file under `MORROW_HOME`, with best-effort owner-only permissions. The CLI never reads a repository `.env`, browser cookies, session tokens, or another application's credentials.

## Machine mode

Use `--json --no-color --quiet` for scripts. JSON is emitted to stdout; diagnostics use stderr. Example:

```powershell
morrow run "Explain this repository" --project . --preset Coding --json --no-color
```

## Safety boundaries

Tools remain read-only and workspace-contained. Files under `.morrow`, `.env` files, keys, tokens, credentials, and secret-like paths are denied by the orchestrator. Provider tests run server-side and return only normalized status, endpoint host, and sampled model names — never authorization headers or keys.
