---
name: hermes-cvm-image
description: 更新、复用、触发、排查 Hermes CVM 镜像流水线时使用。适用于修改 Hermes 镜像内容、backend blueprint 基线、images/hermes-image-trigger、刷新 Hermes sandbox pools、升级存量 Hermes VM、查看“构建 Hermes CVM 镜像”流水线日志。
---

# Hermes CVM Image

本 skill 面向 `wisp/mono2` 的 Hermes CVM 镜像更新。先读本文件，再按需打开引用文件。

## Source of Truth

- Pipeline: `.ci/hermes-image.yml`
- Image build docs: `images/README.md`
- Build manifest: `images/build-manifest.json`
- Backend blueprint baseline: `images/hermes-backend-blueprint-id`
- CI trigger file: `images/hermes-image-trigger`
- Existing VM repair script: `images/helpers/config-hermes-python-mirrors.sh`
- Pool refresh: `.ci/runtime/commands/refresh_hermes_sandbox_env.sh`
- Existing VM repair stage: `.ci/runtime/commands/repair_hermes_existing_vms.sh`
- Existing VM inventory: `.ci/runtime/commands/list_hermes_pool_vms.sh`

## Update Flows

### Build a new Hermes image

1. Change the real image input:
   - Hermes/runtime behavior: `images/build.sh`, `images/build-image.py`, `images/build-manifest.json`, or related tests.
   - Backend blueprint only: edit `images/hermes-backend-blueprint-id`; keep it one line containing only `lhbp-...`.
2. Force the next master build to create a fresh image by editing `images/hermes-image-trigger` and appending a line whose last `reuse=` value is empty, for example:

   ```text
   2026-06-11T12:00:00+08:00 rebuild-hermes-after-blueprint-update reuse=
   ```

   Do not append a line without `reuse=` when the previous trigger line contains a reuse image name; the pipeline extracts the last matching `reuse=` value.

3. Submit an MR to `master`. The Hermes pipeline auto-triggers on `images/**` changes.

### Reuse an existing Hermes image

Append a trigger line with the exact image name:

```text
2026-06-11T12:00:00+08:00 rerun-hermes-rollout reuse=hermes-agent-b-...
```

The build stage will resolve image IDs for Beijing, Shanghai, and Singapore and skip image creation. Use this to rerun pool refresh or TAT repair without rebuilding.

### Repair existing VMs only

Prefer the pipeline stage unless the user explicitly asks for ad hoc execution. The repair stage creates Tencent Cloud TAT Commands from the checked-in script; do not require a preexisting `HERMES_TAT_COMMAND_ID`.

The TAT payload should run as root/default. The script itself locates `LIGHTCLAW_RUNTIME_USER` defaulting to `agentuser`, fixes ownership and permissions, ensures `acli backend` is available for that user, then runs:

```bash
acli backend upgrade-start --blueprint-id "$(cat images/hermes-backend-blueprint-id)" --wait=true
```

as `agentuser`.

## Pipeline Order

The expected production-safe order is:

```text
build and sync image to ap-beijing, ap-shanghai, ap-singapore
-> manual gate 1
-> refresh Beijing main sandbox pools
-> repair existing Beijing Hermes VMs
-> manual gate 2
-> refresh Shanghai production pools
-> repair existing Shanghai production Hermes VMs
```

Do not change this to publish Shanghai before Beijing passes unless the user explicitly requests that risk.

## Verification Checklist

Before claiming success, inspect the pipeline logs for:

- Build stage printed `HERMES_IMAGE_NAME` and `HERMES_IMAGE_ID_AP_BEIJING`, `HERMES_IMAGE_ID_AP_SHANGHAI`, `HERMES_IMAGE_ID_AP_SINGAPORE`.
- New-image flow ran `python3 images/build-image.py --runtime hermes ... --with-verify`; reuse flow printed `Reusing existing Hermes CVM image by exact name`.
- Beijing stages use `beijing-sandbox:ap-beijing:kubeconfig_beijing_sandbox`.
- Shanghai stages use `shprod:ap-shanghai:kubeconfig_shprod`.
- Existing VM repair logs show a nonzero VM list and TAT summary JSON files.
- TAT runs in serial batches; default batch size is 5 and failed batches fall back to single-machine retry.
- No step performs direct database writes or SQL.

If Shanghai production VM count is unexpectedly small, inspect the inventory stage and `HERMES_LEGACY_POOL_IDS`. The Shanghai default should include:

```text
pool-bj8,pool-c0,pool-c1,pool-c2,pool-c3,pool-c4,pool-c5
```

## Local Checks

Run focused checks after editing pipeline or image scripts:

```bash
bash -n images/build.sh images/deploy-build.sh images/helpers/config-hermes-python-mirrors.sh \
  .ci/runtime/commands/refresh_hermes_sandbox_env.sh \
  .ci/runtime/commands/refresh_hermes_sandbox_pools.sh \
  .ci/runtime/commands/repair_hermes_existing_vms.sh \
  .ci/runtime/commands/list_hermes_pool_vms.sh \
  .ci/runtime/commands/create_hermes_tat_command.sh \
  .ci/runtime/commands/invoke_hermes_tat_command.sh
python3 -m py_compile images/build-image.py
python3 images/tests/test-build-image-sync.py
```

For broader CI runtime changes, also run:

```bash
bash .ci/runtime/check_ci_runtime.sh
```
