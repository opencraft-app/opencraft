## goal
提交并推送 mobilefirst 累积改动，与最新 master 集成后合入远端 master。

## non_goals
- 不发布 App、主站、GitOps 或 GitHub 公开镜像；不包含本地生成的 frontend/next-env.d.ts。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户明确授权：“提交，推送，合入master”。设置退出动画已由用户确认看起来解决。

## interface_refs / data_structure_refs
- mobileShellTransition / resolveMobileShellLayout，共享账号 SDK 和 Bot bridge，Chat 连续性/虚拟列表与原生输入，cn/intl 原生 OIDC 回调。

## history_context
- current_design_refs: opencraft/docs/mobile-shell.md、mobile-bot-bridge.md、mobile-data-architecture.md、chat-ui-architecture.md。
- relevant_evolution: source 基于 8043bed71；origin/master 已更新为 5b9f70ea2，累计 519 个上游提交。
- superseded_refs: 当前分支的老 master 基线，不覆盖上游最新逻辑。

## acceptance
- 当前目标相关改动已提交并推送；与最新 master 集成后复验，远端 master 包含目标提交。
- 保留当前 Expo 预览，合并使用独立 worktree；明确未覆盖的实机和外部服务链路。

## affected_paths
- opencraft/；frontend 内置 Bot/共享 SDK 配套代码；user/auth 原生双包回调；相关正式文档及任务记录。

## required_context
- Router opencraft mobilefirst git commit push merge master 无匹配，随后有界检查 diff、构建脚本与交付规则。

## context_receipt
| 文件 | 原因 | 用途 |
|---|---|---|
| 根/OpenCraft/Expo/Frontend/Auth AGENTS | 授权与交付 | 范围隔离、对应验证 |
| gongfeng/SKILL.md、DEPENDENCIES.md | 工蜂 | 尝试复用已配置连接，SSH 仓库权限已验证 |
| MONO2_MIGRATION.md、build-matrix.md | 跨端/生成边界 | 同步机械副本，不发布 |
| scan_secrets.py | 提交安全 | 仅报告路径/规则，日志不打印命中内容 |

## evidence
- SSH ls-remote 验证 master 为 5b9f70ea2；HTTPS 未配置凭证，使用现有 SSH，无新增令牌。
- 源变更/未跟踪文件敏感信息扫描 0 命中；Agent Console 130 文件生成同步完成。
- 设置退出问题已由用户真机确认；其他 iPad 场景沿用待验证记录。

## risks
- 与上游桌面/共享 Chat/账号逻辑有重叠，必须逐文件集成，禁止用单侧整仓覆盖。
- 构建/测试不能替代外部部署或 iPad 实机证据。

## validation
- 原分支 Expo 类型检查、iOS bundle 和聚焦 Shell 8 项测试通过。
- 原分支 Frontend check 通过；Auth 聚焦 Go 测试通过。
- 原分支完整 OpenCraft gate 在扩展 artifactRef 用例失败；Frontend 全量测试有失败并遇到 worker OOM，构建未完成；已停止被新集成取代的验证任务。未宣称这些门禁通过。
- 最新 master 的隔离集成验证运行中，保留桌面侧栏、媒体焦点和消息身份能力。

## decisions
- 用户已明确授权提交推送合入，无需重复确认；预览 worktree 保持现状，使用隔离集成 worktree。
- 首次设置/账号访问后的 UI owner 保活；退出距离和 spring 修复不因合并被退回旧实现。

## scan_scope
- 当前修改路径及与 master 的重叠路径；不扫描或提交无关 worktree。

## scan_output
- 运行日志 /tmp/opencraft-mobilefirst-gate-20261006.log、/tmp/mobilefirst-frontend-{check,test,build}-20261006.log；日志留仓库外。

## handoff
- 集成中；尚未报告 push 或 master 合入完成。
