# Security Policy

## Supported Versions

Security fixes are accepted for the current `main` branch. Until versioned releases are published, contributors should treat `main` as the supported line.

## Reporting a Vulnerability

Please do not open a public issue for suspected security vulnerabilities.

Use the repository's private security advisory flow if available. If private advisories are not enabled, contact the maintainers through the private channel listed in the repository metadata.

Include:

- Affected commit or version.
- Reproduction steps.
- Browser, backend, and gateway configuration.
- Whether uploaded files, downloaded artifacts, credentials, or ACP session state may be exposed.

## Sensitive Areas

Take extra care around:

- File upload and download URLs.
- ACP session binding and replay.
- Local gateway proxying for `/v1/files`.
- Browser storage that tracks session ids.
- Logs or traces that may contain prompts, file names, command output, headers, or tokens.

## Deployment Warning

The local gateway and UI are designed for development and controlled deployments. Do not expose them directly to the public internet without appropriate authentication, origin controls, tenant isolation, and file access controls.
