# Database Migration Matrix

本文档记录当前仓库内数据库 migration 的实际形态，用于判断服务是否接入 CI / GitOps DB gate，以及后续是否需要统一 runner。

## 总体结论

当前主流服务的 SQL migration 文件格式已经基本统一为 `golang-migrate` 格式：

```text
000001_description.up.sql
000001_description.down.sql
000002_description.up.sql
000002_description.down.sql
```

运行状态也统一围绕 `golang-migrate` 的状态表：

```sql
schema_migrations(version, dirty)
```

当前不统一的是 runner 形态：一部分服务把 SQL embed 到服务自己的 Go migrate binary；另一部分服务仍通过通用 `migrate` CLI 镜像或命令执行目录中的 SQL。

## Migration 服务矩阵

| 服务 | Migration 目录 | 最新版本 | SQL 格式 | 当前 runner | CI/GitOps DB contract | Readiness verifier | 备注 |
|---|---|---:|---|---|---|---|---|
| `payment` | `payment/migrations` | `000001` | `golang-migrate` `.up.sql/.down.sql` | 服务内 Go binary：`payment-migrate`，embed SQL | `mode: migration`，`db_job_service: payment` | 查 `schema_migrations`，使用 `payment-config` + `payment-runtime-secrets` | Runner 形态较标准，可作为其他服务参考。 |
| `subscription` | `subscription/migrations` | `000002` | `golang-migrate` `.up.sql/.down.sql` | 服务内 Go binary：`subscription-migrate`，embed SQL | `mode: migration`，`db_job_service: subscription` | 查 `schema_migrations`，并校验 `subscription_plans` baseline | 同时承担 seed/baseline 类校验。 |
| `user-auth` | `user/auth/migrations` | `000007` | `golang-migrate` `.up.sql/.down.sql` | 服务内 Go binary：`lightclaw-auth-migrate`，embed SQL | `mode: migration`，`db_job_service: lightclaw-auth`，另有可选 `seed_operation` | 查 `schema_migrations`，使用 `lightclaw-auth-config` + `lightclaw-auth-secrets` | Bundle 名是 `user-auth`，运行服务名是 `lightclaw-auth`。 |
| `ai-gateway` | `ai-gateway/migrations` | `000004` | `golang-migrate` `.up.sql/.down.sql` | 服务内 Go binary：`ai-gateway-migrate`，embed SQL | `mode: migration`，`db_job_service: ai-gateway` | 查 `schema_migrations`，使用 `ai-gateway-runtime-config` + `ai-gateway-runtime-secrets` | Runner 里包含旧表 `schema_migration_files` 到 `schema_migrations` 的 bootstrap 兼容逻辑。 |
| `ctl` | `ctl/migrations` | `000018` | `golang-migrate` `.up.sql/.down.sql` | 通用 `migrate/migrate:v4.18.3` CLI，从 `/migrations` 目录执行 | `mode: migration`，`db_job_service: ctl` | 查 `schema_migrations`；DB 密码通过 `ctl_db_password` resolver 从 SOPS TOML 解出 | SQL 格式已统一，但 runner 仍是 CLI；可切到服务内 `ctl-migrate` Go binary。 |
| `sandbox` | `sandbox/migrations` | `000005` | `golang-migrate` `.up.sql/.down.sql` | 独立 `sandbox-migrate` 镜像，但镜像内仍是通用 `migrate` CLI | `mode: migration`，`db_job_service: sandbox`，`migration_image_key: SANDBOX_MIGRATE_IMAGE` | 查 `schema_migrations`，并校验 `pools` baseline | 保留独立 migrate 镜像是合理的，但镜像内部可改成服务内 Go runner。 |
| `trade` | `trade/migrations` | `000001` | `golang-migrate` `.up.sql/.down.sql` | 服务内 Go binary：`trade-migrate`，embed SQL | 当前 `db_contract: none` | 无正式 DB gate | 有 migrations 目录但 bundle 未声明 DB contract，这是需要明确豁免或补齐 contract 的风险点。 |

## 非 DB Migration Bundle

这些 bundle 当前显式声明 `db_contract: none`，没有正式 DB migration gate：

| Bundle | DB contract | 说明 |
|---|---|---|
| `frontend` | `none` | 静态前端，无 DB。 |
| `frontend-ds` | `none` | 前端设计系统，无 DB。 |
| `gateway-dashboard` | `none` | 管理前端，无 DB migration。 |
| `nextgen-dashboard` | `none` | 管理前端，无 DB migration。 |
| `service-gateway` | `none` | 网关服务本身不维护 DB schema。 |
| `admin-gateway` | `none` | 网关服务本身不维护 DB schema。 |
| `staticpages` | `none` | 静态页面服务，无 DB migration。 |
| `session` | `none` | 当前 bundle 未声明 DB migration。 |

## CI / GitOps 语义

当前 CI/GitOps 不直接关心 runner 是 Go binary 还是 CLI，它关心以下 contract：

| 语义 | 当前来源 | 说明 |
|---|---|---|
| 哪些文件算 migration 变更 | `.ci/runtime/bundles/*.bundle` 的 `db_contract.migration_paths` | 用于 release plan 判断 `migration_changed`。 |
| 目标 schema 版本 | `expected_migration_source` 指向的 `*.up.sql` 最大版本号 | verifier 会要求 DB 中 `schema_migrations.version >= expected_version`。 |
| 是否允许自动 DB job | `migration_operation` + 环境策略 | 预发/沙箱可由 CI 跑受控 DB Job；生产只做 readiness 或进入人工动作。 |
| DB 是否干净 | `schema_migrations.dirty = 0` | 所有 DB readiness verifier 的核心校验。 |
| baseline 是否满足 | `verifier.baseline_checks` | 例如 `subscription` 的 plan 数据、`sandbox` 的 pools 数据。 |
| 生产是否自动 migration | release gate 策略 | `shprod` / `sgprod` 不应在 Argo steady-state 中自动执行 migration。 |

## Runner 统一建议

短期不建议切 Flyway CLI。当前 SQL 格式和状态表已经统一在 `golang-migrate` 生态内，真正需要统一的是 runner 形态和 contract 表达。

优先级建议：

1. 保留现有 `golang-migrate` SQL 格式和 `schema_migrations` 状态表。
2. 将 `sandbox` 的 `sandbox-migrate` 镜像从通用 CLI 改为服务内 Go binary，保持镜像名和 `SANDBOX_MIGRATE_IMAGE` 不变。
3. 将 `ctl` 从 `migrate/migrate` 固定镜像切到 `ctl` 自己的 `ctl-migrate` Go binary，确保 migration runner 和 `SOURCE_SHA` 绑定。
4. 为 `trade` 明确补齐 `db_contract` 或添加显式豁免，避免“有 migrations 目录但 release gate 不感知”。
5. 后续可把 DB contract 下沉到服务目录，例如 `<service>/release/db-contract.yaml`，再由 bundle 引用，减少 CI 侧隐式知识。

## 为什么不把 migration 放回 Argo steady-state

Migration 是一次性副作用，不是 Kubernetes 期望态资源。生产环境应保持：

```text
CI release gate 生成 DB plan / 执行受控 Job / 做 readiness
        ↓
GitOps MR 承载 workload 与配置变更
        ↓
人工 review / merge / Argo sync
        ↓
验证 live workload 与 DB readiness
```

不要把 migration Job 当成常驻 Kustomize 资源交给 Argo 反复 reconcile，否则会带来重复执行、失败重试、回滚语义和权限边界问题。

## 生产 Migration CI

生产 DB migration 使用独立手动流水线 `.ci/db-migration.yml`，不跟随 `master` 自动执行。

执行模型：

```text
手动输入 SERVICE / TARGET_ENV / SOURCE_SHA
        ↓
Dry-run：从 SOURCE_SHA 检出源码与 migration SQL
        ↓
从 origin/gitops 检出当前部署态
        ↓
把 SOURCE_SHA 对应 bundle 的 publish_paths 临时投影到 gitops worktree
        ↓
打印将执行的 migration Job / readiness Job / image / expected schema version
        ↓
蓝盾 check-in 人工确认
        ↓
创建并等待一次性 DB Job
        ↓
运行 DB readiness verifier
```

关键参数：

| 参数 | 说明 |
|---|---|
| `SERVICE` | 支持 `payment`、`subscription`、`user-auth` / `lightclaw-auth`、`ai-gateway`、`ctl`、`sandbox`。 |
| `TARGET_ENV` | 只允许 `shprod` 或 `sgprod`。 |
| `SOURCE_SHA` | 必填；必须是已经构建出对应镜像的源码提交。 |

这个 CI 刻意把源码和部署态分开：`SOURCE_SHA` 决定 migration 代码与目标镜像 tag，`origin/gitops` 决定生产环境配置、SOPS Secret 和 kubeconfig。实际执行前必须先通过蓝盾 `check-in` 人工确认，这样生产 DB 操作可以独立追溯，不依赖 Argo sync 时隐式执行副作用。
