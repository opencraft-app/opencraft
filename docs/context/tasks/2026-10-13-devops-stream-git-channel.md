## goal
按用户要求更新项目技能，避免把蓝盾通用 API 加 GIT header 当成 Stream 手动触发；通过真实 Git 事件触发包含 MR !5271 DB contract33 修复的 CTL 构建。

## non_goals
- 不取消 #422/#423、不改生产、认证或审批，不修改流水线 on.push 政策。

## requirement_refs
- 用户：“后续都用git渠道，不要用bs渠道”“更新项目skill 防止再犯”“先触发一下构建”。
- 用户进一步纠正：“要用 stream api 才能感知到”“如果不能手动触发，你可能需要通过git 触发”。本 Task 的最终设计以这些纠正为准。

## interface_refs / data_structure_refs
- .agents/skills/devops-pipeline/scripts/pipeline_client.py：git_* 项目的蓝盾通用 start 被阻止；其他项目行为保留，查询默认显式 GIT。
- .ci/ctl.yml：master 的 ctl/** 路径变更触发 Git push；README 不是 paths-ignore。
- ctl/README.md：既有 Trigger note 历史，此次新增对齐 DB contract33 的重建说明。

## history_context
- #422 蓝盾 API 默认 BS；#423 蓝盾 API 指定 GIT，但仍不能以渠道变量或 URL 证明 Stream 事件登记。先前设计将 header 核验等同于 Stream 触发，已纠正。
- 官方 TencentBlueKing/bk-ci ApigwBuildResourceV4Impl.start 仅将渠道传给 process.manualStartupNew；没有提供 Stream event 的创建证据。
- Stream 前端公开 JS 的构建列表经 getPipelineBuildList 消费独立记录；当前浏览器 Preview Bridge 不可读取已登录页面，不抓取 Cookie。
- 仓库 contract 明确只有 CI runtime 监听 CI 文件变更，保留此政策；以既有 ctl README note 路径触发当前构建。

## acceptance
- Stream 项目无法通过本客户端误用蓝盾 build_start，拒绝发生在认证读取与任何网络写入之前。
- 技能明确使用 Stream 正常手动入口或已授权的 Git push；最终以 Stream 记录/实际 Git 事件、源码 material 核验。
- 最小 README note 正常合入 master 并触发 CTL；构建不能替代生产审批或发布验收。

## affected_paths
- .agents/skills/devops-pipeline/SKILL.md
- .agents/skills/devops-pipeline/reference/build-start.md
- .agents/skills/devops-pipeline/scripts/pipeline_client.py
- .agents/skills/devops-pipeline/tests/test_pipeline_client.py
- ctl/README.md

## context_receipt
- 根 AGENTS、ctl/AGENTS、.ci/AGENTS、devops-pipeline Skill 与 start/startinfo/status 引用；skill-creator Skill。
- 已运行路由器并读取 must_read agent-gateway-runtime；此为 Stream/channel 同名误命中，实际不触及业务网关。
- 已读 release-gitops/CI Context 与 argocd-ci-secrets 邻接卡；检查 CTL YAML 与技能客户端测试。

## evidence
- 基线 f79c75f394，隔离 worktree /data/mono2-devops-stream-git-channel-20261013。
- 17 项客户端测试通过，包括 git_* start 无认证/写请求、普通项目行为、真实 Request 的 GIT/auth 请求头和既有停止核验。
- Skill quick_validate、Python 编译与 diff 检查通过。
- 完整 CI runtime 门禁日志 /data/devops-stream-git-skill-check-20261013.log；最终结果交付时记录。

## risks
- 既有 BS/API-GIT 构建不能自动迁移；此 Git 构建可能因并发组排队，队列状态应如实报告。
- Stream 前端的手动/历史/详情端点已定位并写入 reference/stream-trigger.md；现有蓝盾 token 对 Stream 详情 GET 返回401，未调用 Stream 启动 POST。正常 Git 事件是本次采用的已知入口。

## handoff
- 用户已要求通过 Git 触发构建；正常合入技能修复和 CTL README Trigger note，保持生产人工审批。
- 完整 CI runtime 门禁通过（671 tests、4 skipped），17 项技能客户端测试和技能校验通过。
