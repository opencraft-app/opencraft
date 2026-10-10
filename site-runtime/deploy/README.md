# Website runtime manager deployment

This is a candidate host contract, not evidence of an installed or production-ready service.
Only the Beijing and Seoul **test environments** are authorized in the current task.

## Driver selection for the persistent release

The current persistent-backend release explicitly uses `WEBSITE_RUNTIME_DRIVER=minisandbox`.
The manager connects to the independently qualified regional Workers API using
`WEBSITE_MINISANDBOX_API_URL` and a fixed `WEBSITE_MINISANDBOX_SCOPE`. It does not
require a host Docker socket, runsc or `WEBSITE_RUNTIME_IMAGE`. Run it as the
runtime UID with a persistent writable manager store; use one writer and
`Recreate` for a Kubernetes deployment. Workers/Durable Object/Depot/FDB provide
application execution and persistence, not the manager's local filesystem.
Actual regional native-runtime and business acceptance are still mandatory.

Workers API readiness alone does not prove Worker deployment. Bind the regional
stateless executor URL and its private capability, and configure the separate
internal Object Router listener/capability used by stateless Workers. Keep executor,
workerd and Object Router capabilities distinct; do not point the Object Router at
the Engine's public port. Derive the Engine logical datacenter from its actual
runner configuration, not from the cloud region name. Confirm these bindings with
one real Worker deployment and Durable Object write/read before business acceptance.

The legacy host requirements and unit below apply only to the explicitly selected
`runsc` driver (or the legacy empty-driver default). Its historical stateless
acceptance does not qualify the minisandbox persistent release.

## Legacy runsc host prerequisites

- Dedicated Linux VM, cgroup v2; root manager, local Docker daemon and runsc.
- Docker's `runsc` registration uses `--host-uds=create` (not `all`).
- Preloaded architecture-correct engine image, pinned by SHA-256 digest; no mutable tag.
- Data directory `/var/lib/website-runtime`, owned root, mode 0700, persistent disk.
- Host access restricted to the approved test control plane / gateway. No public manager port.
- Never mount a shared Kubernetes node Docker socket or weaken the Korean EKS isolation model.
- Do not reuse a user instance, production VM, or the multi-environment deployment bastion.

The executable checks Docker resource enforcement, runsc, the pinned image, and a real
isolated workerd/socket request with denied metadata egress **before listening**. It refuses
startup on failure. The current supported service limit is global 8 / per-site 2 concurrent
requests. Invocation admission also has a per-site token bucket: 5 requests/second,
burst 10, at most 4096 tracked sites per manager, idle eviction after 2 minutes.
Control-plane requests are not charged to this rate bucket. Limits are per manager,
not a distributed account quota; replicas do not provide a shared rate limit.
These are beta safety bounds, not a throughput/capacity qualification.

## Protected configuration (both drivers)

Create `/etc/lightvela/website-runtime.env` outside Git, owned root:root, mode 0600. Required
variable names: `WEBSITE_RUNTIME_DATA_DIR`, `WEBSITE_RUNTIME_DEPLOY_TOKEN`,
`WEBSITE_RUNTIME_INVOKE_TOKEN`. The legacy runsc driver additionally requires
`WEBSITE_RUNTIME_IMAGE`; minisandbox instead requires the driver/API URL/scope
variables listed above. Kubernetes uses role-scoped Secret references, not a
root-owned env file mounted into a non-root container. Tokens must be distinct and
at least 24 bytes; generate separately for each test environment and transfer via approved
secret storage, never logs or a manifest committed to Git. Set `WEBSITE_RUNTIME_ADDR` only
to the approved private listener (default is loopback). Non-loopback listeners require `WEBSITE_RUNTIME_TLS_CERT_FILE` and
`WEBSITE_RUNTIME_TLS_KEY_FILE`; missing/partial/invalid configuration fails closed.
The listener requires the private key to be a regular file with no group/other
permissions. A Kubernetes Secret projection is a symlink and must not be used
directly as this key path. For Kubernetes, mount the source Secret read-only in
an init container, copy certificate/key into an `emptyDir` as the runtime UID
with `umask 077` and key mode `0600`, then mount that output read-only into the
manager. Preserve the exact certificate/key bytes and SAN; never relax the
listener's regular-file or permission checks. Rotate the Secret through a
reviewed Pod replacement so the init container materializes the new identity.
The key must be a non-symlink regular file with no group/other permissions. TLS 1.2
is the minimum. Only a literal loopback address may use HTTP for local probes or a
local TLS proxy. Private VPC addresses alone do not protect bearer credentials.
Clients must trust the issuing CA and validate the server SAN; never use
`InsecureSkipVerify`. Deploy CA trust and matching HTTPS client URLs before switching
the listener. Access rules remain required.

The legacy runsc unit deliberately has no PrivateTmp: Docker bind mounts must use the same filesystem
paths as the manager. Root privileges are only for the dedicated manager/Docker boundary;
every untrusted invocation uses UID 65532, runsc, readonly rootfs, no network/caps, hard
CPU/memory/PID limits and forced cleanup.

## Deployment and acceptance

1. Build `GOWORK=off CGO_ENABLED=0 GOOS=linux GOARCH=<host> go build -trimpath -o <artifact> ./cmd/site-runtime`.
2. Record executable digest, engine digest, runsc version, source snapshot and unit/config
   hashes (not secret values). Validate the unit on the target system before enabling it.
3. Install binary and unit only after target-host identity and test ownership are confirmed.
4. Start, verify startup preflight, real deploy/invoke/delete and absence of orphan containers.
5. Run the full isolation fixture against the exact engine/runtime artifact. Negative checks
   include anonymous/wrong-token/cross-site/digest mismatch and malicious code termination.
6. Restart/crash recovery must retain immutable bundles and reap this manager's labelled
   containers without affecting unrelated Docker workloads. Preserve the store on rollback.

Historical runsc-only evidence (not current persistent release qualification):
The candidate unit and fixed binary passed dedicated regional test-host deploy/invoke/delete
and isolation checks. On 2026-10-01, both Beijing and Seoul passed normal final-Skill-image
provisioning, automatic credentials, final-source live executable verification and real
OIDC/browser backend acceptance. Seoul also passed website deletion, COS/runtime cleanup, quota
release and normal recreation/public browser acceptance. Reuse historical static-site operations;
no historical monitoring/certificate-rebuild program is required. Final artifact/rollback review
remains open; see `RELEASE-CHECKLIST.md`. This unit alone is not an overall Ready declaration.

Runtime bundle files are explicitly chmod 0444 after writing so UMask=0077 does not
make them unreadable to UID 65532. The host store remains root-only; only the selected
bundle is exposed through a read-only container mount.
