# sgprod 存量多 gateway 建站凭据定向修复

## goal
对一台已证实运行多个 Hermes gateway unit 的旧实例，安全补发独立网站凭据并确认每个 unit 和认证能力，同时保留默认单 unit 安全边界。

## non_goals
- 不修改新购地域 Command 映射，不批量变更其他存量 CVM。
- 不用此脚本修复缺失 TAT Agent、无 gateway unit、无运行时可执行文件或缺失 agentuser 的机器。

## requirement_refs / acceptance
生产事故 Goal：存量 Website Builder Skill 与逐实例网站凭据闭环。目标 CTL↔Sandbox↔CVM/Pool 实时一致、TAT Agent Online，先检查现有凭据文件和 unit 类型；专用命令仅带 hidden 参数。TAT 终态 SUCCESS/0、全部 unit active、文件属主/权限、Skill 精确哈希、实例凭据认证 capability 200；失败撤销新 Key 且不破坏旧配置。

## interface_refs / data_structure_refs
`images/helpers/install-hermes-website-credential.sh` 的 `HERMES_GATEWAY_MODE=all` 为显式 opt-in，默认多 unit fail-closed；`.ci/runtime/commands/create_hermes_website_credential_command.sh` 使用 TAT hidden `website_key`，不记录明文。

## history_context
生产新购地域修复已单独由 !4757、!4758、!4759 发布；本任务只解决存量异常类别中的一个多 unit CVM。正式约束见 `docs/engineering/domains/release-gitops.md`。

## affected_paths
`images/helpers/install-hermes-website-credential.sh`、`images/tests/test-hermes-website-credential-scripts.sh`、`.ci/runtime/commands/create_hermes_website_credential_command.sh`、`docs/engineering/domains/release-gitops.md`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md` | 生产与凭据边界 | 发布门禁和测试 |
| `.ci/AGENTS.md` | TAT/发布脚本 | 控制面与安全 |
| `docs/context/domains/agent-gateway-runtime.md` | runtime 路由结果 | 上游归属 |
| `docs/engineering/domains/release-gitops.md` | 发布真源 | 定向操作约束 |
| `docs/context/project/adjacency/README.md` | 已读相邻边界索引，无本任务匹配的卡；回到精确源码与测试 | 限定实施范围 |

## risks / rollback
客户机可能有多个 Bot，默认不猜测唯一 unit。仅在逐实例身份一致且多个目标 unit 均确认后创建专用 TAT Command；脚本在原文件和各 drop-in 全部备份后修改，可捕获退出时回滚并重启原 unit，回滚不完整保留 root-only 备份；SIGKILL/断电不在 trap 保证范围，先按机器文件与受保护账本核对。任何不确定的 TAT 状态禁止重签；失败的临时 Key 撤销。禁止读取/输出凭据值。

## validation
`bash -n` 两个脚本；`bash images/tests/test-hermes-website-credential-scripts.sh`；`git diff --check`；`python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`。生产仅在命令与账本真实终态核对后判断，且不能由局部脚本测试代替机器验收。

## handoff
本地安全实现与测试待 MR；生产目标单机需执行实时身份及 unit 校验，并与其他 17 类异常分开跟踪。
