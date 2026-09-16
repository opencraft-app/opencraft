# Collaboration 北京首次发布 Runbook

## 边界

- 只处理 `beijing-sandbox`，复用既有 `cynosdb-bj8`，不创建 DB 实例。
- 只通过 `.ci/collaboration-bootstrap.yml` 写入；DevCloud 仅用于只读诊断。
- GitOps MR 不自动合并；foundation 与 runtime 必须分两次运行和审查。
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
   `database migrate` Job 和只读 `database verify` Job。
3. 两个 Job 成功后才允许生成 runtime GitOps MR。MR 将 active catalog 切换到 runtime sourcePath，
   不保留 migration Job。
4. 合入后分别记录 Argo revision、Deployment imageID、`Synced/Healthy`、Pod Ready、Service endpoint
   与 `/healthz`/`/readyz` 结果。

## 后续验收

1. 单独激活 Gateway 上游与匹配 token，先保持产品入口关闭。
2. 使用 LightVela 真实账户验证 Server、Members、IM 群聊和私聊；IM Chat 与 Codex 会话 UI 分开验收。
3. 后台、Gateway、IM 均通过后再发布/开启 OpenCraft Collaboration 插件入口。

## 失败恢复

- 普通重跑不得携带 rotation 参数。
- 账号已存在但 SSM 丢失时，审查后才允许 `--allow-database-password-reset`。
- IM Secret 明确轮换时，审查后才允许 `--allow-im-secret-rotation`；JWT、IM identity、callback token
  不随之变化。
- foundation/runtime MR 未合入时，回滚是关闭 MR/删除 promote branch；已合入后通过新的 GitOps MR
  回退 active catalog 或镜像，禁止直接 patch Argo 管理字段。
