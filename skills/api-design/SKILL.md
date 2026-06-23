---
name: api-design
version: 1.0.0
description: REST and GraphQL API design review covering naming, error handling, pagination, versioning, auth, and rate limiting
riskClass: medium
publisher: Axiom
---

# API Design Skill

## Overview
This skill provides a comprehensive framework for reviewing and designing REST and GraphQL APIs. It covers naming conventions, resource modeling, error handling patterns, pagination strategies, versioning approaches, authentication and authorization, rate limiting, and documentation standards. The goal is consistent, predictable, and developer-friendly APIs.

## When to Use
- Designing a new API endpoint or GraphQL schema
- Reviewing an existing API for consistency and best practices
- Planning a breaking change or API version bump
- Auditing an API before public launch
- Onboarding a team to API design standards

## Step-by-Step Instructions

### Phase 1: Resource Modeling
1. **Identify resources, not actions.** Model nouns (`/users`, `/orders`), not verbs (`/createUser`, `/processOrder`). Actions become HTTP methods: GET, POST, PUT/PATCH, DELETE.
2. **Establish resource relationships.** Use nested routes for ownership: `/users/:id/orders`. Avoid nesting deeper than 2 levels.
3. **Define the schema.** For each resource, list all fields, their types, required/optional, and validation rules. Use OpenAPI/Swagger for REST or GraphQL SDL for GraphQL.

### Phase 2: Naming and Conventions
4. **Use plural nouns for collections.** `/users`, not `/user`. `/users/:id` for a single resource.
5. **Use kebab-case for URLs, camelCase for JSON keys.** `/shipping-addresses` in the URL, `{"shippingAddress": ...}` in the body.
6. **Use consistent HTTP status codes.** 200 for success, 201 for creation, 204 for no-content, 400 for bad request, 401 for unauthenticated, 403 for unauthorized, 404 for not found, 409 for conflict, 422 for validation failure, 429 for rate limited, 500 for server error. Never return 200 with an error body.
7. **Use standard error response format.** Every error response should include: `error.code` (machine-readable string like `INVALID_INPUT`), `error.message` (human-readable), and optionally `error.details` (field-level validation errors).

### Phase 3: Pagination, Filtering, and Sorting
8. **Implement cursor-based pagination for large datasets.** Use `?cursor=xxx&limit=20`. Return a `nextCursor` in the response. Avoid offset-based pagination for data that changes frequently.
9. **Support filtering via query parameters.** `?status=active&role=admin`. Keep filter names consistent across resources.
10. **Support sorting.** `?sort=createdAt&order=desc`. Validate sort fields against an allowlist — never pass raw user input to a database ORDER BY clause.

### Phase 4: Versioning
11. **Version via URL path or header.** `/v1/users` is explicit and easy to understand. `Accept: application/vnd.api+json;version=1` is more flexible. Choose one and stick with it.
12. **Define a deprecation policy.** Give consumers at least 6 months notice before removing an API version. Use the `Sunset` and `Deprecation` HTTP headers.

### Phase 5: Authentication and Authorization
13. **Use Bearer tokens (JWT or opaque) in the Authorization header.** `Authorization: Bearer <token>`. Never accept tokens in query parameters or request bodies.
14. **Scope permissions granularly.** `read:users`, `write:orders`. Check scopes at the middleware/guard layer, not inside individual handlers.
15. **Rate limit by API key or user ID.** Return `429 Too Many Requests` with `Retry-After` and `X-RateLimit-Remaining` headers.

### Phase 6: Documentation
16. **Generate OpenAPI spec or GraphQL schema automatically from code.** Keep it in sync with CI checks.
17. **Include request/response examples for every endpoint.** At minimum: a success example and the most common error example.
18. **Document rate limits, authentication flow, and error codes** in a top-level README or developer portal.

## Common Pitfalls
- **Using the wrong HTTP method.** GET for mutations (causes caching problems), POST for idempotent operations (should be PUT), DELETE returning a body (should be 204).
- **Inconsistent error formats.** One endpoint returns `{"error": "..."}`, another returns `{"message": "..."}`. Choose one format and enforce it.
- **Leaking internal details in errors.** Stack traces, database table names, internal IPs — these help attackers. Always strip them in production.
- **No pagination defaults.** An endpoint without pagination defaults will return the entire table, potentially millions of rows. Always set a default limit (e.g., 20) and a maximum (e.g., 100).
- **Forgetting idempotency keys.** POST is not idempotent by default. For payment endpoints, require an `Idempotency-Key` header to prevent duplicate charges on retry.

## Verification Checklist
- [ ] Resources are nouns, actions are HTTP methods
- [ ] URLs use kebab-case, JSON keys use camelCase
- [ ] HTTP status codes used correctly for all responses
- [ ] Error responses follow a consistent format (code + message + details)
- [ ] Pagination implemented with defaults and maximum limits
- [ ] Filtering and sorting validated against allowlists
- [ ] Versioning strategy defined and documented
- [ ] Authentication uses Bearer tokens in Authorization header
- [ ] Rate limiting configured with proper headers
- [ ] OpenAPI/GraphQL schema auto-generated and in CI
- [ ] Request/response examples documented for every endpoint
