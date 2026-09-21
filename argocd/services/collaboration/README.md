# Collaboration 北京交付

源码构建入口是 `.ci/collaboration.yml`，复用 `service-release.yml` 与独立
`collaboration` bundle，仅构建北京镜像。默认 `MASTER_AUTO_PIN_ENVS=none`，
`ENABLE_MASTER_PROD_PROMOTE=false`，因此合入源码不会自动创建业务 workload。

`catalogs/candidates/beijing-sandbox/` 中的两个描述符不在 AppSet 扫描范围内。
它们描述同一个 `collaboration-beijing-sandbox` Application 的先后两个阶段，
不能同时加入 active catalog，也不能新增手写 leaf Application。

首次上线只通过 `.ci/collaboration-bootstrap.yml` 执行，禁止在 DevCloud 手工调用 CynosDB、SSM、
kubectl 或复制 YAML。流水线固定为 dry-run → 人工审批 → apply/GitOps MR；MR 不自动合并。

1. `foundation` 阶段由 `infractl bootstrap-collaboration` 从 inventory 核对并幂等准备现有
   普通 DB 服务内的独立逻辑库/账号/DSN；不新建 DB 实例。IM material 只从 protected setting
   生成的临时 `0600` 文件读取。
2. 同一阶段创建/核对 SSM `mono-beijing-sandbox-collaboration-runtime-secrets` 的六个必填键，按
   `scripts/ssm_manifest.collaboration.beijing-sandbox.yaml` 导出真正的 SOPS artifact。
3. 自动 GitOps 投影以 `collaboration-foundation.yaml` 建立 active
   `argocd/catalogs/sandbox/beijing-sandbox/collaboration.yaml`。审查并通过正常 GitOps
   流程交付，等待 Namespace/Secret 基础阶段收敛；该阶段没有 Deployment/Service/Job。
4. 流水线把 protected setting 中的公开 IM AppID/管理员与 digest 镜像写入
   `beijing-sandbox/collaboration-platform.env`；不把 IM Secret 写入普通配置。
5. foundation 收敛后以 `BOOTSTRAP_PHASE=runtime` 重跑。配置门禁要求 active catalog 仍指向
   foundation、SOPS artifact 存在、镜像按 digest 固定且所有占位符已消除。
6. runtime 阶段 DB gate 以显式普通 `mysql` 方言先执行受控 `collaboration/migration` Job，再执行同一候选镜像的
   `database verify`；两者只挂 `database.dsn` 文件，不把 DSN 放入 argv/env 或日志。
   每次晋级都跑幂等迁移和 verify，首次发布不会依赖当前 diff 恰好包含 SQL；不得把普通
   MySQL DSN 改标成 `tdsql` 来绕过平台差异。
7. 门禁成功后自动投影 active 描述符为 runtime sourcePath 并创建 GitOps MR；合入后再确认 Argo revision、镜像、
   `Synced/Healthy` 与 API 健康。Migration 不在常驻 Kustomize 中。

Gateway 上游配置与匹配的内部 token 仍是单独的激活步骤，本轮不开放用户流量。
缺少 SSM、SOPS、平台值或基础阶段时保持候选状态，不提交伪造的 Secret、旧服务镜像
或复制其他环境的凭据来获得可渲染表象。上海、新加坡及 Playground 不随北京接入。
