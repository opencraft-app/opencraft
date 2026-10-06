---
id: desktop-motion-preview-restart
type: task
scope: 将已验收的桌面动效接入当前自托管预览并重启同一服务。
triggers: ["desktop motion preview restart", "桌面动效重启", "桌面动效交付"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth: ["opencraft/.agents/skills/opencraft-self-hosted-preview/SKILL.md", "opencraft/scripts/smoke-desktop-panel-ui.ts"]
status: retired
reviewed_at: 2026-10-05
review_due: 2027-01-03
revision: 1.0.0
precedence: task
derived: false
---

## goal
用户明确授权“重启吧”，接入 desktop-panel-motion 已验收改动并重启当前预览。

## non_goals
不提交推送，不重建旧工作树后端，不改变服务数据、授权或启动参数。

## requirement_ids / requirement_refs / requirement_excerpt
unknown；本轮用户要求重启，沿用已实现动效与停止控制修复。

## interface_refs / data_structure_refs
同一 systemd unit 拥有服务生命周期；独立 supervisor 拥有交换、重启、核验和失败回退；Web 制品独立于不变的后端包。

## history_context
current_design_refs：desktop-panel-motion、desktop-action-web-preview、cloud-desktop-plugin。
relevant_evolution：在线版本为 desktop-action-634fcdab5，主工作树落后；基于当前 634fcdab5 候选加入限定动效。
superseded_refs：不直接覆盖主工作树 generic dist；不把任务提交当作重启完成。

## acceptance / validation
候选 headless metadata、类型/边界/桌面回归、六组真实组件动效浏览器验收、实际包隔离启动验收。切换后核对新 PID、unit/cwd、后端 SHA、Web build、健康接口和页面入口。失败恢复旧 Web 并重启相同服务。

## affected_paths / scan_scope
仅上一轮限定 motion 源码与新设计系统 Web workspace。保留既有 12 项桌面 overlay 与提交的 SSH/侧栏功能。

## required_context / context_receipt
根/OpenCraft AGENTS、self-hosted-preview Skill、maintenance Skill 与 verification 全文；Router query opencraft desktop panel motion self hosted preview replacement restart 无匹配后精确定位当前 unit。build-matrix headless 149–207；Task 模板与 frontend-runtime-openspec-i18n 邻接，frontend/scripts/build-release-artifacts.test.ts 的隔离构建及 embedded metadata 邻居；相邻 workbench-web-release.test.mjs 的旧 hash 资源保留契约；已有 prepare/verify/exchange 脚本与 SOURCE 记录。

## evidence / decisions
当前 unit opencraft-sidebar-quiet-20261005-preview.service，PID 3533066，cwd 现有服务包目录，80端口；后端 SHA 前缀 dc1859312676，完整摘要由 stage/SOURCE.json 的 runtimeSha256 保留与核对。数据 现有私有服务数据目录 不迁移。

## checkpoint
stage：独立 supervisor 完成交换与重启，重连后核验完成。
verified：服务实际所有权与在线旧 build；634fcdab5 候选既有 12 项 overlay；motion 路径在落后主 HEAD 与 634 base 之间无提交差异。限定 25 个源文件形成 SOURCE，lock 只增加 16 行。39 项测试、四个 workspace 类型检查、边界、headless Web 构建与六组真实组件浏览器通过。实际后端包隔离启动，1280/390 两组页面与 SSH 添加入口通过。候选保留 625 项旧 hash 资源，1114 项 Web 文件有 SHA 清单，原子交换双向 inode 探针通过。
verified_after_restart：restart-status.json 为 verified，在线 build 20261005-desktop-motion-634fcdab5；新 PID 3721545 在原 preview unit/cwd 监听80端口。2026-10-06 重连独立查询 systemctl、/proc/cgroup/cwd、ss、runtime SHA、/version.json 和 /__opencraft_health 均符合预期。1280/390 在线浏览器两组无未捕获错误和坏资源，live-browser.json 已记录；用户当前会话已恢复。后端 SHA 不变，数据/启动参数不变，原 Web 仍保留于 stage/web-current。
unverified：用户 iPhone 同屏逐帧视觉对照；不声称100%像素复刻或把夹具验收当真实控制授权验收。
discard：不借用主工作树 dist/lock 覆盖后续 SSH 提交。
restore：旧 Web 将以原子目录交换保留；独立 supervisor 自动失败回退。
next_action：本轮交付完成，用户刷新页面查看；无须再次重启。持久结果 隔离交付记录中的 restart-status.json 与 live-browser.json。未提交/推送源码。

failure_receipt：初次 preflight 误假设 CSS 直接在 index.html 引用；实际 bootstrap 动态导入 Workbench，已改为读取实际 Vite manifest 验证全部 chunk CSS，不取消资源或缓存核验。preflight 拒绝未进行交换或重启。
