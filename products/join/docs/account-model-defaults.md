# Personal model defaults

Join's product composition wraps its existing identity with
`withTencentOaModelDefaults`. It delegates every other endpoint and lifecycle to
the original owner, and uses the existing `TencentOaServerPlugin` HTTP contract
and `AccountModelDefaultsStore` implementation. The administrator's engine/model
configuration and model usage policy are not changed.

`account-model-defaults.sqlite` is persistent instance data. Records use the
existing document schema and are keyed by verified employee scope plus Host.
Existing records are reused; writes require the current revision (CAS), exact
account scope and existing instance admission. The main Server schema is not
migrated by this store. Never delete the file to clear an interface error.

The Web catalog distinguishes a preference failure from a model directory
failure. Explicit retry refreshes both the directory and personal preferences;
it does not reset a saved selection or change shared Agent configuration.

## Focused delivery to a legacy mounted Gateway

`tools/build-model-defaults-overlay.mjs` builds the same composition adapter as an
independent module and applies a SHA-pinned transformation to the actual retained
Gateway. It can incorporate the already-audited credential compatibility loader
at build time, pinning that loader too. It never starts the Gateway during build.

The candidate image's service launcher selects the explicit
`container-gateway.account-defaults.mjs` artifact. This avoids an old read-only
mount silently hiding the new artifact; the retained credential transform is
already present, not lost by selecting a new filename. All other role entries
remain identical. The old mounts can remain inert for this focused image-only
cutover and rollback; removing those historical mounts is a separate standard
rollout. Do not build the candidate from a newer complete Gateway just to repair
this endpoint: unrelated Server migrations require their own matched rollout.

Build receipts identify the consumer commit, baseline Gateway/loader/launcher
hashes and emitted module hashes. Production publishing still requires the
shared deployment lock, cold Gateway/data backup, runtime verification and
rollback. This focused image does not update Web/Brain/Hands or promise the newer
Web diagnostic is already deployed.

An effort-only usage rule must not mark its entire model as unselectable. The
projection now marks only whole-model bans as `policyRestricted`; banned effort
choices and the execution-time policy admission remain enforced. Focused legacy
delivery applies the same projection fix without changing administrator rules.
