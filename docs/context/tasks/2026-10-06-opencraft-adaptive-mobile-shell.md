## goal
以实际容器几何适配 iPad/手机 Shell，保持唯一 Bot、会话、草稿和导航语义。

## non_goals
- 不更换聊天/DOM 渲染器，不新增业务状态机，不提交、推送或发布。
- 不将模型测试或 iOS bundle 宣称为 iPad 真机验证。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户：窄窗口保持抽屉，宽窗口常驻侧栏并列；个人与设置变为面板，保留返回路径。

## interface_refs / data_structure_refs
- `mobileShellTransition` 保持唯一语义导航；新增 `resolveMobileShellLayout` 仅派生容器呈现。
- `InterruptibleMobileDrawer` 保持同一导航、Bot DOM 和 RN Chat 子树；宽屏选择不收起侧栏。

## history_context
- current_design_refs: `opencraft/docs/mobile-shell.md`、`opencraft/docs/chat-ui-architecture.md`。
- relevant_evolution: 现有导航保留底层抽屉，键盘模型使用屏幕矩形；iOS 主侧栏仍只有抽屉。
- superseded_refs: 按设备窗口断点决定嵌入 Chat 布局的旧方式。

## acceptance
- 同一账号下缩窄/拉宽不改变 Bot、Thread、Draft 或导航目的地；选择功能只关闭窄屏抽屉。
- 原生账号 → 管理账号/订阅 → 返回账号 → 原页面路径一致，面板缩窄为页面时不丢编辑状态。
- 容器几何、导航及键盘模型测试、Expo 类型检查和 iOS bundle；保留预览服务并轻量检查 manifest。
- iPad 横竖屏、分屏、连续缩放、浮动/外接键盘实机验收单独列未验证。

## affected_paths
- `opencraft/apps/workbench-expo/src/runtime/mobile-shell-layout.ts`
- `opencraft/apps/workbench-expo/src/components/interruptible-mobile-drawer.ios.tsx`
- `opencraft/apps/workbench-expo/src/components/native-navigation-surface.ios.tsx`
- `opencraft/apps/workbench-expo/src/app/index.tsx`
- `opencraft/apps/workbench-expo/src/components/workbench-frame.shared.tsx`
- Mobile settings、Bot host、visual tokens、测试和正式设计/AGENTS。

## required_context
- Router query `opencraft Expo adaptive Shell iPad container drawer account panel` 无匹配；在 Expo src 有界定位导航和抽屉实际调用方。

## context_receipt
| 文件 | 原因 | 用途 |
|---|---|---|
| 根、OpenCraft、Expo `AGENTS.md` | 工作约束 | 不重建状态、原生交互和真实证据 |
| `opencraft/docs/mobile-shell.md`、`chat-ui-architecture.md` | 正式设计 | 导航、滚动、键盘 owner |
| `opencraft-maintenance/SKILL.md`、`references/verification.md` | 维护方法 | 容器几何、取消和最小验证 |
| `mobile-shell-model.ts`、相邻测试 | 实现及邻居 | 保留现有返回与迟到消息约束 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md`、`frontend/vitest.config.ts` | 前轮审计邻接 | 不触及 frontend 业务实现 |
| `docs/context/project/services/frontend.md`、同一邻接卡/测试配置 | 退出动画修复 router 命中 frontend-product-surface | 实际变更仍只限 Expo，不复制前端业务 |

## evidence
- 修改前主 Drawer 仅通过宽度限制改变抽屉尺寸；个人页全屏，Chat 断点来自窗口宽度。
- 修改后统一几何 resolver 读取实际容器减去水平 safe area 的宽度：侧栏 320 + 内容至少 480 时可并列；账号面板至少 560 + 两侧各 24，最多 680。这些是集中定义的空间约束，不是设备型号判断。
- Drawer/scene 保持同一 React 位置；账号首次主动访问后保持挂载，避免启动时提前触发邀请资料操作。Web 详情返回原生账号依赖语义 entryKey 重置进入动画，迟到关闭回调通过 revision 拒绝。
- Chat 测量自身宽度和屏幕位置；异步测量通过 revision 和当前 ref 拒绝旧结果。键盘仍由现有单一 owner 处理。
- 用户后续反馈“设置右侧隐藏动画卡顿、逻辑突变”。有界复查发现：旧退出终点为 paneWidth，居中面板在终点仍留下半个外部留白的宽度；手势松手改播固定 210ms timing，未消费 release velocity。修正为宿主右边界退出距离、同一 UI-thread spring 接续进度和速度，退出终点阴影归零，随后才触发导航完成。

## risks
- 重排导致 WebView/Chat 重挂载、草稿丢失；保持 React 树身份及 key 不变，仅改布局。
- 窗口缩放改变键盘相交几何；重测当前容器与屏幕坐标，沿用唯一键盘 owner。

## validation
- `node --test tests/mobile-shell-layout.test.mjs tests/mobile-shell-model.test.mjs tests/mobile-chat-keyboard-geometry.test.mjs`：16/16 通过（几何、导航、键盘纯模型）。
- 最新源代码 `npm run typecheck --workspace @opencraft/workbench-expo`：通过。
- 最新源代码 `npm run bundle:ios --workspace @opencraft/workbench-expo`：通过，4909 modules / 25 assets。
- `git diff --check`：通过；显式变更路径的 change-impact 检查通过。根要求的 staged 检查也通过，但 staged 内容属于本轮之前的工作，未当成本轮源码验证。
- 两个本地预览 systemd 服务 active/running，重启次数均为 0；iOS manifest 和 HTTPS bundle origin 轻量检查通过，未下载外网完整 bundle。
- 未连接 iPad，环境无 xcrun。以下全部未实机验证：横竖屏、分屏、连续缩放时 Bot/会话/草稿及账号编辑/滚动保持、浮动键盘、外接键盘、真实手势与读屏体验。
- 退出动画修复：聚焦 Shell 几何/导航测试 8/8 通过，含 390/650/834/1024/1366 容器的退出终点回归；最新类型检查与 iOS bundle（4909 modules）通过，manifest 及 origin 轻量检查通过，diff 和显式路径/staged change-impact 检查通过。测试不证明帧率或实机不卡顿。

## decisions
- 几何模式独立于导航语义；侧栏宽度加最小内容宽度决定并列能力。
- 本地预览已有 systemd 服务，不再通过短命工具 PTY 维持服务。

## scan_scope
- Expo Shell/Chat/设置及局部测试，不扫描整仓业务。

## scan_output
- 有界 rg 与源码读取。

## handoff
- 实现和本地验证完成，尚未提交/推送。
- 明文预览：exps://kijiji-anybody-common-calibration.trycloudflare.com 。iOS 使用 Safari/标准浏览器打开，Expo Go 中刷新。
- 真机验证路径：选中 Bot 并输入未发送草稿 → 横竖屏/分屏连续缩放 → 宽屏选择功能侧栏不收起 → 打开账号编辑昵称，缩窄/拉宽 → 管理账号或订阅返回账号 → 关闭回到原 Bot/会话 → 分别尝试浮动及外接键盘。观察光标、输入框、滚动锚点、返回手势及 safe area，不以模型结果代替体验验收。
- 退出修复实机复验：设置/开源授权打开 → 左边缘右滑至不同进度后松手（慢拖、快甩、未达阈值回弹）→ 按钮返回；iPad 面板与手机整页分别看尾部是否消失后才交接、松手是否停顿，以及原侧栏是否保留。
