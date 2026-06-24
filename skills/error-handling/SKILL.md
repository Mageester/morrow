---
name: error-handling
version: 1.0.0
description: Error handling audit — check for properly caught, logged, and surfaced errors; find swallowed errors, missing try/catch, and unhandled promise rejections
riskClass: medium
publisher: Axiom
---

# Error Handling Skill

## Overview
This skill provides a systematic audit of error handling across a codebase. It checks that errors are properly caught, logged with context, surfaced to the right layer, and never silently swallowed. It covers synchronous exceptions, asynchronous promise rejections, error propagation chains, and error response formatting. The goal is a codebase where failures are visible, debuggable, and recoverable.

## When to Use
- A production incident revealed a silently swallowed error
- A new module is being code reviewed for robustness
- You are hardening a service before launch
- Users report "it just doesn't work" with no error message
- Logs are missing critical context during debugging
- You are auditing code quality across a codebase

## Step-by-Step Instructions

### Phase 1: Discovery
1. **Identify all async boundaries.** Search for `async function`, `.then()`, `Promise`, `async/await`, callbacks, event emitters, and stream pipelines. Each is a point where errors can be lost.
2. **Identify all try/catch blocks.** Search for `try {` across the codebase. For each, check whether the catch block actually handles the error or just swallows it.
3. **Identify all error-throwing code.** Search for `throw new`, `reject()`, `callback(err)`, `next(err)` (Express). These are the sources. Trace where they flow.
4. **Map database and external call sites.** Every database query, HTTP request, file read, and RPC call can fail. List them and verify each has error handling.

### Phase 2: Swallowed Error Detection
5. **Flag empty catch blocks.** `try { ... } catch (e) {}` is a critical bug. If an error is truly expected and ignorable, add a comment explaining why and log it at debug level.
6. **Flag catch blocks that only log.** `catch (e) { console.log(e) }` doesn't propagate the error to the caller, doesn't include request context, and doesn't alert anyone. Either re-throw, return an error result, or ensure the caller knows about the failure.
7. **Flag unhandled promise rejections.** Search for promises without `.catch()` and async functions called without `await` or `.catch()`. In Node.js, unhandled rejections crash the process by default.
8. **Flag fire-and-forget async calls.** `doSomethingAsync()` without `await` or `.catch()` — the promise is created but its resolution (including errors) is ignored.

### Phase 3: Error Context and Logging
9. **Verify error logs include context.** An error log should include: what operation failed, what inputs were involved (redact secrets), a correlation/request ID, and the stack trace. `logger.error('failed')` is useless.
10. **Check for wrapped errors.** Use error wrapping to preserve the causal chain: `throw new Error(`Failed to save user: ${originalError.message}`, { cause: originalError })`. Don't lose the original stack trace.
11. **Verify structured logging.** Errors should be logged as objects, not string interpolation. `logger.error({ err, userId, requestId }, 'Order creation failed')` not `logger.error('Order creation failed: ' + err)`.

### Phase 4: Error Surface and Recovery
12. **Define error types.** Create custom error classes: `ValidationError`, `NotFoundError`, `UnauthorizedError`, `DatabaseError`, `ExternalServiceError`. This lets handlers respond differently based on error type.
13. **Check error responses to clients.** API errors should return consistent JSON with error codes, never raw stack traces. The `error.code` should be machine-readable. The `error.message` should be safe to show users.
14. **Verify retry logic.** For transient failures (network timeouts, database deadlocks), implement exponential backoff with jitter. Never retry on validation errors (guaranteed to fail again).
15. **Check for graceful degradation.** When a non-critical dependency fails (analytics, logging, cache), the main operation should still succeed. Use fallback values or skip the non-critical step.

### Phase 5: Testing
16. **Write tests for error paths.** For every function, write a test that triggers each possible error and verifies it's handled correctly. The error path tests are often more important than the happy path tests.
17. **Test error response format.** Verify that error responses match the API contract and don't leak internals.
18. **Test retry and timeout behavior.** Use fault injection (e.g., Toxiproxy, Chaos Monkey) to verify your service recovers from dependency failures.

## Common Pitfalls
- **Catching and re-throwing without context.** `try { ... } catch (e) { throw new Error('something failed') }` loses the original error's message, stack trace, and type. Always wrap with the original error.
- **Catching too broadly.** `catch (Exception e)` in Python/Java or `catch {}` in TypeScript catches programming errors (NullPointerException, TypeError) that should crash loudly, not be silenced.
- **Assuming async/await handles all rejections.** `await` converts rejections to exceptions, but only if you actually `await`. A missing `await` is a silent unhandled rejection.
- **Logging errors without context.** "Error: connection refused" with no request ID, user ID, or operation name is impossible to debug in a distributed system.
- **Using error messages for control flow.** `if (err.message.includes('duplicate key'))` is fragile across database versions and locales. Use error codes or `instanceof`.

## Verification Checklist
- [ ] All async boundaries identified (async/await, promises, callbacks, streams)
- [ ] Empty catch blocks eliminated or justified with comments
- [ ] All catch blocks either re-throw, return error result, or are explicitly fire-and-forget
- [ ] All promise chains have a `.catch()` handler
- [ ] Error logs include correlation ID, operation name, and relevant inputs
- [ ] Error wrapping preserves causal chain (original error as cause)
- [ ] Custom error classes defined for domain errors
- [ ] API error responses consistent (code + message, no stack traces)
- [ ] Retry logic implemented for transient failures with exponential backoff
- [ ] Non-critical dependencies degrade gracefully
- [ ] Tests cover every error path with specific assertions
