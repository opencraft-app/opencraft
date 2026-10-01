# Website backend release and rollback contract

This is a **release-preparation checklist**, not authorization to change production and not
an overall Ready declaration. The 2026-10-01 Beijing and Seoul test acceptance uses stateless,
owner-authenticated `fetch-v1`. App databases, anonymous writes and arbitrary outbound access
are outside the delivered contract. Reuse the existing static website operations.

## Frozen inputs

Record and keep together:

- Source revision **and dirty/source-file snapshot**, Go toolchain, Linux architecture.
- CTL API/service, website worker, site gateway and service gateway immutable image digests.
  Verify their actual executable hashes after rollout, not only Deployment image strings.
- Manager executable SHA256, systemd unit SHA256, fixed engine Docker image ID/repository digest,
  engine export SHA256, workerd lockfile and runsc version. A mutable engine tag is not sufficient.
- Migration `000032_website_backend_revision` up/down hashes; recheck numbering against target
  master before integration. Current test baseline migrated to 32; latest checked master is 31.
  The candidate CTL release bundle pins both shprod/sgprod verification to 32 after the
  authorized migration, matching this source migration; it must not remain pinned to 31.
  Editing this offline release policy does not apply a production migration.
- Complete website Skill version; new-machine image IDs and region mapping; Skill-only install
  and rollback Command JSON hashes. Do not embed instance credentials in these artifacts.
- Region-specific runtime URL, TLS CA trust and secret **references**. Keep all actual secret
  values, env files, SSH identity and private TLS keys outside Git and distributable archives.

The repository runtime artifact consists of `site-runtime` built with the documented Linux
command, `website-runtime.service`, `runtime-image/` source/lockfile, and this deployment guide.
Build/test artifacts can be exported as a deterministic, file-hashed archive. An archive itself
is not deployment evidence.

## Offline configuration preparation

Use [RELEASE-BINDINGS.md](RELEASE-BINDINGS.md) and the references-only renderer to prepare
regional final-overlay patches. Append them after existing positional source patches; never
insert a Component into the CTL overlay. Both regional real-source renders preserve the
existing static/auth/DSH settings. Prepare keeps new fullstack disabled, enable requires an
explicit nonempty owner allowlist. No production identity or secret is inferred from tests.

## Rollout order after explicit release authorization

1. Confirm target is the intended region/environment; back up DB and deployed manifests/image
   digests through the existing release process. Preserve the active site's current artifacts.
2. Apply the compatible up migration; deploy the control plane/worker/gateway with fullstack
   creation disabled. Keep old static clients and existing static sites working.
3. On **dedicated regional runtime hosts**, verify Docker/runsc, cgroup/resource enforcement,
   architecture, pinned engine, private data directory and TLS SAN/CA configuration. Use the
   unit/config contract in `README.md`. Do not reuse a user machine or shared-node Docker socket.
4. Install the hash-verified manager and unit; preserve the previous binary/unit and runtime
   store for rollback. `systemd-analyze verify`, then start through systemd and inspect its startup
   preflight. Never overwrite or reissue existing deploy/invoke tokens as part of binary upgrade.
5. Configure worker deploy-token and gateway invoke-token separately, regional HTTPS endpoint,
   and CA trust. Do not publish keys or manager listener publicly; do not disable certificate checks.
6. Verify real manager deploy/invoke/delete, timeout recovery, metadata/network denial,
   credential separation and no leftover labelled containers using the exact selected artifacts.
7. Enable only the approved test/canary owner(s). Publish using a normal user machine and its
   automatically delivered instance credential. Verify the real browser OIDC path, static content,
   `/api` result, old-page revision rejection, owner isolation, failed publication preserving the
   old site, joint rollback, lifecycle and delete/storage/runtime/quota terminal state.
8. Promote the validated source/images/config through the normal GitOps process. Verify target
   Argo revision, immutable workload images and `Synced`/`Healthy`, then repeat business acceptance.
   The task-owned imperative test deployments have **no** production Argo convergence claim.
9. Adopt the final Skill in new-machine builds. After production launch, the user executes the
   separately prepared Skill-only TAT stock rollout by actual region. Use refreshed inventory,
   canary acknowledgement and resume ledger; do not combine instance-key delivery with Skill update.

Production host identifiers, endpoint/SAN, CA secret references and regional image/Command
mapping must be reviewed before step 3/5/9. Test host identities and tokens are not production
configuration. Providing these inputs during approved release is not an authorization shortcut.

## Rollback order

- Stop new fullstack creation/expansion first. This capability gate is not a kill switch for
  already active fullstack sites: preserve their runtime/gateway while recovering service.
- For a site-version issue, use the public rollback operation and poll to terminal success;
  static path and backend digest/revision switch as one generation. Verify an old browser gets
  409 and reload gets the restored page/API. Missing/pruned artifacts require republishing a
  retained ZIP, not declaring a rollback successful.
- For a manager upgrade issue, restore the preserved binary/unit, leave the runtime data store
  intact, restart, and verify existing immutable releases remain invokable. Do not delete bundles
  merely because a control-plane acknowledgement was lost.
- For an application-image issue, restore the captured image/config versions compatible with
  current DB schema. Do **not** downgrade to a static-only gateway while active fullstack sites
  still exist. Either retain the compatible gateway/runtime or explicitly withdraw affected sites.
- Do not run the destructive DB down migration until all fullstack sites/releases have been
  drained/migrated and old-client behavior is verified. Never use schema down as a traffic switch.
- Skill rollback restores each machine's own previous complete directory with the version guard.
  Lost rollback acknowledgement requires reconciliation, not blind repeat. Credentials stay intact.

## Test evidence and remaining sign-off

Beijing/Seoul final-image normal provisioning, automatic credentials, final-source container
binary checks, authenticated browser API/negative matrix and Korean real delete/recreate passed
on 2026-10-01. The task checkpoint is the detailed evidence index. Previous rollback, migration,
retention and runtime-isolation exercises must be tied to frozen artifacts during final review;
this checklist does not silently mark that review or final release packaging complete.
