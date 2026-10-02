# site-runtime

Untrusted website JS execution boundary. Production runner must use hardened
isolation; no host-process fallback, user-provided container flags, or network
access. Control-plane and invocation credentials are separate and never passed
to user code. Do not enable website backend capability on unit-test evidence.

Verify: `go test -race ./...`, `go vet ./...`, build, and real Linux/runsc isolation
acceptance before release. Preserve immutable `(site, release, sha256)` identity.
