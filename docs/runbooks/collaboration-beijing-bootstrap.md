# Collaboration 北京首次发布 Runbook

## 边界

- 只处理 `beijing-sandbox`，复用既有 `cynosdb-bj8`，不创建 DB 实例。
- 只通过 `.ci/collaboration-bootstrap.yml` 写入；DevCloud 仅用于只读诊断。
- GitOps MR 不自动合并；foundation 与 runtime 必须分两次运行和审查。
- “恢复 Collaboration 北京空基线”是只针对已知残留的独立受控流水线，不代替
  foundation/runtime，也不获取 IM、云账号、SOPS 或 Git token。
- 不开放 Computer、Tasks、Reminders；Gateway 与 LightVela Web 在后台验活后另行激活。

## 前置

1. master 已包含目标 Collaboration source，且北京镜像已按 digest 推送。
2. `infra_pulumi/envs/tencentcloud/beijing-sandbox/inventory.yaml` 中的 cluster、endpoint、DB、账号、
   SSM、namespace 和 node pool 已通过只读 API/集群探针复核。
3. Stream protected settings 已配置：
   - 启动变量 `COLLABORATION_IM_SDK_APP_ID`：北京 `AgentNetwork` 默认使用 `1600137234`
   - protected `COLLABORATION_IM_CREDENTIAL`：username 为 IM 管理员，password 为 IM SecretKey
   - `DB_JOB_KUBECONFIG_B64`
   - `SOPS_AGE_KEY` 或 `SOPS_AGE_KEY_FILE`
   - Git WOA private token（或 runner 上的受控 token 文件）
4. 不在工单、日志、启动参数或仓库中粘贴任何上述秘密值。

## Foundation

1. 手动执行“初始化 Collaboration 北京”，保持 `BOOTSTRAP_PHASE=foundation`，核对 `SOURCE_SHA` 与
   `COLLABORATION_IMAGE` 的 digest provenance。
2. Dry-run 必须显示目标 SSM、账号、数据库和权限的 would-create/would-update/unchanged，不得出现
   其他环境或数据库实例。
3. 人工批准后，apply 幂等写入 DB/SSM，导出加密 SOPS，并创建 foundation GitOps MR。
4. 评审 MR 只包含 Collaboration bundle、active foundation catalog、平台值和加密 Secret；确认没有
   明文 Secret、Deployment、Service 或 Job。
5. 合入后证明 GitOps desired revision、`lightvela-collaboration` Namespace、ServiceAccount、Secret
   均收敛；此时后台仍未启动。

## Runtime

1. foundation 收敛后，以 `BOOTSTRAP_PHASE=runtime` 和同一 source/image digest 重跑流水线。
2. Dry-run 必须显示 bootstrap 幂等；人工批准后流水线从 gitops branch 读取 deploy root，运行一次性
   `database migrate` Job 和只读 `database verify` Job。两个 Job 必须使用启动参数中同一个
   digest-pinned `COLLABORATION_IMAGE`；verify 不得读取 foundation platform 中的旧镜像。
3. 两个 Job 成功后才允许生成 runtime GitOps MR。MR 将 active catalog 切换到 runtime sourcePath，
   不保留 migration Job。
4. 合入后分别记录 Argo revision、Deployment imageID、`Synced/Healthy`、Pod Ready、Service endpoint
   与 `/healthz`/`/readyz` 结果。

## 空基线 Recovery

1. 仅当 migration 因已知连续分号缺陷留下精确 `20260801000000 applied=1/50`
   状态时，使用包含 `recover-empty-baseline` 的新镜像手动运行“恢复 Collaboration 北京空基线”。
   `SOURCE_SHA` 与 `COLLABORATION_IMAGE` 必须是同一主干构建的可验证来源。
2. Dry-run 会创建一次性 `recovery-plan` Job；它只读核对 baseline hash、claim、
   `statement_failed`、空 `error_stmt`、partial hash、表集与行数。审批页必须明确显示只有
   `account_login_identities` 一张表且为 0 行；成功 Job 的脱敏 CLI 摘要必须在清理前写入
   流水线审计 JSON，不能只凭 `status=succeeded` 批准。
3. 人工审批后，`recovery-apply` Job 再次执行同一组前置校验，然后删除 0 行表并以
   完整 revision 身份做 CAS delete。随后再运行 `recovery-plan`，只有回读“数据库已为空”
   才算完成。
4. Recovery 流水线只注入 DB Job kubeconfig，不调用 cloud bootstrap、不导出 SSM/SOPS、
   不生成 GitOps MR，也不自动执行
   runtime。恢复成功后仍需另起一次 `BOOTSTRAP_PHASE=runtime` 流水线。
5. 任何表非空、多表、未知 revision/hash/claim、非 MySQL 方言或回读非 empty 都必须停止；
   不得改用手工 SQL 绕过。

## 后续验收

1. 单独激活 Gateway 上游与匹配 token，先保持产品入口关闭。
2. 使用 LightVela 真实账户验证 Server、Members、IM 群聊和私聊；IM Chat 与 Codex 会话 UI 分开验收。
3. 后台、Gateway、IM 均通过后再发布/开启 OpenCraft Collaboration 插件入口。

## 失败恢复

- 普通重跑不得携带 rotation 参数。
- DB/SSM 或目标库权限已写入、但 SSM→SOPS 导出失败时，先修复流水线 Python 依赖，再运行只读
  dry-run 核对云端状态；重新审批后幂等重入，不手工搬运 Secret 或直接修改 GitOps。
- 账号已存在但 SSM 丢失时，审查后才允许 `--allow-database-password-reset`。
- IM Secret 明确轮换时，审查后才允许 `--allow-im-secret-rotation`；JWT、IM identity、callback token
  不随之变化。
- foundation/runtime MR 未合入时，回滚是关闭 MR/删除 promote branch；已合入后通过新的 GitOps MR
  回退 active catalog 或镜像，禁止直接 patch Argo 管理字段。
