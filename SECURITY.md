# Security Policy

Morrow is pre-alpha software and must not yet be trusted with production secrets, financial accounts, sensitive personal data, or unrestricted host access.

## Core security expectations

- Permissions are explicit and scoped.
- External data transfer is visible.
- Secrets are referenced through protected handles rather than inserted into model prompts.
- Unattended tasks cannot expand their own authority.
- Tool execution is attributable and recorded.
- Local-only mode must make no external network requests.
- Project, user, agent, and memory boundaries must be testable.

## Reporting a vulnerability

Do not disclose security vulnerabilities through a public issue.

Until a dedicated security contact is established, report privately to the repository owner through GitHub. Include:

- Affected component
- Reproduction steps
- Expected and actual behavior
- Potential impact
- Suggested mitigation, when known

## Security review requirement

Pull requests affecting authentication, permissions, tools, memory, model routing, secrets, remote access, plugins, automations, or external data flow require an explicit security review before merge.
