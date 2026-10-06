# 活跃工作折叠分析 Checkpoint

## stage
按用户“整改吧”授权完成共享模型整改、组件回归及完整 gate。未提交、发布或重启，当前预览仍是旧产物。

## verified
- 原始 running Item 可被 endedByContent 展示段标为 complete，并失去 preventAutoCollapse；纯模型已复现。
- “历史消息”是无 workStatus/耗时的 Renderer 兜底，不是历史来源或执行结束权威。
- 新版 Codex 分离运行状态、最终回答资格、模式、自动默认及显式选择；不能概括为所有活跃 Turn 均强制展开。
- 相关既有测试 23/23 通过，但没有封住复现的并行活跃步骤跨展示边界情况。
- 截图轮次已定位至云桌面会话 10 月 5 日 23:05 的重启请求；持续工作至 23:19 被中断。原始 5 个 AgentMessage 全为 commentary，无 final_answer 或第二个 UserMessage。
- 当前两条活跃会话后端仍是 inProgress。新预览的新浏览器页面恢复云桌面时，截图轮次和当前工作区域均展开；实际加载新 core bundle，不是目录中残留的旧 bundle。
- 用户补充刷新立即折叠，截图 8:16 轮次到 8:33:59 才完成。真实手机宽度页面随后复现：收到 turn/diff/updated 后，Turn 仍 streaming，而工作段变为 complete、boundary=true、collapsed=true、41 previous messages；新进度继续被吞入，变成 42。
- 根因：sourceTurns 把 Turn.diff 作为 turnDiff 假 Item 追加尾部，分段器把非活动的汇总卡当结束边界；关闭段且清掉 workStatus，导致“历史消息”。最新 Codex 的运行中 diff 使用独立固定资源区域，不获得结束边界权。
- 修复：Turn unifiedDiff → Frame/assistant plan changeSummary，资源身份 `${turnId}:turn-diff`；从 ordered Items/slots 排除，不改变工作时钟、最终回答、disclosure 或 Thinking owner。旧 Item 降为同一资源，显式 null 清除优先，resource-only 恢复不造消息。
- Web 与 Native 复用既有资源 renderer，Web Review live lookup 接通元数据；不增加存储、通用资源 registry、执行状态或自动展开补丁。
- 首批 5 个回归在旧实现全失败；现 6 项资源测试及 `npm run test:chat` 合计 487/487 通过。core/runtime/Web/Expo 四端 `tsc --noEmit`、boundaries/typography 均通过。
- `scripts/smoke-turn-resources.ts` 使用真实 Conversation/Review dialog，在 1000px/390px 浅深四组合确认资源更新、连续新工作、DOM 身份、Review 更新、完成折叠/Review、清除和刷新恢复。移动组合含 viewport meta，确认真实 CSS 窄屏。截图目录 `/tmp/opencraft-turn-resources-M2djBu`；mobile-light 已人工检查，无历史折叠，工作/命令/资源正常呈现。
- `scripts/smoke-ordered-presentation.ts` 四组合通过，现有 `tests/workbench-turn-diff-layout.browser.ts` 320/390/768/1200 浅深八组合通过（完整路径 Review、数字不重叠、展开收起均保留）。
- `npm run gate` 最终 exit 0：全 workspace typecheck、各 gate 单测、Web 构建、Expo Web export 和 iOS JS bundle 均通过。iOS bundle 不是原生 IPA 或安装验收；generic Web build 不是 headless 部署包。原有分包体积/动态导入和 Node 警告未作为失败或新修复宣称。
- 文档验证无 errors/broken links；docs-impact 的显式本轮 12 路径集合通过并提示维护者 Owner review。`--staged` 为空集合，因此没有把该空检查当成源变更证据。最终 `git diff --check` 通过；80 端口 PID 534254 未改变。

## unverified
- 截图 23 条记录的瞬时 started/delta 通知时序、保存的 View 折叠选择、用户现有页面加载资源。
- 新版 Codex 实机行为及用户外网 Safari 引擎；本机访问外网 HTTPS 被拒绝连接。核心路径已由真实预览通知和 DOM 复现。
- 当前源码没有部署到 80 端口；新版真实 AppServer 端到端与 Android 原生实机尚未验收。浏览器是独立 fixture/Chromium，Native 为共享模型加类型检查，不冒称手机实机。

## discard
- 不从标题文字推断后端把数据分类为历史。
- 不复制整个 Codex minified 模块或清除全部折叠偏好来掩盖模型错误。
- 浏览器脚本前三次失败来自误把“任意新完成 commentary 之后仍有 shimmer”设为资源验收条件，以及 reasoning 摘要不一定显示在 steps-prose。改为资源到达前后保留既有 live 指示，同时连续新进度断言可见、时钟/open/DOM 身份不变；不为测试改生产 Thinking 语义。

## restore
- 同名 Task Pack 的路径、命令及原始 Codex 模块是分析依据。
- 现有其他听写分析记录属于其他工作，未改动。

## next_action
- 交接源码和本地构建已修复、当前运行预览未升级的边界。用户另行要求替换时才构建 headless 候选包并按独立切换/回退流程重启；不要直接部署 generic Web dist。
