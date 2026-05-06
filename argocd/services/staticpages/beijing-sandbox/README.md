# StaticPages Beijing Sandbox

`staticpages` hosts frontend preview deployments for `frontsandbox/*` style branches.

Runtime model:

- Upload API: `staticpages-api.sandbox.lightclaw.tech`
- Preview wildcard: `*.sandbox.lightclaw.tech`
- Storage backend: COS bucket `webhosting-1388575217`
- Upload auth: bearer token from `staticpages-runtime-secrets`

Secrets are supplied by `../../../secrets/beijing-sandbox/staticpages-runtime-secrets.sops.yaml`.
Do not commit COS credentials or upload tokens in plaintext.
