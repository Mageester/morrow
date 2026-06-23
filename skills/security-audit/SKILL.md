---
name: security-audit
version: 1.0.0
description: Comprehensive security review checking for SQL injection, XSS, CSRF, secrets exposure, unsafe deserialization, path traversal, and missing auth
riskClass: medium
publisher: Axiom
---

# Security Audit Skill

## Overview
This skill provides a structured security review process for codebases. It systematically checks for the most common and severe vulnerabilities: injection attacks (SQL, command, LDAP), cross-site scripting (XSS), cross-site request forgery (CSRF), hardcoded secrets, unsafe deserialization, path traversal, and missing authentication/authorization controls. Each check includes detection patterns and remediation steps.

## When to Use
- Before a production deployment or release
- During a security-focused code review
- When integrating third-party libraries or user-generated content handling
- After a security incident to audit related code paths
- As part of a regular security hygiene cadence (quarterly)

## Step-by-Step Instructions

### Phase 1: Reconnaissance
1. **Identify the attack surface.** Map every entry point: HTTP endpoints, WebSocket connections, file upload handlers, CLI arguments, environment variables, message queue consumers.
2. **Map data flow.** For each entry point, trace where user input flows. Identify sinks: database queries, filesystem writes, command execution, template rendering, HTTP responses, deserialization calls.
3. **Catalog authentication and authorization gates.** For each endpoint, note: is authentication required? What roles/permissions? Where is the check enforced (middleware, handler, or nowhere)?

### Phase 2: Injection Vulnerabilities
4. **SQL injection check.** Search for string concatenation, interpolation, or format strings in SQL queries (`"SELECT * FROM users WHERE id = " + userId`, `f"SELECT * FROM users WHERE id = {userId}"`). Verify every query uses parameterized statements or an ORM with proper escaping.
5. **Command injection check.** Search for `exec()`, `system()`, `popen()`, `subprocess.run()` with user-supplied arguments. Never pass unsanitized input to shell commands. Use argument arrays, not string commands.
6. **LDAP/OS/XML injection.** If applicable, check LDAP filters, XPath expressions, and XML parsers. Disable external entity processing in XML parsers.

### Phase 3: Cross-Site Vulnerabilities
7. **XSS check.** In template files, search for unescaped user input (`{{{variable}}}` in Handlebars, `dangerouslySetInnerHTML` in React, `|safe` in Django, `<%=` in EJS). Every user-supplied value rendered in HTML must be context-escaped.
8. **CSRF check.** Verify every state-changing request (POST, PUT, DELETE, PATCH) requires a CSRF token if using cookie-based auth. Check that the token is validated per-request and not reusable.

### Phase 4: Secrets and Configuration
9. **Hardcoded secrets.** Search for patterns matching API keys, passwords, tokens, private keys: strings containing `secret`, `password`, `api_key`, `token`, `-----BEGIN`, `sk-`, `ghp_`, `xoxb-`. None of these should be in source code.
10. **Configuration leaks.** Check error pages, debug endpoints, and `/metrics` endpoints for internal IP addresses, stack traces, framework versions, or database connection strings.

### Phase 5: Deserialization and File Safety
11. **Unsafe deserialization.** Search for `pickle.loads()`, `yaml.load()` (not `yaml.safe_load()`), `jsonpickle`, `eval()`, `Function()` constructor with user data. Only deserialize from trusted sources, and prefer safe parsers.
12. **Path traversal.** Search for file operations using user input: `fs.readFile(req.params.file)`, `open(userProvidedPath)`. Validate paths against an allowlist and resolve to a safe base directory using `path.resolve()` with a check that the result starts with the base.

### Phase 6: Auth and Session
13. **Missing auth checks.** For every endpoint identified in Phase 1, verify an auth middleware runs BEFORE the handler. Check that internal/utility endpoints aren't accidentally public.
14. **Session security.** Check that session cookies have `HttpOnly`, `Secure`, and `SameSite=Strict` flags. Verify session IDs are regenerated after login.

## Common Pitfalls
- **Relying on client-side validation only.** Client-side validation is a UX convenience, not a security control. Always validate on the server.
- **Blocklist instead of allowlist.** When sanitizing input, define what IS allowed, not what is NOT. Blocklists are always incomplete.
- **Assuming the ORM prevents all injection.** ORMs can still be vulnerable to injection in raw queries, dynamic order-by clauses, or `LIKE` patterns.
- **Forgetting internal APIs.** Internal microservice endpoints often skip auth "because they're not exposed." Network segmentation can fail; always authenticate.
- **Checking only obvious secret patterns.** Secrets can be base64-encoded, split across multiple variables, or stored in comments.

## Verification Checklist
- [ ] Attack surface mapped (all entry points and sinks)
- [ ] SQL queries use parameterized statements (no string concatenation)
- [ ] Command execution uses argument arrays, not shell strings
- [ ] HTML templates context-escape all user input
- [ ] State-changing endpoints require CSRF tokens (cookie auth)
- [ ] Zero hardcoded secrets in source code
- [ ] Deserialization uses safe parsers from trusted sources only
- [ ] File operations validate paths against an allowlist
- [ ] Every endpoint has authentication middleware (where required)
- [ ] Session cookies set HttpOnly, Secure, SameSite
- [ ] Error pages and debug endpoints don't leak internal details
