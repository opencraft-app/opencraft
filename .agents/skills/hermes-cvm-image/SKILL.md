---
name: hermes-cvm-image
description: 构建、复用、发布或排查 wisp/mono2 的 Hermes CVM 镜像及存量 VM 升级时使用。覆盖 COS latest、动态 backend blueprint、地域 Pool/SKU rollout、TAT 派发验证与中断 checkpoint 续跑；不用于一般 Hermes 使用或迁移包导入导出。
---

# Hermes CVM Image

本 skill 面向 `wisp/mono2` 的 Hermes CVM 镜像更新。先读本文件，再按需打开引用文件。

## 按需阅读

- 构镜、复用、地域发布和用户机验收：读 [references/release-sop.md](references/release-sop.md)。
- runner 中断、担心重复升级、checkpoint 迁移、nohup/tmux 续跑：读
  [references/recovery-sop.md](references/recovery-sop.md)。
- 2026-09 版本误判、新山镜像回写、上海大库存失败：读
  [references/2026-09-upgrade-lessons.md](references/2026-09-upgrade-lessons.md)。

先核对当前 checkout 与 `origin/master`。历史版本、机器和 build ID 只能用于定位历史证据。
本文更新不授权发布、重试或生产写入；实际操作沿用当前用户授权范围。

## Source of Truth

- Pipeline: `.ci/hermes-image.yml`
- Image build docs: `images/README.md`
- Build manifest: `images/build-manifest.json`
- Dynamic backend blueprint: `images/helpers/resolve-hermes-backend-blueprint-id.py`
- CI trigger file: `images/hermes-image-trigger`
- Existing VM repair script: `images/helpers/config-hermes-python-mirrors.sh`
- Pool refresh: `.ci/runtime/commands/refresh_hermes_sandbox_env.sh`
- Existing VM repair stage: `.ci/runtime/commands/repair_hermes_existing_vms.sh`
- Existing VM inventory: `.ci/runtime/commands/list_hermes_pool_vms.sh`
- Region-local SKU refresh: `.ci/runtime/commands/refresh_hermes_sandbox_pools.sh`
- TAT command and invocation: `.ci/runtime/commands/create_hermes_tat_command.sh`, `.ci/runtime/commands/invoke_hermes_tat_command.sh`
- CLI version parser: `images/lib/hermes-version.sh`
- Release responsibility: `docs/engineering/domains/release-gitops.md`

## Update Flows

### Build a new Hermes image

1. Change the real image input:
   - Hermes/runtime behavior: `images/build.sh`, `images/build-image.py`, `images/build-manifest.json`, or related tests.
   - Backend blueprint: resolver 默认查询北京 NORMAL `hermes_agent`、排除南京候选、按 CreatedTime 选最新；需要固定本轮目标时使用 `HERMES_BACKEND_BLUEPRINT_ID`。旧 `images/hermes-backend-blueprint-id` 文件已不是当前真源。
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

The build stage will resolve image IDs for Beijing, Shanghai, Singapore, Tokyo, and Johor and skip image creation. Reuse preserves the old image contents; it does not include new source changes. Use it for an authorized rollout recovery.

### Repair existing VMs only

Prefer the pipeline stage unless the user explicitly asks for ad hoc execution. The repair stage creates Tencent Cloud TAT Commands from the checked-in script; do not require a preexisting `HERMES_TAT_COMMAND_ID`.

The TAT payload should run as root/default. The script itself locates `LIGHTCLAW_RUNTIME_USER` defaulting to `agentuser`, fixes ownership and permissions, ensures `acli backend` is available for that user, then runs:

```bash
acli backend upgrade-start --blueprint-id "$HERMES_BACKEND_BLUEPRINT_ID" --wait=true --force=true
```

as `agentuser`.

该 payload 没有机器上的“已到目标版本就跳过”判断；重复派发可能再次升级/重启。当前 checkpoint
仅按 cloud_id 跳过已有 `INVOKED`，它表示 TAT 接受派发，不能证明远端执行完成。恢复必须读 recovery SOP。

## 证据与边界

- `runtime_hermes.version/src_version/git_commit` 留空时，CI 解析 COS latest 并向远程传入当次固定值。
  backend blueprint 是另一动态来源。保留现有安装后 source restore/pin 和 runtime 验证；不默认新增
  COS 与 blueprint 语义版本必须相等的门禁。每轮记录实际 version/src_version/git_commit/blueprint。
- CLI 版本只从规范 `Hermes Agent vX.Y.Z` 行解析，不能从 SSH 错误或 IP 中抓首个数字。
- 镜像、Pool/SKU、CLEAN 库存 reset、存量 TAT 接受、远端终态和用户业务分别验收。
  Bot Running、stage SUCCEED、progress=100%、exit 0 均不能单独证明存量升级成功。
- Pool patch 会把 CLEAN 标为 DRY 后交 worker 重装，选择器包含 paused Pool；ALLOCATED/PAUSED
  用户机应保持状态。按 ID 比对，计数不变不能证明同一批用户机未受影响。verify_refresh 只检查镜像字段。
- 每个 SKU 独立判断 Pool 地域集合：目标 region 独占 SKU 同步 desired image；跨地域共享 SKU
  保留 Pool 地域 image 权威。未知 zone/绑定异常先核对，不能据此判为独占。
- checkpoint 有 API 接受后尚未落盘的窗口；它不提供 exactly-once，也不验证 payload hash。
  旧阶段 retry 可能固定触发 SHA，合入 master 不保证重试读新代码。重复派发前查原 invocation。
- runner 由实际任务 node_alias 确认，不能凭历史 IP 猜 cn-pool。凭据从受保护环境读取，不写入
  skill、MR、命令参数或 wrapper；不要使用 `sshpass -p` 暴露密码。

## Pipeline Order

The expected production-safe order is:

```text
build and sync image to ap-beijing, ap-shanghai, ap-singapore, ap-tokyo, ap-johorbahru
-> read-only preflight Beijing sandbox pools and VM inventory
-> manual gate 1
-> refresh Beijing sandbox Hermes pools
-> repair existing Beijing Hermes VMs
-> read-only preflight Singapore production pools and VM inventory
-> manual gate 2
-> refresh Singapore production Hermes pools
-> repair existing Singapore production Hermes VMs
-> read-only preflight Johor production pools and VM inventory
-> manual gate 3
-> refresh Johor production Hermes pools
-> repair existing Johor Hermes VMs
-> manual gate 4
-> refresh Shanghai production pools
-> repair existing Shanghai production Hermes VMs
```

Beijing sandbox is the test pre-release environment and must roll out before Singapore, Johor, or Shanghai production. Singapore and Johor share the `sgprod` Sandbox control plane, but inventory, Pool refresh, and TAT repair must remain region-scoped by `pool.zone`. Do not skip the read-only preflight stages or publish Shanghai before the earlier regions pass unless the user explicitly requests that risk.

## Verification Checklist

Before claiming success, inspect the pipeline logs for:

- Build stage printed `HERMES_IMAGE_NAME` and `HERMES_IMAGE_ID_AP_BEIJING`, `HERMES_IMAGE_ID_AP_SHANGHAI`, `HERMES_IMAGE_ID_AP_SINGAPORE`.
- New-image flow ran `python3 images/build-image.py --runtime hermes ... --with-verify`; reuse flow printed `Reusing existing Hermes CVM image by exact name`.
- Singapore preflight resolved the ap-singapore image, listed sgprod Hermes VM rows, and failed before manual approval if inventory was empty.
- Beijing preflight resolved the ap-beijing image, listed beijing-sandbox Hermes VM rows, and failed before manual approval if inventory was empty.
- Singapore stages use `sgprod:ap-singapore:kubeconfig_sgprod`.
- Johor stages use `sgprod:ap-johorbahru:kubeconfig_sgprod` and only select `ap-johorbahru-*` Pools.
- Beijing stages use `beijing-sandbox:ap-beijing:kubeconfig_beijing_sandbox`.
- Shanghai stages use `shprod:ap-shanghai:kubeconfig_shprod`.
- Existing VM repair logs show a reviewed VM list and TAT summary JSON files. Inspect INVOKE_FAILED even when exit is 0, then query invocation execution status and actual machine version.
- TAT API dispatch runs in serial batches of 5, with individual retry fallback; remote tasks may execute concurrently because invoke does not wait for completion.
- No step performs direct database writes or SQL.

If Shanghai production VM count is unexpectedly small, inspect the inventory stage and `HERMES_LEGACY_POOL_IDS`. The Shanghai default should include:

```text
pool-bj8,pool-c0,pool-c1,pool-c2,pool-c3,pool-c4,pool-c5
```

## Local Checks

纯 skill 更新只校验 frontmatter、引用、命令与实际源码一致性以及 `git diff --check`；
下列测试用于运行时脚本变更。skill-only commit 不要顺手修改 images trigger 或启动云上升级。

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
