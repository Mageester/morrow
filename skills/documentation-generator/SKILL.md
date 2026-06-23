---
name: documentation-generator
version: 1.0.0
description: Generate comprehensive documentation — read code, extract public API, add JSDoc/docstrings, update README, create architecture docs
riskClass: low
publisher: Axiom
---

# Documentation Generator Skill

## Overview
This skill provides a structured approach to generating and maintaining code documentation. It covers extracting the public API surface, writing targeted docstrings and JSDoc comments, updating project README files, creating architecture decision records (ADRs), and maintaining type documentation. The output is documentation that stays close to the code and is easy to keep in sync.

## When to Use
- A new module or package needs initial documentation
- An existing codebase has sparse or missing docstrings
- The README is out of date with the current API
- A new developer is onboarding and needs architecture context
- A public API is being prepared for external consumers
- A significant architectural decision needs to be documented

## Step-by-Step Instructions

### Phase 1: Surface Analysis
1. **Read the entry points.** Identify the main entry files: `index.js`, `__init__.py`, `lib.rs`, `main.go`. These expose the public API.
2. **Extract all public exports.** List every exported function, class, type, interface, and constant. Ignore internal/private helpers (anything prefixed with `_` or not exported).
3. **Categorize the surface.** Group exports by domain: data models, service functions, middleware, utilities, configuration. This becomes the structure of your documentation.
4. **Identify undocumented items.** Cross-reference the export list with existing docstrings. Flag every public item that lacks documentation.

### Phase 2: Write Docstrings and Inline Docs
5. **Write a docstring for every public function and class.** Follow the language convention: JSDoc for JavaScript/TypeScript, Google/NumPy style for Python, `///` doc comments for Rust, `// FunctionName` Go doc convention.
6. **Structure each docstring.** Include: a one-line summary, a detailed description (when needed), `@param`/`Args:` for every parameter with type, `@returns`/`Returns:` with type and description, `@throws`/`Raises:` for all possible errors, `@example`/`Example:` with a runnable code snippet.
7. **Document type parameters and generics.** If the function accepts a `T extends Foo`, document what T represents and the constraints.
8. **Write usage examples that actually run.** Copy-paste the example into a test file and verify it executes. Nothing erodes trust faster than incorrect documentation examples.

### Phase 3: Update the README
9. **Check the README against the current API.** Compare code examples in the README with the actual function signatures. Update any outdated snippets.
10. **Ensure the README covers:** project description and purpose, quick-start installation (copy-paste commands), minimal working example, key features list, link to full API docs, contribution guide link, and license.
11. **Keep the README concise.** It's the front page, not the full manual. Link to deeper docs for detailed usage.

### Phase 4: Architecture Documentation
12. **Create or update the ARCHITECTURE.md.** Describe the high-level system design: component diagram (text or mermaid), data flow between components, technology choices with brief justifications, and key design patterns used.
13. **Document architectural decisions as ADRs.** For significant decisions (why PostgreSQL over MongoDB, why microservices over monolith), create an ADR in `docs/adr/` with: title, status (proposed/accepted/deprecated), context, decision, and consequences.
14. **Add a directory map.** A simple table listing each top-level directory and its purpose. This is often the most useful single piece of documentation for new developers.

### Phase 5: Automation and Maintenance
15. **Set up API doc generation in CI.** Configure TypeDoc (TypeScript), Sphinx (Python), `cargo doc` (Rust), or Javadoc (Java) to build HTML docs on every push. Fail the build if docs have warnings.
16. **Add a docs linting step.** Check that every exported function has a docstring, that `@param` tags match actual parameters, and that example code is valid.
17. **Add a "docs needed" label to the PR template.** For any PR that changes the public API, require documentation as part of the definition of done.

## Common Pitfalls
- **Documenting the obvious.** `/** @param x - the x coordinate */` adds no information. Either explain what x represents or omit the docstring entirely.
- **Letting docs go stale.** Every time a function signature changes but the docstring doesn't, documentation becomes actively harmful. Treat outdated docs as bugs.
- **Writing documentation in isolation.** Docs written by someone who didn't write the code often miss important context. The author should write the initial docs; reviewers should verify them.
- **Over-documenting internals.** A 200-line comment explaining a private helper function is a sign the function is too complex. Refactor first, then document.
- **Ignoring error documentation.** The `@throws` section is often skipped, but it's the most critical part for consumers. They need to know what can go wrong and how to handle it.

## Verification Checklist
- [ ] All public exports identified and listed
- [ ] Every public function/class has a docstring with summary, params, returns, raises, and example
- [ ] Docstring examples verified by running them as tests
- [ ] README updated with current API examples
- [ ] README covers description, quick-start, minimal example, features, and links
- [ ] ARCHITECTURE.md created or updated with component diagram
- [ ] ADRs documented for key architectural decisions
- [ ] Directory map included for developer onboarding
- [ ] API doc generation configured in CI
- [ ] Docs linting catches missing/invalid docstrings
- [ ] PR template includes "docs needed" checklist item
