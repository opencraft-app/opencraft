# Relay source provenance audit

Read-only audit, 2026-11-10. No deployment, configuration or runtime state changed.

## Runtime evidence

- Namespace: dep; Deployment: opencraft-relay; inspected pod: opencraft-relay-6db657f76f-482sj.
- Image: csighub.tencentyun.com/skipzhang/opencraft-relay@sha256:0ad949737bfb585e5fcc274c380975c9b91eab07785f98876e4df322acc432a1.
- `/app/relay.mjs` SHA256: f9d46657dfb81624f2dda01bf0c5293b9dfc06e1f2f2b3addbebeb7b6ef049a6.
- `/app/relay-cluster-admin.mjs` SHA256: fe430619353f2bbd435bf8cb3f7fb8f95a42aff2e5ee3d16c909e12b68f98ca4.
- Deployment annotations identify transport-drain 5fa760696e79539e326a54602fa02ca38020e771 and stream-drain-fix a2be30b7bed3829e23f52faa560b5fb480fd5af2. Annotations alone do not establish complete image source identity or patch ordering.

## Bundled source markers

Core files include `.local/relay-deploy-20261107/source/apps/relay-server/src/{application,server,authentication,selection,session-store,redis,cluster}.ts`.

Product files include `.local/dep-relay-20261105/join-reference-9f2c2179/products/join/` modules for TencentOA identity, entry aliases, Grasp proxy and canonical redirect.

Actual startup is `.local/dep-relay-20261105/migrated-entry.ts`, with additional mobile-preview forwarding and an appended WeCom callback forwarder. This is not simply the checked-in mono2 product entry.

The bundled callback route forwards POST `/wecom_callback` through `app.openHubStream` to hub-d00bd6f39112a3c11a62656c397b9515c5a1f2e2, path `/__opencraft_im/shadow-callback/wecom`. Presence of the separate opencraft-wecom-poc Pod does not establish that it owns production callback traffic. This audit did not inject a live provider message or prove external load balancer path routing.

## Repository checks

- Internal repository origin/env/local includes generic Relay core but lacks cluster.ts, redis.ts, session-store.ts, relay-cluster-admin and Join product Relay composition.
- Local mono2 snapshot contains products/join/{relay-main.ts,relay-composition.ts,package-relay.mjs}, but lacks the clustered Relay files.
- Host .40 `/data/mono2` origin/env/join also lacks those clustered files. `git log --all -- opencraft/apps/relay-server/src/cluster.ts` returned no commits in that repository's available history.
- Mono2 task and release notes describe 5fa760696e79 and a2be30b7bed3 as local public-core snapshots, explicitly not accepted/published upstream. The recorded earlier image was sha256:73cf7f91e96f2838dfc89de5f7e4d7b52dc19d62bba41cff08c689860b9f5cb9, different from current runtime.
- Those snapshot objects were not available in inspected local core repositories or .40's public-core reference checkout. Fetching 5fa760696e79 from GitHub returned `not our ref`. This does not prove that no other original checkout has the objects.

## Consequence

Production is a combination of a local core snapshot, mono2 product adapters and a local release entry, with later callback customization. Neither checked-in tree inspected reproduces it by itself. Preserve the live bundle as provenance evidence; do not treat generated code as the canonical TypeScript source.

Existing Redis code provides shared authentication state, atomic leases and replica/connection ownership plus Hub route projection. It does not by itself establish the requested Human-to-Server directory or group-message spool.

Before replacing this deployment, recover the original core snapshot and release entry (or explicitly reconstruct and review them), integrate the complete product composition into the internal repository, and validate existing cluster authentication/leases/forwarding and shutdown behavior. Then add group store-and-forward as a product capability using the existing cluster lifecycle. The unbound-group rule remains first 200 distinct messages retained, warning at 10, overflow discarded.

## Mono2 integration

The source integration uses mono2 `a564eb897089671fc72c64356cb79332e334f8ff` for
the Redis-backed runtime and Join assembly, `077cf36225` for EOF draining, and
`edfa4c54e7` for negotiated control reconnection. Server selection recovery
comes from `3477ffc469` and `4c60931c66`. The product port uses the existing
internal Tencent OA plugin and packages its worker and image alongside the entry.
The runtime evidence above documents the deployed callback customization, which
is outside those mono2 commits.


## WeCom callback integration, 2026-11-11

The source entry now supports the live callback using a private `wecomCallback`
target and the existing Hub transport. Production inspection confirmed five
ready Relay replicas on the audited image. The advertised receiver ID and Origin
matched the running callback target. A port-forward to a running Relay
returned 200 for a signed synthetic callback, 401 for a bad signature, and 400
for a wrong recipient. A request from the development machine to the public
`join.woa.com` callback returned a 302 to corporate sign-in before Relay.
The packaged candidate test uses a separate Hub and synthetic receiver in both
file-owned and Redis-backed modes.


## Source-built production rollout, 2026-11-11

The five-replica `dep/opencraft-relay` Deployment now runs the Relay artifact
built from internal source `dd379f9be866277e454c2e18ceb607a55af9d678`.
The image is `csighub.tencentyun.com/skipzhang/opencraft-relay@sha256:6619f16b083357cd47f23b2b3374d6cd1e07d37934ca0b8f71ab529c46d122de`.
The Relay bundle SHA256 is `128791d78629ec053eba484711457458a0926fc4dd84a265dbc1cce465936948`.
The new layer retains the verified running base image, and the committed product
assembly includes the existing mobile-preview forwarder and authenticated test
environment routes.

A separate canary passed before the `maxUnavailable: 0` rollout. All five running
replicas returned the fixed source revision and callback results of 200 for a
signed synthetic fixture, 401 for an invalid signature and 400 for a wrong
recipient. The same probes through `http://join.woa.com/wecom_callback`, from a
cluster receiver Pod using its normal DNS and load balancer, returned 200/401/400.
This checks the hostname-to-Relay-to-Hub-to-receiver path with signed fixtures.
The development machine's HTTPS route still redirects to enterprise sign-in.
Actual WeCom-originated business delivery is a separate observation.

Rollback restores the prior image and the original container environment through
compare-and-swap deployment patches. The prior image is the digest recorded in
Runtime evidence above. Deployment discovery, fixed source build, image publication,
canary, rollout and rollback receipts are kept in the private release directory.
