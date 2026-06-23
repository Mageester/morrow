---
name: config-management
version: 1.0.0
description: Configuration management audit — check env vars, config files, secrets, hardcoded values, proper defaults, and validation
riskClass: medium
publisher: Axiom
---

# Config Management Skill

## Overview
This skill provides a comprehensive audit and design framework for application configuration. It covers environment variables, configuration files, secret management, default values, validation, and the principle of least privilege for configuration access. The goal is a configuration system that is secure, predictable across environments, easy to debug, and impossible to misconfigure.

## When to Use
- Setting up a new service or application
- Auditing an existing codebase for hardcoded values
- A production incident was caused by a missing or incorrect config
- Migrating from one config system to another (dotenv → vault, config files → env vars)
- Preparing for a security review or SOC2 compliance audit
- Onboarding a service to a new deployment environment

## Step-by-Step Instructions

### Phase 1: Discovery
1. **Find all configuration sources.** Search the codebase for: `process.env`, `os.environ`, `System.getenv`, `dotenv` calls, config file reads (`.yaml`, `.json`, `.toml`, `.ini`), command-line flag parsing, and remote config fetches (Consul, etcd, AWS Parameter Store).
2. **Catalog all configuration keys.** Build a spreadsheet listing every config key, its type (string, int, bool, URL), where it's read, and where it's used.
3. **Separate secrets from non-secrets.** Secrets: database passwords, API keys, signing keys, tokens, certificates. Non-secrets: port numbers, log levels, feature flags, timeouts. They need different handling.

### Phase 2: Hardcoded Values Detection
4. **Search for magic values in code.** Look for bare strings that should be configurable: `'http://localhost:3000'`, `30 * 1000` (timeout), `'dev'` (environment), `10` (pool size). These prevent the code from running in different environments.
5. **Search for secrets in code.** Grep for patterns: `password =`, `secret =`, `api_key =`, `token =`, `-----BEGIN`, `sk-`, `ghp_`, `xoxb-`, `access_key`. These must be in a secrets manager or environment variables.
6. **Check test files for hardcoded config.** Tests should use their own config, not inherit from production or developer defaults. A test accidentally running against a production database is a disaster.

### Phase 3: Configuration Design
7. **Establish a config hierarchy.** Lower values override higher: default values < config files < environment variables < command-line flags. Document this precedence.
8. **Define required vs optional config.** Every config key should be explicitly marked as required (app won't start without it) or optional (has a sensible default). Required config should be validated at startup, not on first use.
9. **Set sensible defaults.** Defaults should work for development and testing. Production should always explicitly set all config. Never default a secret — it must be provided.
10. **Use typed configuration.** Don't use raw `process.env` scattered across the codebase. Define a central config object/schema with typed fields: `config.port: number`, `config.database.url: URL`. Parse and validate once at startup.

### Phase 4: Validation
11. **Validate at startup.** Before the server starts listening, parse all config, validate required keys are present, check types (port is an integer, URL is a valid URL), and check constraints (port between 1024-65535, timeout > 0).
12. **Fail fast on invalid config.** Throw an error listing ALL invalid config keys, not just the first one found. A developer should fix all config issues in one pass.
13. **Validate config in CI.** Add a CI step that runs the config validation against a test config. This catches schema mismatches before deployment.

### Phase 5: Secret Management
14. **Never store secrets in version control.** Not even in private repos. Not even in "example" config files. Use `.env.example` with dummy values and real secrets in a vault.
15. **Use a secrets manager for production.** HashiCorp Vault, AWS Secrets Manager, GCP Secret Manager, Azure Key Vault, or Doppler. Fetch secrets at startup, cache in memory, never log.
16. **Rotate secrets regularly.** Automate credential rotation where possible (database passwords, API keys). Document the rotation process for secrets that can't be automated.
17. **Audit secret access.** Log every access to secrets. Set alerts for unusual access patterns. Revoke unused credentials quarterly.

### Phase 6: Environment-Specific Configuration
18. **Use environment variables for environment-specific values.** `NODE_ENV`, database connection strings, API base URLs, log levels. Config files for structural config (schema, feature flags). Secrets manager for credentials.
19. **Never branch on environment in code.** `if (env === 'production') { doThing() }` is fragile. Use feature flags or config values instead. Code should behave the same regardless of environment name.
20. **Test config in every environment.** Dev, staging, and production config should be validated in CI with the same validation logic. Staging config should mirror production as closely as possible.

### Phase 7: Documentation
21. **Document every config key.** Include: name, type, required/optional, default value, valid values/ranges, and what it controls. `.env.example` is the minimum; a `CONFIG.md` or typed schema with docstrings is better.
22. **Document the config loading order.** Which sources are checked and in what order? Which overrides which?
23. **Document secret rotation procedures.** How are secrets rotated? Who has access? What's the rollback plan if rotation fails?

## Common Pitfalls
- **`process.env` scattered across hundreds of files.** Makes it impossible to know all config keys. Centralize in one config module that exports a typed object.
- **Defaulting to production config.** `const dbUrl = process.env.DB_URL || 'https://prod-db.example.com'` — if DB_URL is missing, you connect to production. The default should be development, or the key should be required.
- **Logging configuration at startup.** `console.log(config)` will print all secrets. Redact sensitive fields or use a safe serializer.
- **No validation.** A typo `DATABASE_URL` vs `DATABASE_URL` silently uses the undefined default and fails cryptically hours later. Validate at startup.
- **Committing `.env` files.** It takes one `git add .` to accidentally commit secrets. Always put `.env` in `.gitignore` and provide `.env.example` with dummy values.
- **Secrets in Docker images.** `ENV API_KEY=abc123` in a Dockerfile bakes the secret into every layer. Use build-time secrets (`--secret`) or runtime injection.

## Verification Checklist
- [ ] All configuration sources identified and cataloged
- [ ] Complete config key inventory (name, type, required/optional, default)
- [ ] Secrets separated from non-secrets — no secrets in source code
- [ ] Zero hardcoded magic values (URLs, timeouts, pool sizes, environments)
- [ ] Central config module with typed schema
- [ ] Startup validation catches missing required keys, type errors, constraint violations
- [ ] Sensible defaults for development; production requires explicit config
- [ ] Secrets stored in a secrets manager, never in version control
- [ ] `.env` in `.gitignore`; `.env.example` with dummy values committed
- [ ] Config validation runs in CI
- [ ] Config documentation complete (keys, loading order, precedence)
- [ ] Secret rotation procedures documented
