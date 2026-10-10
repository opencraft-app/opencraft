# Expo HeroUI Native 设计约束审计

## goal

审计整个 Expo 呈现层，建立能检查的设计约束：以 iOS 交互为基础、保留 OpenCraft 语义与 HeroUI 能力；约束组成和所有权，避免每次修改重新定风格。

## non_goals

- 本轮不重做配色、全局换肤、逐页调圆角，或宣称现有视觉债务已整改。
- 不复制内置 Web 功能，不替换富文本输入事务、原生列表和业务控制器。
- 不安装或购买主题扩展，不变更 Android/Electron 入口，不提交或发布。

## requirement_refs / requirement_excerpt

- 用户：全 Expo 审计 HeroUI Native 用法，并将约束写入 AGENTS.md；提供重命名弹窗与 HeroUI demo 截图。
- 最新明确：需要 iOS 风格但不是 100% 标准；本质是思考如何约束设计，而不是另行设计风格。

## history_context / interface_refs

- 正式设计：opencraft/docs/workbench-design-language.md、mobile-shell.md、design/invariants.md。
- 视觉所有者：design-system tokens.native / typography registry、Expo mobile-visual-tokens.ts、global.css。
- 实际安装 HeroUI Native 1.0.10；按本地 Input/TextField/Dialog/Button/BottomSheet/types/providers 源码核实能力。
- 当前 iOS Agent Console 的聊天和功能内容仍是原 Web DOM；原生控制约束适用于 Shell、账号、侧栏和弹层。独立 RN Workbench 保留另一入口，不能混淆可见范围。

## acceptance

- 全部 src TSX 文件纳入静态扫描；覆盖平台入口、控件适配器与页面消费端，具体发现可追溯源码。
- AGENTS 给出角色选型、样式所有权、覆盖限制、状态/交互验收及例外流程。
- 正式设计同步，明确历史债务与专业输入例外，不凭库导入数量声称原生体验通过。

## context_receipt

| 文件/来源 | 原因与用途 |
|---|---|
| 根/OpenCraft/Expo AGENTS、维护 skill 与 verification | 设计所有权、平台边界和验收约束；沿用本会话已经读取的内容 |
| 路由 frontend-product-surface / frontend service detail | UI 请求命中的 must_read，已读取 |
| frontend runtime adjacency | 检查构建邻居 build-agents-next；当前 Agent 功能与 Chat 是打包 DOM，不列成原生控件缺失 |
| Workbench design language、mobile shell、mobile data architecture | 共用视觉与连续性模型，不创建平行规范 |
| HeroUI Native 已安装源码与官方 Input/TextField 文档 | API、默认 focus/variant、surface 自动选择及弹层背景能力；网络 search 服务返回 404，官方文档用 curl 只读获取 |

## 审计覆盖

静态扫描当前 Expo src 下 52 个 TSX 文件（含 41 个组件 TSX），并检查 runtime 视觉 token、global.css、平台 providers、共享 UI adapter 和现有设计真源。扫描存在性不是缺陷计数；逐项核对高风险消费路径。临时完整文件清单留在本地诊断，不含用户信息，不进入产品界面。

这是源码/组成审计。没有逐个页面进行 iPhone/iPad 真机视觉与键盘验收，不能声称整个 App 的触感已验证。

## 发现与整改边界

| 优先级 | 区域 / 源码 | 发现、原因 | 应约束的所有者与整改方向 |
|---|---|---|---|
| P1 | components/mobile-agent-sessions.shared.tsx | 截图重命名已经使用 HeroUI Input；直接置于 Dialog，没有显式表面 variant 或 TextField 组成。安装版默认 primary 可带 field 阴影，iOS focus outline 使用 accent。其 Dialog 不是 Surface context，不能假定自动变为 secondary。并非未用库，而是组成和默认策略未约束。 | 普通编辑字段明确语义、表面与验证组成；集中平台 focus 策略，保留 Web/外接键盘焦点。先确认实际 variant 和状态，禁止在这个页面独自去 outline/换颜色。 |
| P1 | mobile-account-editors.ios.tsx、native-composer-link-editor.tsx、workbench-conversation.tsx | 8 处普通 TextInput 消费采用各自手绘输入外观；账号编辑有独立颜色、字号和边框。不能从 HeroUI 输入字段继承一致的 invalid/disabled/description。 | 普通字段迁入现有共享表单适配，使用 TextField/Label/Input/FieldError；值、草稿、验证码冷却和提交代次继续归原模型。 |
| P1 | mobile-account-editors / native-composer-link-editor、ui/modal-surface、mobile-agent-sessions | Modal + KeyboardAvoidingView、通用 ModalSurface、HeroUI Dialog 并存。账号/链接编辑固定底部且面板未限定宽容量；重命名没有明确键盘容量 owner，也没显式设置 portal 的原生 modal isolation。源码不足以证明浮动键盘和 VoiceOver 实际结果。 | 先区分短编辑、确认、选择、导航；统一弹层平台适配的 viewport/安全区/键盘/焦点所有者。原持久设置页的导航栈保持。不能每个页面写一套避让或直接把所有 Modal 改成 BottomSheet。 |
| P1 | global.css、mobile-visual-tokens、styles/workbench-styles、账号/登录/侧栏 styles | HeroUI CSS 仅覆盖浅色 accent/focus；移动 token 另有 accent 值，nativeTokens 和 Workbench theme 固定 light；多个页面散落字号、颜色、圆角。库默认和手绘样式并未消费完整同一主题契约。 | 既有 design-system/移动品牌适配是角色真源；CSS、Native styles 是投影。先合并语义所有权，不再发明另一套 palette/registry；不能声称已经具备完整 dark/system 外观。 |
| P2 | mobile-settings-modal.ios.tsx | 语言、站点以带勾 Button 模拟 radio；开发者模式以 Button 模拟 switch。虽有部分 accessibility role，缺少库选择原语整体语义与交互。 | 用 RadioGroup/Switch 的完整契约；保持持久偏好、开发者门禁和失败处理，不由视觉组件接管存储。 |
| P2 | ui/button.tsx + Workbench 消费端；HeroUI Button 页面 | 当前有 HeroUI、共享 Workbench 手绘按钮、页面样式三种呈现路径。既有 adapter 不是自动错误，但未统一 variant/pressed/loading/focus 的映射；很容易继续产生灰块与层叠按压效果。 | 既有 adapter 是迁移点；复用原按钮语义和库反馈能力，明确 quiet/navigation/transaction 的映射。禁止新建第四套包装和同时叠加多套反馈。 |
| P2 | mobile-account-overview.ios.tsx / mobile-agent-navigation.shared.tsx | 侧栏账号已用 Avatar + expo-image，个人页仍用独立头像失败状态/View。相同身份有两套几何和 fallback 实现。 | Avatar 管视觉，已有缓存/upload revision 管数据；迁移不得丢掉 cacheKey、失败兜底与审核状态。 |
| P2 | Bot host、Web host、登录、个人页、独立 RN 内容/按钮 | Spinner 与 ActivityIndicator 混用，账户 skeleton 手绘；也存在小于 shared 44pt 的局部 action 尺寸。并非所有底层 ActivityIndicator 都必须机械替换。 | 对外反馈、行与动作消费统一语义原语；按实际 touch capacity 核对小按钮，不用放大 icon 当作扩大命中区。加载刷新保持最终结构，不替换内容树。 |

### 已合理或需要保留的边界

- 日常/探索已经使用 HeroUI Tabs，并固定分类头；侧栏 ListGroup、Menu、Avatar、Spinner、Separator 是正确的原语方向，仍需验收实际组合。
- NativeRichTextInput 两个适配文件的普通/归因输入分支有专门的原生事务与 selection 所有权；不计入上表 8 个普通表单输入，不应强制替换。
- 设置页面的 NativeNavigationSurface、抽屉和宽屏兄弟面板属于 Shell。HeroUI 没有此版本的完整抽屉容器；不以改成 Dialog 达成“全 HeroUI”。
- 退出登录的系统 Alert 是有意使用系统破坏性确认，不因不是 HeroUI 就列为违规。
- 原 Bot/Chat DOM 内容复用既有 Web 实现；此轮不重写为 RN 表单/Composer。
- 当前库有 Input/Button/Dialog 的 background 端口和支持 expo-blur 的 overlay variant，但库 theme 为 default；glass theme 的扩展 CSS 不在当前配置里。截图 demo 的具体主题未知，不能据截图假定启用了相同材质。

## 落地顺序

1. 先固定正式约束和角色映射；重命名、账号昵称/手机号、链接编辑作为同一类普通编辑入口收敛，不逐页美容。
2. 收敛弹层的容量与键盘契约，再迁移设置选项语义、按钮 adapter 和身份/加载反馈。
3. 逐个角色验收实际状态与输入方式。重构应保持业务/草稿/焦点模型，不能用视觉统一掩盖功能回归。

## 实施与证据

- 本轮新增正式设计的 Expo design constraints 与 Expo AGENTS 约束；没有实施全项目视觉整改或新的主题。
- 检查 installed v1.0.10 类型/实现以及官方页面，定位了默认输入 focus 外观原因；实际系统键盘和 iPad 硬件仍待专项验收。
- 切 Bot 连续性是此前独立修复，仍保留；它的模型、浏览器和构建证据见 2026-10-08-expo-agents-console Task Pack，不将其结果当本审计的视觉验收。
- 交接检查：`git diff --check` 与临时 index 的 `validate_change_impact.py --staged` 通过；没有修改真实暂存区。Context catalog 已生成；全仓 context 检查仍因当前 checkout 缺失服务路径、历史文档/schema 与扫描项报错，未宣称全仓门禁通过。本轮文档约束没有新增 UI 运行行为。

## 参考

- [HeroUI Native Input](https://www.heroui.com/docs/native/components/input)
- [HeroUI Native TextField](https://www.heroui.com/docs/native/components/text-field)
- 已安装 node_modules/heroui-native/src：input.styles、input.tsx、TextField、Dialog/BottomSheet types、providers 和 use-library-theme。安装版源码优先于线上文档中的新能力。
