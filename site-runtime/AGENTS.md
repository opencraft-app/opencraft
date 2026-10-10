# site-runtime

Untrusted website JS execution boundary. Production runner must use hardened
isolation; no host-process fallback, user-provided container flags, or network
access. Control-plane and invocation credentials are separate and never passed
to user code. Do not enable website backend capability on unit-test evidence.

Verify: `GOWORK=off go test -race ./...`, `GOWORK=off go vet ./...`, build,
and actual isolation acceptance for the selected driver before release. The
runsc driver requires Linux/runsc acceptance; the explicitly configured
minisandbox driver requires real Workers/Durable Object/Depot/FDB qualification,
including persistence, version replacement, rollback and tenant isolation.
Do not substitute one driver's evidence for the other. Preserve immutable `(site, release, sha256)` identity.
