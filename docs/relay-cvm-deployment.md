# Tencent Cloud relay deployment

Run the existing standalone Relay as a transit-only Hub on a dedicated Ubuntu
24.04 x86-64 Lighthouse or CVM. It does not run Agents, serve a Workbench or offer
registration. Existing signed, revocable Hub invitations admit peers; business
histories and execution remain with their Server owners.

## HTTPS-only networking and management

Allow inbound TCP 443 only. For Lighthouse, create a firewall template containing
only that rule and pass `FirewallTemplateId` to `CreateInstances`; omitting it
would apply default rules that can expose SSH. For CVM, attach a dedicated
443-only security group at creation. Do not open 22, 80 or the management port.
Do not modify another workload's security rules or forward a workstation port.

Manage the machine through authenticated Tencent Automation Tools (TAT) HTTPS
APIs. The TAT agent must be online; no inbound management listener is needed.
Bootstrap disables both `ssh.service` and `ssh.socket` and installs no SSH keys.
The relay binds its public peer endpoint to TLS 443; operator and health APIs
remain exclusively on loopback 127.0.0.1:18090. Loopback HTTP is confined to the
VM and is never a network forwarding transport.

Keep instance IDs, private configuration, request receipts and credentials outside
tracked source. Bootstrap and activation must target the same reviewed account,
region and instance; never infer them from an unrelated CLI default.

## Bootstrap through TAT

Using the operator's existing approved TAT permissions, transfer the reviewed
`scripts/relay-deployment/bootstrap.sh` and `receive.py` into a root-owned
private staging directory through TAT `RunCommand`. Run as root:

```sh
bash /private/bootstrap/bootstrap.sh relay.example.com
```

No deploy key argument is needed. Bootstrap pins and checksums Node 26.7.0,
creates unprivileged runtime and deployment accounts, installs systemd and a
root-owned archive receiver. The deployment account may sudo only that receiver;
it has no authorized SSH keys. Only bootstrap requires root TAT execution;
release upload and activation use TAT's `Username: opencraft-deploy`.

State, operator credentials and TLS keys live outside release directories and
survive updates. Without a domain, use a public IPv4 endpoint: bootstrap creates
a private CA and matching one-year certificate. Signed Hub invitations carry
that CA, preserving normal certificate and hostname validation. This is not a
browser-trusted website. Arrange renewal before expiry, or use an approved domain
and managed certificate. Keep the CA private key on the VM.

## Exact-artifact deployment

From a clean committed checkout with dependencies installed:

```sh
node scripts/relay-deployment/build.mjs
RELAY_INSTANCE_ID=lhins-example RELAY_REGION=ap-guangzhou GITHUB_SHA=$(git rev-parse HEAD) \
  python3 scripts/relay-deployment/send.py dist/relay-release --profile approved-profile
```

Install the pinned `tccli==3.1.147.1` before using the sender. The archive carries
the source revision, build ID and per-file SHA-256 manifest. The sender verifies
its outer checksum and size before any write, then sends isolated chunks through
TAT HTTPS requests within the API's 64KB encoded command limit. No public bucket,
presigned download URL, SSH or HTTP deployment endpoint is used.

The receiver rejects unexpected files, links, traversal, excessive size, wrong
revision and changed payloads. Activation is serialized, atomically changes the
release symlink and verifies the running exact revision. A failed candidate
restores the previous release; first-deployment failure stops the service.
Runtime state and credentials are never rolled back with binaries. Initial
activation configures the Hub to accept invited peers and forward allowed routes;
later activation preserves operator policy.

The sender polls bounded invocation results. It does not replay a command on
unknown completion: inspect its invocation in TAT before retrying. Temporary
upload cleanup failure is reported separately. Apply privileged receiver/bootstrap
changes separately through reviewed operator TAT access.

## GitHub Actions

`.github/workflows/relay-deploy.yml` tests PRs without deployment credentials.
Relevant main pushes build and retain an identified archive, then deploy that
same artifact through TAT. `workflow_dispatch` on main permits redeploy. All
Actions are pinned to commits; no npm release or Git tag is modified.

An administrator must create `relay-production`, restrict deployments to main,
and configure:

| Environment setting | Value |
| --- | --- |
| Variable `RELAY_INSTANCE_ID` | Dedicated Lighthouse/CVM instance ID |
| Variable `RELAY_REGION` | Its exact Tencent Cloud region |
| Secret `RELAY_TENCENTCLOUD_SECRET_ID` | Approved deployment credential ID |
| Secret `RELAY_TENCENTCLOUD_SECRET_KEY` | Approved deployment credential key |
| Optional secret `RELAY_TENCENTCLOUD_TOKEN` | Valid STS token if using temporary credentials |

Use a dedicated least-privilege deployment identity for TAT RunCommand and
DescribeInvocationTasks against this deployment; cloud-provider resource-scoping
support and policy must be verified by the administrator. RunCommand is remote
execution authority: do not reuse an operator/admin key, broaden CAM policy or
create credentials automatically. Short-lived credentials expire and must be
provided by an approved credential workflow; a static expired STS token cannot
support unattended deployments. No cloud credential is sent to the relay VM.

## Validation

Run `python3 -m unittest discover -s tests/relay-deployment`, the built-artifact
integration test with `OPENCRAFT_RELAY_ARTIFACT`, and `npm run test:hub-network`.
Verify actual cloud firewall rules, absence of SSH listeners, TLS certificate
validation, unauthenticated rejection, deployed source revision and persistence
across service restart. A successful purchase or Git push does not prove the
relay is healthy. User/Workbench remote enrollment remains a separate integration.

## Personal machine enrollment publication

A dedicated single-owner deployment can opt in to `machineGateway` with an HTTPS
`origin` and private `credentialFile` containing `{"credential":"<43-character-key>"}`.
The local Server connects outbound through the separate machine-gateway control/data
paths. Only installer/source download, pairing and enrolled machine control/data
are forwarded, with their original credentials. Workbench, owner status/RPC, Hub
operator and update paths remain inaccessible. An Origin header is rejected.
The private publication key authorizes one owner slot, not general membership or
user authentication. It is not a multi-tenant machine registry.

For a publicly trusted short-lived IP certificate, install the reviewed ACME client
and `renew-tls.sh` as a root-owned timer job, running daily. It skips certificates
with over three days remaining and uses TLS-ALPN on 443, briefly stopping the
relay with an unconditional restart on failure. Keep SSH and port80 closed. Only
switch peer listener certificate paths after successful issuance; public-trust
connections omit the previous private CA pin. Renewal failures require operator
attention before the certificate expires.
