---
id: task-hermes-production-npm-recovery-20261012
type: task
scope: 新加坡 Hermes 失败实例的定向 CI 补救与严格验收。
triggers: ["Hermes 生产 npm 补救", "新加坡升级超时", "定向 CI 补救"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth: [".ci/hermes-production-recovery.yml", "images/helpers/recover-hermes-runtime.py"]
status: active
reviewed_at: 2026-10-12
review_due: 2026-11-12
revision: 1.0.0
precedence: task
derived: false
---

## goal
通过 CI 完成用户授权的全网 Hermes 0.21.5 发布；本变更补救新加坡两台升级失败机器。

## non_goals
不轮换渠道凭据、不唤醒暂停机器、不重复升级已验收成功机器、不替换用户源码树。

## requirement_ids / requirement_refs / requirement_excerpt
用户要求“发到全网…生产环境…走ci流程”，并在渠道异常说明后明确允许继续。

## interface_refs / data_structure_refs
定向入口为 `.ci/hermes-production-recovery.yml`，目标清单为 `images/hermes-production-recovery-targets.json`。
官方 ACLI 升级 capability 要求 root，运行时身份仍必须是 agentuser。TAT 接受下发不等于执行成功。

## history_context
- current_design_refs：`docs/engineering/domains/release-gitops.md` 和 `images/README.md`。
- relevant_evolution：!5193 / 430726f9 已修复升级前未刷新 ACLI bundle 的问题；本轮 #35 使用该源码。
- superseded_refs：旧记录仅作为失败证据，不替代实时验收。

## acceptance
仅名单内、原任务终态失败且仍为新加坡 ALLOCATED/RUNNING 的机器可补救。
必须验证官方升级完成标记、四处实际版本 0.21.5 和主网关活跃；原活跃网关也必须保持活跃。
CI 先只读预检，经地域人工关卡后逐台执行，单机失败即停止。

## affected_paths
独立补救流水线、运行时命令与模块、远端补救脚本、专项测试、运行时文件清单及发布设计。
主镜像流水线忽略这三份独立补救输入，避免无关镜像重建。

## required_context
发布与 GitOps、CI 服务入口、Hermes 镜像技能。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@430726f9` | 根边界 | Git、生产授权及验证 |
| `.ci/AGENTS.md@430726f9` | CI 边界 | 凭据与流水线保护 |
| `docs/context/domains/release-gitops.md@430726f9` | 路由要求 | 区分源码与实际部署 |
| `docs/context/project/services/ci.md@430726f9` | 路由要求 | 运行时检查 |
| `docs/context/project/adjacency/argocd-ci-secrets.md@430726f9` | 邻接检查 | 已查北京严格验收流水线及测试 |
| `.agents/skills/hermes-cvm-image/SKILL.md@430726f9` | 发布补救 | 地域顺序、官方升级、断点对账 |

## evidence
#35 第四次执行跳过 422 台成功机器，仅重试三台原失败机器；其中网关安装失败机器已恢复并验证版本及网关。
其余两台分别再次超时。只读探针证明 ins-ghic4pt0 无法解析默认 npm 内网镜像，但可以访问公网 npm。
已核对该机器的运行用户、运行时目录与 CLI。另一台只读探针投递不稳定，不能宣称机器健康。
官方 CLI 本地隔离验证证明：非 root 调用的 sudo 环境白名单不含 npm 参数；root 调用保留参数及运行时身份。

## risks
版本一致不能替代升级完成。下发结果不确定时必须对账，不能自动重复强制升级。
原始升级日志仅保留在机器受保护文件，CI 只接收结构化验收结果。

## validation
8 项专项测试通过；完整 CI runtime 检查通过（662 项，4 项跳过）；两台目标只读预检通过。
文档校验和变更影响检查通过。仓库全量 Context 测试存在历史文档规范失败，另行记录，不混入本次修复。

## decisions
保持 #35 新山关卡等待。补救仍走官方 ACLI 备份与升级事务；固定 COS 包和展示版本，使用公网 npm 源。
TAT 超时为 2400 秒，覆盖官方 1800 秒升级及 bundle 刷新。命令内容摘要、目标计划与调用意图持久化。

## scan_scope
存量升级 helper、下载的官方升级入口与 capability、CI 运行时及相邻测试；未读取或提交凭据值。

## scan_output
初始查询未命中；明确 CI 路径后命中发布与 CI 两份上下文。完整现场证据保留在 Git 外受保护目录。

## handoff
独立工作树内实现与测试已完成，待正常 MR 评审及授权范围内的 CI 执行；全网发布尚未完成。
