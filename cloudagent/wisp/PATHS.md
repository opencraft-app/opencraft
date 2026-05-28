# Path Layout

This document describes the current `wisp` path model for the single-daemon,
multi-container deployment shape.

The current workspace name in [config.jsonnet](/root/myworkspace/config.jsonnet) is:

- `orbcrun-sg3`

Runtime-only overrides live in
[containers/orbcrun-sg3/overlay.jsonnet](/root/myworkspace/containers/orbcrun-sg3/overlay.jsonnet).
All config loads apply the base file first, then the selected container overlay.

## Remote State

These paths are expected to live on JuiceFS/COS through `JFS_ROOT`.

- `JFS_ROOT=/mnt/cos-workspace`
- `STATE_ROOT=/mnt/cos-workspace/wisp/orbcrun-sg3`
- `ACTIVE_ROOT=/mnt/cos-workspace/wisp/orbcrun-sg3/active`
- `ACTIVE_IMG=/mnt/cos-workspace/wisp/orbcrun-sg3/active/root-upper.img`
- `CHECKPOINTS_ROOT=/mnt/cos-workspace/wisp/orbcrun-sg3/checkpoints`
- `POLICY_ROOT=/mnt/cos-workspace/wisp/orbcrun-sg3/policy`

Intent:

- keep writable upper-image state on COS
- keep checkpoints on COS
- keep policy on COS

Crash-safety rule:

- `ACTIVE_IMG` is mutable working state.
- committed checkpoints are the recovery source of truth.
- the latest committed checkpoint is recorded by a manifest under `POLICY_ROOT`.
- graceful stop must commit a checkpoint before reporting success.
- force stop may skip checkpointing and later recover from the previous
  committed checkpoint.

## Local Base And Lower Layers

These paths are intentionally local and must not depend on JuiceFS/COS.

- `TEMP_ROOT=/var/lib/wisp/orbcrun-sg3`
- `TMP_ROOT=/var/lib/wisp/orbcrun-sg3/tmp`
- `DOCKER_ROOT=/var/lib/wisp/orbcrun-sg3/var-lib-docker`
- `LOG_ROOT=/var/lib/wisp/orbcrun-sg3/logs`
- `LOWER_ROOT=/var/lib/wisp/shared/lower`
- `LOWER_LANGUAGES=/var/lib/wisp/shared/lower/languages-image`
- `LOWER_SYSTEM=/var/lib/wisp/shared/lower/system`
- `LOWER_SYSTEM_BASE=/var/lib/wisp/shared/lower/system-base`
- `CRUN_BINARY_PATH=/var/lib/wisp/shared/tools/crun`

Intent:

- keep one host-shared read-only sysroot local
- keep one host-shared overlay lowerdir local
- keep one host-shared tool cache local

## Runtime Mount State

These paths are host-local runtime mounts and transient execution state.

- `RUNTIME_ROOT=/var/lib/wisp-runtime/orbcrun-sg3`
- `ROOTFS_MOUNT=/var/lib/wisp-runtime/orbcrun-sg3/rootfs`
- `UPPER_IMAGE_MOUNT=/var/lib/wisp-runtime/orbcrun-sg3/root-upper-rw`
- `ACTIVE_VIEW_MOUNT=/var/lib/wisp-runtime/orbcrun-sg3/rootfs/.wisp/checkpoints/active`
- `LOOP_DEVICE_FILE=/var/lib/wisp-runtime/orbcrun-sg3/loop-device`
- `PID_FILE=/var/lib/wisp-runtime/orbcrun-sg3/enter.pid`
- `CRUN_STATE_ROOT=/var/lib/wisp-runtime/orbcrun-sg3/.crun`
- `CRUN_BUNDLE_ROOT=/var/lib/wisp-runtime/orbcrun-sg3/bundle`
- `CRUN_BUNDLE_ROOTFS=/var/lib/wisp-runtime/orbcrun-sg3/bundle/rootfs`

Intent:

- hold active loop mounts
- hold overlay mountpoints
- hold the OCI bundle and crun runtime state

## Control Plane

These paths define the single-daemon control surface.

- `ADMIN_SOCKET_PATH=/run/envd/admin.sock`
- `ADMIN_LISTEN_ADDR=0.0.0.0:8520`
- `DAEMON_LOCK_FILE=/run/envd/wisp.lock`
- `ENV_SOCKET_PATH=/.wisp/api.sock`
- `ENV_SOCKET_HOST_PATH=/var/lib/wisp-runtime/orbcrun-sg3/rootfs/.wisp/api.sock`

Intent:

- enforce one daemon instance per host
- expose the admin socket on the host for local CLI control
- expose the HTTP API on TCP for remote control
- expose the env socket inside the mounted runtime rootfs

## Rootfs Inputs

These are source paths used to construct the local base layer.

- `BASE_ROOTFS_IMG`
- `BASE_ROOTFS_DIR`

They are expected to be set explicitly in [config.jsonnet](/root/myworkspace/config.jsonnet),
typically through jsonnet locals derived from a shared `projectRoot`.

## External Binary Inputs

- `CRUN_BINARY=/root/myworkspace/assets/bin/crun/crun-amd64`
- `WISPENV_BINARY=/root/myworkspace/dist/wispenv`
- `TINI_BINARY` if explicitly configured

## Legacy Compatibility Paths

- `LEGACY_RUNTIME_ROOT=/run/wisp/orbcrun-sg3`

This is kept configurable so cleanup of older runtime layouts does not depend on
Go-side hardcoded paths.

If `CRUN_BINARY` is unset, host `crun` is used.

## Product Rule

The current intended split is:

- local: base rootfs, lower layers, tool cache, runtime mountpoints
- remote: upper image state, checkpoints, policy

That means:

- the sysroot should not live on COS
- the overlay writable state should live on COS
