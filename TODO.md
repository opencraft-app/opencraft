# TODO

## P0 - CI / GitOps 发布链路

- [ ] 让 `promote` 去快照化
  当前 `promote-*` 分支还会复制 `.ci/init.sh`、`scripts/gitops_merge_request.py`、`scripts/gitops_cleanup_source_branch.py`、`scripts/gitops_merge_request_note.py`、`scripts/verify_gitops_release.py`、`.ci/gitops-promotion.yml`。这会导致老 promote 分支冻结旧执行逻辑，`master` 上的修复不能自动继承。

- [ ] 给 `gitops-promotion` 引入显式的 CI runtime ref
  不要隐式依赖“当前 `master`”或“promote 分支快照”。需要明确记录这次发布提案使用的是哪一版执行逻辑，保证可审计、可回放。

- [ ] 重新定义 `gitops-promotion` 的职责边界
  当前它同时负责 promote 合法性检查、自动 merge、MR comment、环境验收和 cleanup，已经接近轻量发布控制器。需要明确哪些能力保留在这里，哪些迁回平台公共层。

- [ ] 停止把环境验收和执行面问题混在一起
  发布失败时需要区分：
  - promote / MR 逻辑错误
  - Argo 控制面入口错误
  - 目标 app 未纳管 / 被 prune
  - 环境执行依赖缺失
  避免一律表现成脚本进程失败。

## P0 - Argo 控制面 / 环境真相

- [ ] 对齐 live Argo 与 `origin/gitops` 的真实内容
  当前北京 live `root-beijing-sandbox` 只管理少量 leaf apps，并且历史上 prune 过 `gateway-dashboard-beijing-sandbox`、`ctl-beijing-sandbox`。需要确认：
  - live Argo 实际消费的 `gitops` 内容
  - `root-beijing-sandbox` 当前真正扫描到的入口集合
  - 哪些 app 是“应该存在但未纳管”，哪些是“按设计不再纳管”

- [ ] 明确统一 Argo CD 控制面的正式入口和凭据来源
  现在已切到直接走 Argo API，但仍需把：
  - 基础 URL
  - 认证方式
  - 本地机密文件路径
  固化成正式约定，避免继续依赖仓库内 kubeconfig 或历史控制面概念。

## P1 - `.ci` 结构治理

- [ ] 减少服务级 `.ci/*.yml` 的重复
  `ai-gateway.yml`、`ctl.yml`、`payment.yml`、`subscription.yml` 等大部分只是服务名、路径和 tag 前缀不同。需要考虑用生成方式或统一模板降低重复维护成本。

- [ ] 继续把公共环境依赖收口到 `.ci/init.sh`
  当前已收口：
  - repo root
  - Node
  - pnpm
  - kubectl
  - Cloudflare 票据
  后续新增运行时依赖时，不要再散回单个 YAML 或单个 Python 脚本。

- [ ] 去掉 `.ci` 中已经过时的 bootstrap 残留
  例如某些链路仍保留 `ci_ensure_kubectl` 之类的历史调用，而新验收逻辑已经走 Argo API。需要统一清理。

- [ ] 拆分 `.ci/README.md`
  当前内容同时承担：
  - 模型说明
  - 经验记录
  - 运行前提
  - 排障手册
  建议拆成更清晰的文档层次。

## P1 - 多环境发布模型

- [ ] 明确北京环境作为“预发布环境”的工作流
  需要写清：
  - `master`
  - `beijing-sandbox`
  - `shprod`
  三层之间的推进关系，以及北京到底是自动持续预发布还是受控预发布。

- [ ] 明确 `gitops` 承载多环境发布视图的规则
  `gitops` 需要统一承载测试、预发、生产多个环境，但要有清晰规则说明：
  - 什么进入 `gitops`
  - 哪些环境自动推进
  - 哪些环境必须手动 promote

## P2 - 文档与历史资产清理

- [ ] 清理脚本和文档里的历史 `hk-*` / 旧控制面命名
  文档口径已经改到“统一 Argo CD 控制面”，但脚本默认值、历史脚本名和部分平台配置里还残留旧命名。

- [ ] 处理历史 runbook / 历史入口文档
  对已经不再代表现行模型的 runbook 和说明文档，区分：
  - 继续保留但归档
  - 直接删除
  避免新协作者继续把历史文档当现行规范。
