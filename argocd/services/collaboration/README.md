# Collaboration 北京交付

源码构建入口是 `.ci/collaboration.yml`，复用 `service-release.yml` 与独立
`collaboration` bundle，仅构建北京镜像。默认 `MASTER_AUTO_PIN_ENVS=none`，
`ENABLE_MASTER_PROD_PROMOTE=false`，因此合入源码不会自动创建业务 workload。

`catalogs/candidates/beijing-sandbox/` 中的两个描述符不在 AppSet 扫描范围内。
它们描述同一个 `collaboration-beijing-sandbox` Application 的先后两个阶段，
不能同时加入 active catalog，也不能新增手写 leaf Application。

首次上线顺序（均需另行授权）：

1. 在现有普通 DB 服务上准备独立 Collaboration 逻辑库/账号/DSN；不新建 DB 实例。
2. 准备 SSM `mono-beijing-sandbox-collaboration-runtime-secrets` 的六个必填键，按
   `scripts/ssm_manifest.collaboration.beijing-sandbox.yaml` 导出真正的 SOPS artifact。
3. 以 `collaboration-foundation.yaml` 的内容建立 active
   `argocd/catalogs/sandbox/beijing-sandbox/collaboration.yaml`。审查并通过正常 GitOps
   流程交付，等待 Namespace/Secret 基础阶段收敛；该阶段没有 Deployment/Service/Job。
4. 在源码中配置 `beijing-sandbox/collaboration-platform.env` 的真实 IM AppID/管理员，
   将同一个 active 描述符切换为 `collaboration.yaml` 的 runtime sourcePath。
5. 构建/选择 digest 镜像，再手动发起 Collaboration promote。配置门禁要求 active
   catalog 与 SOPS artifact 均存在，并校验完整 Kustomize closure、镜像 pin 与所有占位符。
6. DB gate 以显式普通 `mysql` 方言先执行受控 `collaboration/migration` Job，再执行同一候选镜像的
   `database verify`；两者只挂 `database.dsn` 文件，不把 DSN 放入 argv/env 或日志。
   每次晋级都跑幂等迁移和 verify，首次发布不会依赖当前 diff 恰好包含 SQL；不得把普通
   MySQL DSN 改标成 `tdsql` 来绕过平台差异。
7. 门禁成功后才创建/合入 GitOps runtime MR，再确认 Argo revision、镜像、
   `Synced/Healthy` 与 API 健康。Migration 不在常驻 Kustomize 中。

Gateway 上游配置与匹配的内部 token 仍是单独的激活步骤，本轮不开放用户流量。
缺少 SSM、SOPS、平台值或基础阶段时保持候选状态，不提交伪造的 Secret、旧服务镜像
或复制其他环境的凭据来获得可渲染表象。上海、新加坡及 Playground 不随北京接入。
