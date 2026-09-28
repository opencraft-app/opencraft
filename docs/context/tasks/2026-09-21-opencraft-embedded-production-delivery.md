# OpenCraft Embedded Chat 生产交付

## goal
将已合入的 Embedded Chat 补齐同源静态交付，让 lightvela.ai 在显式 show() 后可以加载并接管聊天。

## non_goals
- 不默认打开 rollout，不改变旧 AgentChat 的回退边界。
- 不混入工作区中独立的国际化、主题、桌面和 DSH 需求。
- 不发布国内生产站，不更改生产凭据。

## requirement_refs / requirement_excerpt
- 用户：“只是源码和交付链接线完成…线上暂时仍会显示 AgentChat？…推进一下”。本轮授权提交、推送、合入及推进国际站发布。

## interface_refs / data_structure_refs
- release matrix embeddedWorkbench、NEXT_PUBLIC_OPENCRAFT_EMBED_SCRIPT_URL、OPENCRAFT_EMBED_DIST_DIR。
- OpenCraft 独立 embedded-workbench Vite target，loader、manifest、version.json 和内容寻址资源。
- .ci/frontend.yml 的 artifact build 与 edgeone-release 模式。

## history_context
- current_design_refs：docs/engineering/domains/release-gitops.md。
- relevant_evolution：!4355 已合入，merge SHA b79c792c87ae8f6585a7240a5d7c0f95ae78ecb1；历史线上诊断确认缺少嵌入资源。
- superseded_refs：无。

## acceptance
- 隔离分支审查、相关测试、类型检查与完整产物检查通过。
- 源码 MR 合入，构建产物绑定明确 source SHA，国际站精确发布。
- 线上 loader 和其引用资源返回成功；验证 show() 接管与取消回退。

## affected_paths
- frontend release matrix/artifact staging、.ci frontend workflow、OpenCraft Vite target 和发布文档。

## context_receipt
| 文件 | 原因 | 用途 |
|---|---|---|
| docs/context/domains/release-gitops.md | 路由必读 | 交付证据边界 |
| docs/context/domains/site-environment-routing.md | 路由必读 | 国际站独立发布 |
| docs/context/flows/tapd-gongfeng-delivery.md | 路由必读 | MR 交付 |
| .ci/AGENTS.md | 服务入口 | CI 权限与凭据 |
| frontend/AGENTS.md | 服务入口 | 前端门禁 |
| docs/context/project/adjacency/argocd-ci-secrets.md | 相邻卡 | 核对 workflow contract |
| .ci/runtime/tests/contract_tests/test_release_bundle_contracts.py | 测试邻居 | artifact 补线验证 |
| .agents/skills/gongfeng/SKILL.md | 工蜂技能 | API 鉴权与 MR |
| .agents/skills/devops-pipeline/SKILL.md | 蓝盾技能 | 发布参数与执行 |

## evidence
- 本轮 GET https://lightvela.ai/__opencraft/embedded-workbench.js 返回 404。
- 工蜂鉴权成功；当前 shell 未配置 BK_CI_ACCESS_TOKEN，已异步请求授权从登录浏览器读取。
- 隔离 worktree 基于 origin/master 94aa8099b3411554d4ca0aea1b4c636917f10ac6，仅移入交付补线修改。

## validation
- Release matrix、artifact staging、EdgeOne deploy 聚焦测试 48/48 通过。
- frontend pnpm check 通过：171 项已有类型基线，新增 0；翻译结构及文档同步检查通过。
- OpenCraft Web typecheck、Web release 9 项测试和独立 embedded release 构建通过。
- CI frontend artifact contract 测试通过。
- 新发现并修复：staging 必须先于 fix-next-static-html-lang 的 EdgeOne 投影，回归执行真实投影脚本，检查 resolveDeployDir 返回的 .edgeone/assets 树。
- 全量国际站静态构建完成，341 条版本化资源引用检查通过；实际 .edgeone/assets/__opencraft 中 loader 目标存在、version.json 存在、私有 .vite 未上传。
- frontend 全量测试暴露模型配置测试环境缺失 Python cryptography；切到已有完整 Python runtime 后模型配置 93/93 通过。其余 Workbench/TAT 断言在未修改的 frontend/src 与测试基线中，git diff 已确认源码/测试/锁文件与 origin/master 一致；不宣称全量通过。
- 工蜂 MR !4379 已创建；采纳路径常量化评审建议，保持原有行为。

## decisions
- 发布通道是 EdgeOne Pages artifact，不是 Argo frontend 镜像晋级。
- 构建流水线：p-d7b21a8b85b2495683c8afd1d806f763；国际站发布：p-1538e39f666f4be48ddf7cfea2acb589；项目 git_1731878。
- 只从已归档的明确源码 SHA 发布国际站；不审批父级双站 fan-out。

## handoff
- 正在准备并验证发布变更。
