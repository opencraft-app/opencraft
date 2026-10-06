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
- 集成 OpenCraft 全 workspace 类型检查、i18n 与平台边界检查通过；完整 gate 的云桌面 107 项、Electron launch 4 项通过。
- Chat 537/537，Native 171 通过/1 跳过，手机 Shell/键盘等模型 22/22，Frontend 账号/人设/会话 108/108，导航 61/61，模型失败回退聚焦 4/4。
- Frontend check 通过：166 current / 171 baseline / 0 new；生产 build 通过。
- 集成 Auth cmd/lightclaw-auth 与 internal/oidc Go 测试通过；稀疏 checkout 补充 Argo 只读配置后生产 registry 用例也通过，未修改部署。
- OpenCraft Web build、Expo Web export、内置 Bot DOM build/smoke 通过；iOS bundle 最终平台入口复验中。
- 完整 gate 未通过：停在未变更的 extension artifactRef 深比较用例；该测试及其相关 extension owner 与 origin/master 一致。
- Frontend 全量测试仍有失败和 worker OOM，已停止该运行；隔离 master checkout 对照复现 7 项已有失败（实名手机号提示、诊断弹层、头像菜单、国际路由及工作台 loading），另有 2 项 changelog 源码断言也在 baseline 失败。本次新增的内嵌侧栏边界断言已适配并通过，模型 discovery 等 4 个全量失败用例独立复验通过。不宣称全量门禁通过。

## decisions
- 用户已明确授权提交推送合入，无需重复确认；预览 worktree 保持现状，使用隔离集成 worktree。
- 首次设置/账号访问后的 UI owner 保活；退出距离和 spring 修复不因合并被退回旧实现。
- 基础 Expo 路由扫描会带入默认文件，即使存在 Web override；路由委托平台解析组件，隔离 iOS SQLite/DOM 依赖。该修复通过 Expo Web 导出，iOS 渲染正文保持在 mobile-home-route.ios.tsx。

## scan_scope
- 当前修改路径及与 master 的重叠路径；不扫描或提交无关 worktree。

## scan_output
- 运行日志 /tmp/opencraft-mobilefirst-gate-20261006.log、/tmp/mobilefirst-frontend-{check,test,build}-20261006.log；日志留仓库外。

## handoff
- 源分支 6ede0c1d5 与集成分支 5cf62fac9/00f653aa8 已推送；平台入口/测试断言修复待提交、同步、最终合入并读取远端 master 核验。
