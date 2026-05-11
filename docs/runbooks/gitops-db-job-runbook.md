# GitOps DB Job Runbook

这份 runbook 定义统一 migration/seed 受控入口的当前实现。

## Files

- 脚本：
  - `.ci/runtime/commands/run_gitops_db_job.py`
- 历史 DB job 模板：
  - 已退役，不再作为现行入口

## Supported Matrix

- `payment` / `migration`
- `subscription` / `migration`
- `lightclaw-auth` / `migration`
- `lightclaw-auth` / `seed`
- `ai-gateway` / `migration`
- `ctl` / `migration`
- `sandbox` / `migration`

## Input Contract

必填输入：

- `service`
- `env`
- `operation`
- `revision`

可选输入：

- `image_override`
  - 当 steady-state Deployment 还没滚到目标 revision，但你已经确认某个新镜像应被用来执行 migration/seed 时使用

当前 CI 额外要求：

- `DB_JOB_KUBECONFIG_B64`

## Local Usage

示例：

```bash
python3 .ci/runtime/commands/run_gitops_db_job.py \
  --service subscription \
  --env beijing-sandbox \
  --operation migration \
  --revision af3aee8bfe49802262a6fac9195179b053cc10e5
```

真正执行：

```bash
python3 .ci/runtime/commands/run_gitops_db_job.py \
  --service subscription \
  --env beijing-sandbox \
  --operation migration \
  --revision af3aee8bfe49802262a6fac9195179b053cc10e5 \
  --apply \
  --wait
```

如果需要显式指定镜像：

```bash
python3 .ci/runtime/commands/run_gitops_db_job.py \
  --service lightclaw-auth \
  --env beijing-sandbox \
  --operation migration \
  --revision 359d9dc9309c02ecd1e56865932d461e4960b99a \
  --image-override lightclaw-bj8.tencentcloudcr.com/lightclaw/lightclaw-auth:auth-20260419-migfix-703bd999 \
  --apply \
  --wait
```

`ctl` 的示例：

```bash
python3 .ci/runtime/commands/run_gitops_db_job.py \
  --service ctl \
  --env beijing-sandbox \
  --operation migration \
  --revision 5e72ff3d624fe361897bd311db33593be2d8c8c8 \
  --apply \
  --wait
```

补充约束：

- `ctl` migration 会直接使用当前 checkout 下的 `ctl/migrations/`
- 执行前脚本会校验：
  - 当前 `HEAD` 必须等于传入的 `--revision`
  - `ctl/migrations` 目录不能有未提交改动

`sandbox` 的示例：

```bash
python3 .ci/runtime/commands/run_gitops_db_job.py \
  --service sandbox \
  --env beijing-sandbox \
  --operation migration \
  --revision 5e72ff3d624fe361897bd311db33593be2d8c8c8 \
  --apply \
  --wait
```

## CI Usage

当前模板约定这些变量：

- `DB_JOB_SERVICE`
- `DB_JOB_ENV`
- `DB_JOB_OPERATION`
- `DB_JOB_REVISION`
- `DB_JOB_IMAGE_OVERRIDE`（可选）
- `DB_JOB_KUBECONFIG_B64`
- `DB_JOB_TIMEOUT_SECONDS`（可选）

当前触发方式：

- 只允许在 `protected` ref 上出现
- 命中条件后是 `manual job`
- 推荐把 `DB_JOB_KUBECONFIG_B64` 设为 protected variable
- 推荐把 `db-job/<env>` environment 设为 protected environment

输出：

- `.tmp/db-job-result.json`

其中至少包含：

- `service`
- `operation`
- `env`
- `revision`
- `namespace`
- `job_name`
- `image`
- `status`
- `log_command`

## Current Scope

这条统一入口现在只做：

- 渲染一次性 Job
- apply
- wait
- 输出审计摘要

默认从 live Deployment 读取镜像；必要时允许显式 `--image-override`

它当前故意不做：

- 自动把 job 资源并回 root app
- 自动在 steady-state 应用同步里触发 migration/seed
- 自动做 schema rollback

补充：

- `ctl` migration 会在执行前按当前仓库 `ctl/migrations/` 临时渲染一次性 ConfigMap，再挂载给 `migrate/migrate`
- `sandbox` migration 默认从 `argocd/services/sandbox/<env>/sandbox-platform.env` 读取 `SANDBOX_MIGRATE_IMAGE`

## Safety

当前实现的安全边界：

- job 名带时间戳，不覆写历史 job
- 必须显式传 `revision`
- steady-state app 本身不受影响
- 脚本从当前 live Deployment 读取 image，避免随手跑到未知镜像
