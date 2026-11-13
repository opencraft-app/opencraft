# CVM relay deployment

This deployment runs the existing standalone Relay as a transit-only Hub. It does
not run Agents, publish a Workbench, provide user registration, or grant workspace
membership. Nodes authenticate with existing signed, revocable Hub invitations.
Business histories and execution remain with their existing Server owners.

## Server bootstrap

Use a dedicated Ubuntu 24.04 x86-64 CVM. Allow TCP 443 for authenticated Hub peers
and TCP 22 for operator SSH and the restricted deployment identity. Do not expose
the loopback management listener on 18090. Use an independently generated
operator key and an Ed25519 deployment key; only the latter belongs in Actions.
Keep instance IDs, IP addresses, private keys and cloud request receipts in the
operator's ignored `.local/` deployment records, not this repository.

After independently verifying the VM's SSH host key, copy
`scripts/relay-deployment/{bootstrap.sh,receive.py,ssh-receive.sh}` and the deployment
**public** key to an operator-owned temporary directory on the VM. Run:

```sh
sudo bash /private/bootstrap/bootstrap.sh relay.example.com /private/bootstrap/deploy.pub
```

The bootstrap pins and checksums private Node 26.7.0, creates an unprivileged
runtime account, installs systemd and an SSH forced-command receiver, and prepares
private configuration. Runtime state, credentials and TLS keys are outside all
release directories and are preserved by updates. The service starts only after
a verified release arrives.

Without a domain, the endpoint may be a public IPv4 address. Bootstrap creates a
private CA and a matching one-year TLS certificate; normal hostname/certificate
validation remains enabled. The signed Hub invitation carries that CA. This does
not provide a browser-trusted certificate or a registration website. Operators
must arrange certificate renewal before expiry, or replace it with their
approved domain and managed certificate. Keep the CA private key on the VM.

## Exact-artifact deployment

From a clean committed checkout with dependencies installed:

```sh
node scripts/relay-deployment/build.mjs
```

The output contains a bundled relay, operator tools, a source revision, a
per-file SHA-256 manifest and an archive checksum. No deployment configuration or
credential enters the archive. The dedicated SSH identity accepts only
`deploy <40-character-revision> <64-character-archive-checksum>` with the archive
on stdin. It cannot open a shell, forward ports or use the operator's cloud keys.

The receiver rejects unknown files, links, traversal, excessive archive size,
wrong source identity and changed payloads. It activates an immutable release
through an atomic symlink, restarts the unprivileged service, and checks the
running health response against the exact source revision. A failed candidate
restores the prior release; first-deployment failure stops the service. State and
credentials are never rolled back with the binary. Deployments are serialized.
On first activation only, the Hub is configured to accept invited peers and
forward allowed routes; updates preserve later operator policy.

## GitHub Actions

`.github/workflows/relay-deploy.yml` validates relevant PRs and builds a fresh
identified archive. Main pushes touching relay inputs deploy the same retained
artifact; `workflow_dispatch` on main provides a manual redeploy. PRs never access
the deployment job. The workflow does not publish npm packages or modify release
tags. Deploying requires the `relay-production` environment and its secrets:

| Secret | Value |
| --- | --- |
| `RELAY_SSH_HOST` | Deployment hostname or IPv4 address |
| `RELAY_SSH_KEY` | Dedicated forced-command private SSH key |
| `RELAY_SSH_KNOWN_HOSTS` | Independently verified SSH host-key lines |

Restrict the environment to main. Do not substitute `ssh-keyscan` for verification
inside CI, disable host-key checking, reuse an operator key or store Tencent Cloud
API credentials in this workflow. The remote forced command and sudo rule only
permit the fixed, root-owned archive receiver; application code runs as the
runtime user. All action versions are pinned to commit IDs.

The workflow updates runtime artifacts, not the privileged bootstrap/receiver.
Review and apply changes to the VM bootstrap through operator access separately.
Health on the VM is `http://127.0.0.1:18090/__opencraft_relay/health`; TCP 443 is a
peer-only TLS endpoint and intentionally does not serve a homepage. Initial Hub
invitations can be issued through the existing loopback operator API. A successful
connection proves transport admission, not user identity or resource permission.

## Validation

Run `python3 -m unittest discover -s tests/relay-deployment`, `npm run test:hub-network`
and the build from a clean commit. Verify the actual deployed source revision,
unauthenticated peer rejection, certificate validation, persistence across
restart, and rollback on a deliberately invalid candidate. A built archive or a
successful Git push alone does not prove a healthy deployment.
