# Security Policy

## Supported Versions

Security fixes are accepted for the current `main` branch. Until the project publishes versioned releases, contributors should treat `main` as the only supported line.

## Reporting a Vulnerability

Please do not open a public issue for a suspected vulnerability.

Use the repository's private security advisory flow if available. If the repository does not yet have private advisories enabled, contact the maintainers through the private channel listed in the repository metadata.

Include:

- Affected commit or version.
- Steps to reproduce.
- Impact assessment.
- Whether credentials, sandbox access, or uploaded files may be exposed.

## Sensitive Areas

Take extra care around:

- AGS sandbox credentials and signed sandbox URLs.
- TokenHub or model-provider API keys.
- File upload/download authorization.
- ACP session ownership and replay data.
- Runtime cleanup for outer and inner sandboxes.
- Logs that may include command output, URLs, headers, or environment variables.

## Deployment Warning

This project is not yet a hardened multi-tenant production gateway. Do not expose a development instance directly to the public internet without adding authentication, tenant isolation, network controls, and secret management appropriate for your environment.
