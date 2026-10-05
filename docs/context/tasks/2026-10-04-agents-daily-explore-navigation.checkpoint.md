## stage

MR !4969 已合并到 master。2026-10-05 后续 MR !4990 已创建；本轮修复日常子页面切换时会话列表反复清空和加载。Bot 无关的实验室功能范围仍待确认。

## verified

- MR 基线提交 `92cfaf4ba`，原工作区未触碰。
- 当前 `master` 的右下小箭头就是侧栏账号菜单；AI 类型套餐模型已在此，其他套餐模型原在主导航。
- 日常、探索分组与诊断/高级设置的菜单代码已开始改动；新增「日常」翻译已通过 i18n 脚本生成并填充六种目标 locale。
- `pnpm install --frozen-lockfile` 通过。
- `pnpm check` 通过，新增 TypeScript 诊断 0 项；聚焦导航静态测试及侧栏账号菜单测试 59/59 通过。
- 用户确认将英文 `Everyday` 改为 `Daily`；译文与对应断言已同步，复跑 `pnpm check` 通过。
- 后续截图反馈已完成：对话标题带折叠箭头，右侧加号创建会话，列表项保留各自图标及原有操作菜单；聚焦导航测试 44/44、`pnpm check`、国内站构建通过。
- 对话区现在在日常各页面默认展开，箭头和列表由同一折叠状态控制；聚焦导航测试 44/44、`pnpm check`（新增 TypeScript 诊断 0 项）通过。
- 对话区箭头统一使用上下方向：展开时朝上提示收起，收起时朝下提示展开；本轮聚焦导航测试 44/44 通过。
- 本轮发现重命名和删除代码已存在，但国内站未进入聊天页时没有真实会话和操作句柄；已让展开的日常栏预备隐藏工作台，并保留默认会话不可删除及删除确认。触屏设备显示三点入口；聚焦测试 51/51、`pnpm check`（新增 TypeScript 诊断 0 项）、`pnpm build:cn` 通过，5174 预览已恢复 HTTP 200。
- 从其他日常页点具体会话时，首次嵌入回传不会覆盖宿主已选中且有效的会话；聚焦测试 51/51、`pnpm check`、`pnpm build:cn` 复跑通过，文档验证零错误零告警。
- `pnpm build:cn`、`pnpm build:global`、`validate_documentation.py` 通过。
- 本地 `pnpm dev:cn` 正在 5174 端口提供预览；匿名 `/agents/` 是登录页。
- 执行中会话新增逐项转圈指示，OpenCraft 嵌入事件传递 `running`，Hermes 适配器为本地缓存会话恢复执行状态；OpenCraft 测试 89/89、两处 typecheck、边界检查、两处嵌入构建、Frontend 聚焦测试 52/52、`pnpm check` 与 `pnpm build:cn` 通过。
- 5174 国内站与 10001 OpenCraft 脚本均返回 HTTP 200；文档检查零错误零告警，`git diff --check` 通过。临时 Vitest 配置和构建生成的跟踪文件已清理。
- Chrome/Whistle 登录态中的模块加载失败已通过同源静态包预览排除：忽略的 `frontend/public/__opencraft` 指向 OpenCraft 构建输出，5174 环境变量指向 `https://lightvela.com/__opencraft/embedded-workbench.js`。Chrome 现显示 3 条真实会话与历史消息；10001 Vite 已停止，Whistle 规则未改。
- 对话加号提示已改为「新建对话」的现有 Portal Tooltip，移除原生 `title`，六语翻译补齐；Chrome 中聚焦可见，39 项聚焦测试和 `pnpm check` 通过，新增 TypeScript 诊断 0 项。
- 会话列表展示标题现隐藏尾部英文日期时间后缀，原始标题保持不变；重启后的 Chrome 登录态已验证实际条目与会话操作，54 项相关测试、`pnpm check` 和国内站构建通过，新增 TypeScript 诊断 0 项。5174 同源静态预览已恢复。
- 最新文案反馈已将加号提示恢复为「新建对话」，与按钮无障碍名称一致；重新抽取 i18n，移除未使用的文案。
- 新反馈要求执行中删除先停止再确认；已改 Hermes `thread/delete` 路径并增加等待停止确认的聚焦测试，前端确认弹窗显示「停止并删除」。
- Hermes 插件完整测试 88/88（含三项删除生命周期测试）、37 项前端侧栏测试、OpenCraft 插件 typecheck/边界检查、`pnpm check`、国内站构建、OpenCraft 嵌入构建和文档验证通过；5174 页面与同源嵌入脚本均返回 HTTP 200。实际运行中会话未做破坏性删除验证。
- 本轮探索新增「管理」，置于成长与实验室之间，依次包含模型、诊断中心、高级设置；这三个入口已从侧栏底部账号菜单移除，云存储保留。Chrome/Whistle 登录态核对了分组和账号菜单实际条目。
- 本轮导航与账号菜单聚焦测试 60/60、`pnpm check`（新增 TypeScript 诊断 0 项）、国内站及国际站构建、文档检查和 `git diff --check` 通过；5174 页面返回 HTTP 200。完整页面导航测试在 Vitest worker 导入阶段 OOM。
- 国内站 Chrome/Whistle 在 390px 与 320px 视口确认导航排布；320px 的日常会话区默认展开，探索内模型入口可达且无横向溢出。国际站复用同一侧栏组件，国际构建已通过；国际站本地登录态视觉仍未验证。
- 实验室上方的分隔线已在 Chrome/Whistle 登录态的桌面和 390px 移动视口确认；`pnpm check` 新增 TypeScript 诊断 0 项，文档检查零错误、零告警。
- 国内站与国际站构建通过。已将前端 i18n、模型 locale 真源同步到 OpenCraft 生成副本；`check:mono2-agent-console` 与 Hermes 插件 typecheck 通过。
- 本轮 CSS 将桌面长会话列表限制在侧栏可用高度内并显示 6px 纵向滚动条。Chrome/Whistle 登录态用 15 条会话验证：列表从顶部滚到底时中部容器 `scrollTop` 保持 0，「对话」标题和底部账户入口位置不变；末尾会话菜单完整显示。390px 移动抽屉仍整体滚动，无横向溢出。
- 本轮 `pnpm check`、44 项聚焦导航测试、`pnpm build:cn`、`pnpm build:global`、文档检查和 OpenCraft 生成副本只读检查均通过。
- 会话分页 hook 聚焦测试 3/3、嵌入桥接 14/14、工作台 typecheck、前端 `pnpm check` 及双站构建通过；真实账号 15 条会话时未出现不必要的「查看更多」，更多条目的浏览器交互仍缺真实数据。
- 当前 worktree 合并提交 `decb2cd2d` 包含 `origin/master@efc37fe08`；冲突仅在 OpenCraft 生成清单，已由 `sync:mono2-agent-console` 重生成，`check:mono2-agent-console` 通过。
- 合并后的前端 `pnpm check`、63 项侧栏/分页与 23 项嵌入桥接聚焦测试、CN/global 构建通过。OpenCraft Web/Hermes typecheck、88 项 Hermes 与 30 项连接/导航测试、边界检查、嵌入工作台 release 构建通过。文档验证零错误零告警；构建附带的 `next-env.d.ts` 和字体子集改动已恢复。
- 本轮会话列表操作行已居中：单独「查看更多」及并列「查看更多／收起」使用同一 flex 居中规则。`pnpm check`、CN/global 构建、OpenCraft 只读同步检查通过；Chrome/Whistle 已读到更新 CSS。当前真实账号只有 15 条会话，未出现分页按钮，视觉位置由布局规则验证。
- 后续 MR !4990 指向 `master`，从已合并基线仅引入本次居中样式和任务记录；创建时可合并，提交检查随后进入 pending。
- 根据新截图，操作行用不对称水平内边距将单个或并列按钮整体左移约 8px，顶部内边距从 8px 缩至 2px。`pnpm check`、10 项导航/分页聚焦测试、`pnpm build:cn` 和 OpenCraft 生成副本只读检查通过；原 MR 提交检查在本轮推送前为 success。
- 用户继续要求缩小「查看更多」整行高度；按钮行高由 20px 改为 16px，操作行整体约缩短 4px，左右位置和顶部留白保持不变。`pnpm check`、10 项聚焦测试、`pnpm build:cn` 与 OpenCraft 生成副本只读检查通过。
- 用户要求分页操作 hover 时文字加粗；在现有 hover 规则内给可用按钮增加 `font-weight: 600`，禁用态保持原样。`pnpm check`、10 项聚焦测试、`pnpm build:cn` 与 OpenCraft 生成副本只读检查通过。
- 用户要求稍微缩小每行对话之间的间距；桌面会话条目最小高度由 36px 收紧至 32px，垂直内边距由 6px 调至 4px，移动端保持原尺寸。`pnpm check`、10 项聚焦测试、`pnpm build:cn` 与 OpenCraft 生成副本只读检查通过。
- 用户要求桌面会话滚动条仅在鼠标移入「对话」区域时显示。保留 6px 滚动槽，在支持 hover 且为精细指针的设备上让非 hover 状态的滑块透明；触屏设备不套用隐藏规则。`pnpm check`、10 项聚焦测试、`pnpm build:cn` 与 OpenCraft 生成副本只读检查通过。
- Agents 路由切换会重挂页面；新增账号+实例+Profile+站点键的内存列表缓存。聚焦测试验证路由重挂、后台加载保留原列表、Bot/账号隔离和服务端确认为空的清理，侧栏测试 54/54 通过；`pnpm check`、双站构建与 OpenCraft 同步只读检查通过。

## unverified

- 导航重排及会话列表在各种 Bot 状态下的登录态视觉与交互；双站窄屏视觉。
- 国内站真实会话列表已在 Chrome/Whistle 登录态观察；本轮没有对重命名、删除做破坏性真实交互。
- 全量测试未运行；重型页面组件测试在当前本机 Vitest worker 导入阶段 OOM，未完成。
- 未缓存的其他客户端 Hermes 会话缺乏执行状态来源；本地匿名预览无法目视验证真实运行中的会话。
- Chrome 开发覆盖层记录一次 `[hermes-appserver-bridge] request failed {}`，但会话列表与历史仍加载成功；该请求的方法和原因在浏览器日志中未展开，不能据此宣称后端全链路无误。
- DSH 与云桌面页面现有实现依赖 `activeBot.id`；「实验室不区分 Bot」是否要求功能改动待用户明确，暂只做视觉分隔。

## discard

- Vitest 默认 `localhost` 启动配置：本机 DNS 返回 `ENOTFOUND`。
- 首次并行聚焦测试因旧断言输出大量源码后 OOM；后续先更新旧断言并串行运行。
- `validate_context.py --build-catalog` 因历史 Task Pack 大量缺元数据失败；本任务文件未出现在错误列表。

## restore

- 临时 `.vitest-agent-nav-local.config.ts` 使用 `127.0.0.1`，交接前删除。
- Task Pack：`docs/context/tasks/2026-10-04-agents-daily-explore-navigation.md`。
- 顶部导航目标：日常（通道、技能、定时任务、对话/会话）；探索（成长、管理、实验室）；右下菜单（云存储等账户入口）。

## next_action

MR !4990 已更新并恢复 5174 国内站预览；核对远端分支、MR 与 CI 即时状态。真实账号可进一步验证切换通道、技能、定时任务时会话列表不闪空。
