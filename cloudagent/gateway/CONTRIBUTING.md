# Contributing

Thanks for helping improve `gateway`. This project is still evolving quickly, so small, well-tested changes are preferred.

## Development Setup

Requirements:

- Go 1.24 or newer
- Bash-compatible shell
- Optional cloud credentials for AGS/TokenHub integration tests

Local checks:

```bash
go test ./...
```

Cloud-backed tests and scripts require local environment variables such as `E2B_API_KEY`, `E2B_DOMAIN`, `TOKENHUB_API_KEY`, and `TOKENHUB_MODEL`. Do not commit real credentials. Use a local `.env` file only on your machine.

## Pull Requests

Before opening a PR:

1. Keep the change scoped to one concern.
2. Add or update tests for protocol, persistence, runtime lifecycle, or file behavior changes.
3. Run `go test ./...`.
4. Update docs when public behavior changes.
5. Avoid unrelated formatting churn.

## Protocol Changes

Changes to ACP, OpenAI-compatible endpoints, session lifecycle, message blocks, file handling, or sandbox runtime behavior should include:

- A short explanation of the wire-level behavior.
- Compatibility notes for existing clients.
- Tests that prove replay, streaming, and error behavior where applicable.

## Secrets

Never commit:

- API keys
- Tencent Cloud credentials
- TokenHub keys
- AGS sandbox keys
- `.env` files with real values
- Runtime logs containing signed URLs or credentials

If a secret is committed, rotate it immediately and report it as a security issue.
