## goal
让 iOS OpenCraft 的内嵌 Bot 页面适应手机容器宽度，并让原生聊天输入沿用共享 Composer 模型补齐桌面已有的输入能力。

## non_goals
- 不改变 Bot、账号或支付后端规则，不发布客户端。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户目标：修复人设页拥挤、文件页整页横滑；补齐原生附件选择与富文本输入，并对齐适用的桌面输入能力。

## interface_refs / data_structure_refs
- `frontend/src/mobile-dom/entry.tsx` 和 `embedded-layout.css`：复用主站 Bot 页面，仅移动端呈现适配。
- `opencraft/packages/composer-core/src/model.ts`、`document.ts`：草稿、附件、富文本与选择项的唯一语义。
- `opencraft/packages/appserver-protocol/src/attachments.ts`：附件 staging 的 Host 能力边界。

## history_context
- current_design_refs: `opencraft/docs/mobile-shell.md`, `opencraft/docs/mobile-bot-bridge.md`, `opencraft/docs/chat-ui-architecture.md`。
- relevant_evolution: 当前工作树已有本地 DOM 容器和原生 Chat；保留其未提交改动。

## acceptance
- 375px 手机容器中人设卡和文件页不把根文档撑宽，交互控件可用；桌面主站布局不回退。
- 原生 Chat 可选择并移除文件/图片，提交使用共享附件结构；富文本输入不丢失现有草稿结构，适用的模型/权限/推理选项与桌面语义一致。
- 运行 DOM build/smoke、frontend check、Expo typecheck 及相关测试，并记录真实呈现证据或尚缺证据。

## acceptance_audit_2026_10_03

| 要求 | 当前权威证据 | 状态 |
|---|---|---|
| 人设和文件在 375px 容器内排版、控件可点、整页不横滑 | 打包 DOM 的 Linux WebKit 320/375/768px 模拟触屏探针覆盖已填人设卡、文件记录及编辑态；人设解读弹层可打开，文件夹入口点击后路径改变；相关共享源、构建与测试通过 | WebKit 模拟环境已验证；iPhone WKWebView 的真实触控和长内容未验证 |
| 共享主站 Bot 逻辑且桌面布局不回退 | `frontend/src/mobile-dom/entry.tsx` 直接挂载主站 `AgentSettingsPage`；移动规则限定在 `lv-mobile-bot-runtime`；去掉该类的 1280px 非触屏浏览器探针仍呈现桌面四列卡片且无页面横溢 | 共享组件桌面探针通过；真实主站完整页面仍未实测 |
| 原生图片/文件选择、移除与发送 | Expo 选择器进入共享 Draft；`NativeAttachmentSession` 管理重试、迟到结果和 Host 引用清理；`resolveNativeAttachment` 使用 Host `client-bytes` 或图片内联；会话测试覆盖成功/失败/切换草稿 | 结构和测试有证据；iPhone 选择器、真实 Host 发送及移除未验证 |
| 富文本与桌面共享语义 | 同一 `ComposerDocument`/`SubmitIntent`，原生属性文本适配和结构化编辑聚焦测试 49/49，Expo typecheck 与 iOS bundle 通过 | 静态及单元验证通过；Fabric 选区、中文输入法和格式原位显示未验证，跨复杂结构编辑仍受保护 |
| 模型、推理、工作区与权限 | 原生控件消费共享 catalog；Hermes bridge 的 `project/list` 和 `permissionProfile/list` 当前返回空目录 | 模型/推理接线已核对；本 Host 没有可执行的工作区/权限选择能力 |
| 可用 iPhone 预览 | Expo CLI `whoami` 为 `beordle`，当前 Quick Tunnel 的 iOS manifest 与 bundle 来源轻量核验通过 | 服务可达；Expo Go 真机进入及操作结果待用户反馈 |

打包 DOM 的 smoke 现按原生侧栏可见的 15 个 Bot 功能正向、反向各切换一次，检查页面根不为空且没有功能渲染边界失败；普通场景与本地 Bot 场景均通过。本地场景使用假认证和返回 401 的 API，因此此检查只证明打包代码在快速切换中未崩溃，不证明业务数据加载、窄屏尺寸或真实 WKWebView 操作。

## affected_paths
- `frontend/src/mobile-dom/`, `frontend/src/pages/marketing/`, `frontend/src/components/domain/`
- `opencraft/apps/workbench-expo/src/components/`, `opencraft/apps/workbench-expo/src/runtime/`
- 相关设计、测试和锁文件。

## required_context
- `frontend-product-surface`: `docs/context/project/services/frontend.md`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/project/services/frontend.md@worktree` | 路由必读 | 前端业务与呈现边界 |
| `frontend/AGENTS.md@worktree` | 最近服务规则 | UI 与验证 |
| `frontend/src/mobile-dom/AGENTS.md@worktree` | 最近目录规则 | 内嵌页面边界 |
| `opencraft/AGENTS.md@worktree` | OpenCraft 规则 | 原生能力和验收 |
| `opencraft/apps/workbench-expo/AGENTS.md@worktree` | Expo 规则 | 原生 Chat 与 Bot 容器 |
| `opencraft/docs/mobile-shell.md@worktree` | 当前设计 | iOS 壳体语义 |
| `opencraft/docs/mobile-bot-bridge.md@worktree` | 当前设计 | DOM 与原生边界 |
| `opencraft/docs/chat-ui-architecture.md@worktree` | 当前设计 | Composer 和附件语义 |

## evidence
- `frontend/src/mobile-dom/embedded-layout.css` 在 WebView 视口不大于 740px 时约束人设工具栏、卡片网格和操作区；`TatFileManagerPanel` 根节点限宽，路径控件可收缩，手机文件表为单列，容量和修改时间位于文件名下方，隐藏水平滚动。内嵌文件操作的悬停提示不渲染；按钮的无障碍名称和标题保留，避免不可见提示撑宽手机内容。
- 手机文件夹行新增独立的「进入」触控按钮；行本身仍可选中以执行重命名或删除，桌面双击行为保留。
- `opencraft/apps/workbench-expo/src/runtime/native-attachment-resolver.ts` 使用 Expo picker 的本地 URI；图片限制 20 MiB，文件限制 32 MiB 且要求 Host 宣告 `client-bytes`；附件生命周期归共享 Draft，移除后清理 Host staged ref。
- `native-composer-document.ts` 保留文本 marks、未编辑的 mention 身份及未改动块；普通段落之间可一次选中并格式化，合并段落时保留两侧 marks。跨不同父结构的普通文本编辑继续拒绝，段落格式操作可转换相邻的简单段落、引用和列表；跨 divider 或复杂嵌套结构的转换拒绝，避免静默压平成纯文本。本地 React Native iOS 的公共 `TextInput` 丢弃 rich Text children，但 Fabric multiline 原生组件接受 attributed children；`native-rich-text-input.ios.tsx` 将文档文本投影送入该组件并管理事件代次、焦点和选区，目标是在输入位置显示格式，待真机核验。其他平台保留受控纯文本输入及只读预览；切换 Draft 时重建输入框。原生 Composer 提供附件、推理档位、权限和新会话工作区选择，弹层文案随应用语言切换。
- 原生回车与多行粘贴现在生成共享 `ComposerDocument` 的段落块；原先在已有多段草稿内粘贴换行只保留第一段的分支已改成完整 splice，并由原生文档测试覆盖格式继承和前后段保留。
- 共享 Composer 的 `insertText` 外部动作不再一律追加到末尾：原生视图按已知选区替换或在光标处插入，并把光标放到插入文本之后；未收到过选区事件时才默认末尾。变更保留相邻 marks，拒绝穿过不可安全编辑的结构块。
- `opencraft/docs/chat-ui-architecture.md` 已记录原生输入与共享 Composer 的边界和剩余限制；快捷建议发送失败改为通用用户提示，iOS 开发者日志只记录固定失败事件，不记录异常正文。
- 端到端检查发现 AppServer 的 `TextElement` 没有富文本 marks 字段，旧编译器会丢掉加粗、斜体和代码标记；共享 `composer-appserver` 编译器现把 marks 降为 Markdown，链接文字内的 marks 也保留，手机和桌面提交规则一致，未标记文字不改写。`chat-appserver-command.test.ts` 覆盖格式、转义和真实 UserInput 编译（17/17）。
- 验证：Expo `typecheck` 通过，iOS `bundle:ios` 4770 modules 成功；Bot DOM `build:mobile-bot-runtime` 与 `smoke:mobile-bot-runtime` 通过；前端 `check` 通过（0 新 TypeScript 诊断），Next.js 生产编译及 105 个静态页成功；`agent-buddy-panel.test.tsx` 36/36 通过；`native-composer-document.test.ts`、`mobile-developer-log.test.ts` 与 `composer-core.test.ts` 29/29 通过；`git diff --check` 通过。
- Chromium 以打包的本地 Bot HTML 和本地预览 Bot 在 320、375、768px 视口打开「人设」和「文件」：各视口 `html.scrollWidth`、`body.scrollWidth` 均等于视口宽度，人设与文件面板边界均在视口内，子元素无横向越界。该探针将非文档资源返回 404，验证的是布局，不是图片、真实文件列表或后端操作。
- 原 Quick Tunnel 已退出并返回 530；已重新启动 Metro 与 Quick Tunnel。Expo Go CF manifest 从 `https://calgary-metropolitan-outputs-concepts.trycloudflare.com` 返回 200，iOS bundle URL 同源。按用户要求未下载完整 bundle；尚无真机截图/触控验证。
- 复核 RN 0.86.3 源码发现直接使用 Fabric multiline 时需提供 `TextAncestorContext`，否则嵌套格式文字会成为附件字符；已在 iOS 富文本适配器补齐。补丁后 Expo typecheck 与 iOS bundle（4770 modules）通过，实际文字输入与中文输入法仍待设备核验。
- 文件夹入口补丁后，Bot DOM `build:mobile-bot-runtime` 与 `smoke:mobile-bot-runtime` 通过；前端 `check` 通过（0 新 TypeScript 诊断）。
- 再次执行 iOS `bundle:ios`（4770 modules）后，`dist/ios/assets/assets/assets/mobile-bot-runtime.html` 与打包源 `assets/mobile-bot-runtime.html` 的 SHA-256 相同；确认本轮文件页改动进入本地 iOS 资源，而非仅在远端网页生效。
- 段落修复后 `native-composer-document.test.ts` 10/10、Expo typecheck 和 iOS bundle（4770 modules）通过；真机交互问题已向使用者请求反馈。
- 选区插入修复后 `native-composer-document.test.ts` 11/11、Expo typecheck、iOS bundle（4770 modules）与 `git diff --check` 通过；Quick Tunnel 的 iOS Expo manifest 仍返回 200。
- 打包 DOM 的本地 Bot smoke 现在通过原生桥命令进入「人设」与「文件」，在超时前等待复用组件真正挂载，并检查无渲染崩溃。此前固定等待 300ms 会把 lazy 组件的「正在加载页面」误判为失败；修正后本地 Bot 场景通过。smoke 的后端请求用 401 假响应，因此这里只证明本地页面路由与组件挂载，不证明真实数据加载或操作成功。
- iOS 相册/文件选择器打开失败现在给出本地化、简短的输入区提示，原始异常不进入用户界面；开发者日志仅记录固定的 `chat.picker.failed` 事件。Expo typecheck 通过。
- 原生键入后在下一次选区事件到达前，依据这次文本编辑更新上一个已知光标位置；重复字符跨不同格式时用原生选区选择实际编辑范围，保留未改动字符的 marks。`native-composer-document.test.ts` 13/13 与 Expo typecheck 通过；设备输入法事件顺序仍待真机核验。
- 触屏人设卡的重抽、删除操作在卡片下方常显，并使用 44px 触控区；桌面指针悬停行为保留，选中态也能操作该卡。文件页创建文件夹与重命名行的输入框可收缩，确认/取消按钮也使用 44px 触控区。前端类型基线为 0 新诊断，人设组件测试 36/36；重新生成本地 Bot DOM 后，普通和本地 Bot smoke 均通过，iOS bundle 为 4770 modules。打包资产 SHA-256 与 DOM 源产物一致；实际点击与排版仍待 iPhone 核验。
- 相册可能缺少 MIME；原生 picker 来源现在在进入 Draft 前依据可信的文件名/URI 扩展名归一化，完全未知的相册图片仍走图片转换，不误进普通文件暂存。`native-attachment-source.test.ts` 3/3 与 Expo typecheck 通过。
- 原生 Composer 文本投影现可定位引用、列表里的单个段落和代码块：只在选区完整落入该叶节点时写回共享文档，回车可拆成同一父节点下的段落；列表标记和结构分隔符不能编辑。嵌套格式也进入只读格式预览，避免用户修改后看不到 marks。`native-composer-document.test.ts` 16/16 与 Expo typecheck 通过；跨结构块编辑和嵌套块的原位富文本渲染仍待完善。
- 共享提交编译器、Hermes 附件暂存及 Workbench 附件解析的聚焦检查合计 33/33 通过；这覆盖了 marks 降为 AppServer 输入、Host 文件引用和清理语义，但未覆盖 iPhone 选择器与真实账号的端到端发送。
- 原生文本模型发现并修正一个可复现的提及复制错误：在 `a\n@aa` 的 `@` 后插入换行时，原子片段只剩首字符也被重建为整个提及，实际草稿变成 `a\n@aa\naa`。现在必须完整保留原子片段才重建；每次写回还核对新文档投影与 TextInput 文本完全一致，否则保留旧草稿。新增覆盖所有选区的换行回归，原生文档测试 17/17 通过。
- 原生 Composer 的模型、思考档位、权限、工作区与附件入口放入可横向滚动的操作区，发送按钮固定在右侧；窄手机宽度不再要求所有入口挤进同一行。Expo typecheck 与 iOS bundle（4771 modules）通过；`git diff --check` 通过。Quick Tunnel 的 iOS manifest 返回 200 `application/expo+json`，按用户要求未下载完整 bundle。真机触控和 IME 仍待核验。
- 本地 Chromium 直接加载重新打包的 Bot HTML，并模拟触屏，在 320、375、768px 的「人格」「文件」页面测量：各页根宽度等于视口宽度；人格与文件面板的 `scrollWidth` 均不大于 `clientWidth`，无 JS 渲染异常。此前文件页在 320px 出现面板内部 302px 对 273px 的隐藏溢出，根因是不可见的文件按钮 tooltip；内嵌模式现在隐藏这些 tooltip，不影响桌面网页。触屏人格卡的重抽和删除曾被 Tailwind utility 层覆盖成 `position:absolute; opacity:0`；内嵌触屏规则现在实测为 `position:static; opacity:1`，按钮位于卡片底部。浏览器探针以假账号和假人设卡执行，未验证真实文件列表或 iPhone WKWebView 点击。
- 修复后 Bot DOM build 与原生桥 smoke 通过；iOS bundle 为 4771 modules，打包资源与 DOM 源产物 SHA-256 一致。前端类型基线为 0 新诊断、5 个既有诊断消除，i18n 提取检查及 `git diff --check` 通过；Quick Tunnel 的 iOS Expo manifest 返回 200 `application/expo+json`，按用户要求未下载完整 bundle。
- 审核 RN 0.86.3 的公开 `TextInput` 源码后发现，iOS 富文本适配器直接使用 Fabric multiline 组件，绕过了公开包装器在受控值与原生缓冲之间的同步。现在适配器记录最近一次原生文本和事件代次；共享 Draft 拒绝跨结构编辑或外部 Composer 修改文本时，用该代次把原生缓冲同步到 Draft 投影，避免屏幕与实际发送内容分叉。RN 的原生命令会暂用默认文字属性，因此回写后刷新属性文字子树以恢复 marks，不重挂输入宿主。Expo typecheck 与 iOS bundle（4771 modules）通过；真实 iPhone 输入事件顺序仍待核验。
- iOS 输入框现在把引用、列表和代码块也交给同一属性文本适配器；它们的文本投影与共享 `ComposerDocument` 完全一致，引用/列表中已有的文字 marks 可在输入位置显示。跨结构边界的编辑仍由原有文档规则拒绝，并通过受控值同步恢复可见内容。原生文档测试 17/17、Expo typecheck 和 iOS bundle（4771 modules）通过；WKWebView 不涉及此原生输入，实际 Fabric 属性文字与中文输入法仍待 iPhone 验收。
- 系统相册/文件选择器现在记录打开时的 Draft 和 Composer 实例；如果用户在系统选择器打开期间切换会话、换控制器或离开页面，迟到的选择结果与错误不会写进另一个草稿。Expo typecheck 通过；系统选择器的实际前后台切换仍待设备核验。
- 提交期间切换会话时，原生 Composer 和快捷建议发送过去会在 A 的请求返回后对当前 B 草稿执行 `clear`，造成输入丢失。共享 Controller 新增按发起 Draft ID 和冻结 `SubmitIntent` 结算发送的操作：A 在后台缓存时仅结算 A；成功时保留选项生成空 A 草稿，拒绝或失败时恢复 A；若发送中仍出现新内容则保留它而不清空。两个 iOS 发送入口已接入该操作；原生输入与附件改动在该 Draft 提交期间禁用，另一 Draft 可独立发送。Composer core 21/21、原生文档 17/17 测试通过；Composer core、Workbench Web、Expo 三处 typecheck 和 iOS bundle（4771 modules）通过。
- iPhone Expo Go 出现 CLI 账号校验提示后，核对本机 `expo whoami` 为 `Not logged in`；当前 Metro、Cloudflare 隧道和 iOS manifest 仍正常，manifest 200 且 bundle 指向同源。Expo 官方说明真机 Expo Go 与 CLI 必须同账号登录，Quick Tunnel 不能绕过；预览 Skill 和 Expo README 已补该前提及 Try Again 步骤。一次浏览器回调兑换失败，未取得 Expo CLI 登录态；等待用户在交互终端自行登录，不接收密码或回调码。
- 原生文件选择器可把音频文件按 `client-bytes` 暂存到 Hermes Host，但原编译器会仅凭 MIME 生成 `localAudio`，Hermes 的 text/image 输入适配器无法接受。共享 AppServer 编译器现在将已 Host 暂存的非图片文件统一编译为文件引用；未暂存的音频输入语义保持原样。AppServer 命令测试 18/18、Composer AppServer、Workbench Web 与 Expo 类型检查通过。
- 扩大本地打包 DOM 的窄屏探针到 12 个 Bot 栏目后，发现「成就」在 320px、诊断在 320/375px 的单列网格使用隐式 `auto` 轨道，卡片内容的最小宽度会超过父容器。主站复用组件现明确使用可收缩的单列轨道，卡片设置 `min-w-0`；精选技能卡也指定可收缩轨道，避免 320px 下首卡内部 288px 的内容被裁切。重新打包后，320/375px 下成就、诊断、技能的根页面和内容列均未横向溢出；技能批次轮播的离屏内容、文本控件自身的截断属于预期。Bot DOM smoke、Expo typecheck 和 iOS bundle（4771 modules）通过，前端 TypeScript 基线为 0 新诊断、5 个既有诊断消除；Quick Tunnel 的 iOS manifest 及 bundle 来源通过轻量核验，未下载完整 bundle。探针使用假账号及 401 模拟响应，未验证真实服务数据或 iPhone WKWebView。
- 用户提供 Expo 浏览器登录回调时，旧的 CLI 回调端口已不再监听，无法完成该次登录；新的 `expo login --browser` 正在本机监听，并已打开新的登录页。CLI 仍显示 `Not logged in`，需在正在监听的新流程中完成浏览器确认，再复核 `expo whoami`；不把回调码记录在仓库。
- 原生富文本格式按钮过去在选区跨过引用块或列表项内换行时一律拒绝。现在按共享文档的文字叶子收集选区并原位更新 marks：可一次格式化普通段落与引用段落，或同一列表项的多个段落；列表标记、分隔符、代码块及原子内联仍受保护，遇到不可格式化内容不会局部提交。原生文档测试新增跨引用与列表选区场景，19/19 通过；Expo typecheck、iOS bundle（4771 modules）和 `git diff --check` 通过。真实 iOS Fabric 选区事件仍需设备核验。
- 使用带真实形状文件记录的本地 TSSH/WebSocket 假响应，直接在打包 DOM 中打开「文件」：320、375、768px 下已加载文件列表、重命名编辑态与新建文件夹态均未撑宽页面或面板。320px 下路径输入原先要求 12rem 基宽，刷新按钮换行；共享文件组件将该基宽移到 `sm` 断点，窄屏四个路径控件保持一行，桌面布局不变。此探针验证 DOM 排版和触控目标，不证明真实 Host 文件操作。
- 使用带三张已抽取人设卡的本地 Vibebase 假响应，发现 320px 人设网格 `scrollWidth` 比 `clientWidth` 多 4px，根因是触屏上不可用的空卡悬停提示仍参与宽度计算。内嵌触屏样式现在隐藏卡片悬停提示；空卡仍有无障碍名称，卡片下方重抽/删除按钮为 44px 触控区。重新打包后的触屏探针在 320、375、768px 均测得网格、卡片和外层面板无横向溢出，浏览器无 JS 错误。真实 iPhone WKWebView 呈现仍待核验。
- Expo CLI 浏览器登录的旧回调端口已关闭，旧验证码不能用于当前监听；本机 `expo whoami` 仍为 `Not logged in`。已用 `BROWSER=none` 启动新监听并向使用者提供新的 Expo 登录入口，等待浏览器确认或对应的新回调。
- 本轮 `build-mobile-bot-runtime`、原生桥 smoke、Expo typecheck、iOS `export:embed`（4771 modules）、前端 TypeScript 基线（0 新诊断，5 既有诊断消除）、`git diff --check` 和 staged 文档影响检查通过；iOS 输出中的内嵌 Bot HTML 与源产物 SHA-256 一致。Quick Tunnel 的 iOS manifest 及 bundle 同源通过轻量核验，按用户要求没有下载整个 JS bundle。
- 原生 Composer 的结构化文本编辑补齐同一引用块或同一列表项内跨段落删除换行：保留 quote/list 容器、列表项身份及前后 marks；不同父结构的分隔符与列表标记仍拒绝编辑，避免压平 Draft。新增普通引用、无序列表和两位数有序列表场景，原生文档测试 21/21、Expo typecheck 通过。真实 iOS 选区与输入法事件仍待设备核验。
- 附件链路审计发现 Hermes Host 的文件暂存仍依赖全局 `crypto.subtle.digest`，而 Expo 原生 polyfill 只注入随机数 API。现通过 Host transport 将 Expo Crypto 的 SHA-256 提供给附件暂存服务；浏览器保持 Web Crypto 默认实现。新增平台 digest 注入测试，Hermes 附件测试 3/3、插件及 Expo typecheck 通过；真机文件选择及真实 Host 发送仍待核验。
- 原生 Composer 的附件处理现由 Controller 生命周期持有，与桌面附件会话模型一致：输入组件重挂载或切换 Draft 不取消正在处理的本地文件；失败卡片可从同一选中文件重试；移除会取消任务并清理迟到的 Host 结果。新增附件会话测试覆盖失败重试、迟到释放和切换目标后回填原 Draft。重复字符光标定位由反复比较整段尾部改为一次后缀扫描，长草稿测试验证格式所属段未漂移。本轮聚焦测试 28/28、Expo typecheck 和 iOS bundle（4772 modules）通过；真机附件与 Fabric 输入仍待核验。
- 桌面/原生能力对照发现工作区与权限控件确实消费同一 AppServer catalog，但当前 Hermes bridge 对 `project/list`、`permissionProfile/list` 返回空目录；LightVela iOS 因此不会显示这两项。保留该真实 Host 能力边界，不伪造项目或权限选项。原生通用 Composer 的接线不等于此 Bot Host 已提供可选项；Host 能力扩展需单独实现和验收。
- 用户完成与当前监听匹配的 Expo CLI 浏览器回调后，`expo whoami` 返回 `beordle`。Quick Tunnel 的 iOS manifest 与 bundle 来源轻量核验通过，未下载完整 bundle；仍待 iPhone Expo Go 实际打开并验证交互。授权码未写入仓库或开发者日志。
- 原生附件会话的移除路径现能用统一的 Host 清理回调释放已恢复草稿的附件引用，即使该附件没有当前选择器会话记录；失败提示也与新增的重试按钮一致。会话聚焦测试 4/4、Expo typecheck 和 `git diff --check` 通过。
- 原生 Composer 新增段落格式入口，能在共享 `ComposerDocument` 中切换普通文本、引用、项目列表和编号列表；简单列表项回车生成下一项，空项回车退出列表，保留行内 marks 与列表项 ID，选区随自动生成的列表标记移动。复杂嵌套块继续拒绝会导致结构丢失的转换。原生文档与附件聚焦测试 31/31、Expo typecheck、iOS bundle（4773 modules）通过；Quick Tunnel iOS manifest 与 bundle 来源轻量核验通过，未下载完整 bundle。Fabric 实机输入事件与视觉仍待 iPhone 核验。
- 列表回车的结构改写和普通输入、受保护标记拒绝现在由纯 `native-composer-text-transaction` 决定；View 只发布结果并按当前 Draft 代次回写光标。iOS Fabric 输入桥先记录 native event count/text，再触发父级草稿更新，防止同步受控回写拿旧代次。原生文档、事务和附件聚焦测试 34/34、Expo typecheck、iOS bundle（4774 modules）、`git diff --check` 通过；Quick Tunnel iOS manifest 与 bundle 来源轻量核验通过，未下载完整 bundle。设备上 Fabric 事件顺序仍待核验。
- 段落格式现在可跨相邻顶层段落、简单引用和列表转换，保留行内 marks、已有列表项 ID 及前后未选块；生成列表标记后将原选区映射到新文本，选区恰好结束于下一段开头时不会把下一段也转换。跨 divider 或复杂嵌套块时不修改文档。聚焦测试 38/38、Expo typecheck、iOS bundle（4774 modules）和 `git diff --check` 通过；真机选区映射仍待核验。
- 对照桌面 ProseMirror 的代码块能力，手机段落格式菜单现可创建代码块，也能把已有代码块转换为段落、引用或列表；已有代码块再次选择时保留语言属性。普通段落转换为代码块时只接受无 marks、无原子内联的纯文本，避免丢弃格式和提及身份。转换保留文本与选区，代码块内回车继续留在代码块；原生文档、事务及附件聚焦测试 42/42、Expo typecheck、iOS bundle（4774 modules）、`git diff --check` 通过。Quick Tunnel iOS manifest 与 bundle 来源轻量核验通过，未下载完整 bundle；真机输入与选区行为仍待验收。
- 附件流程与桌面版对照确认：iOS 已用共享 Draft、Host `client-bytes` 暂存、失败重试与移除清理；Hermes Host 的工作区和权限目录仍为空，手机不显示不可执行的伪选项。原生图片附件卡现在预览本地选择器 URI，不为展示再次解码大体积 base64；预览按 Draft 和附件 ID 定位，切换 Draft、移除附件后不会出现在当前输入区。原生文档、事务及附件聚焦测试 43/43、Expo typecheck、iOS bundle（4774 modules）及 `git diff --check` 通过；Quick Tunnel 清单与 bundle 来源轻量核验通过，未下载完整 bundle。真实 iOS 图片显示与发送仍待验收。
- 人设已填卡的「人设解读」原先嵌在整卡选择按钮内，触屏命中语义相互干扰；现在它是卡片下方的独立按钮，粗指针下至少 44px 高。组件回归测试确认预览按钮不是选择按钮的后代，点击预览不改变选中态。`agent-buddy-panel.test.tsx` 36/36、前端 TypeScript 基线 0 新诊断、普通与本地 Bot DOM smoke、Expo typecheck、iOS bundle（4774 modules）及 `git diff --check` 通过；真实 iPhone 点击仍待验收。
- 原生输入编辑带链接的富文本时，原实现把整个链接视作原子片段，修改一个字会丢失目标地址和子文本 marks。现在字符投影保留链接来源，重建时按来源恢复链接及各段 marks；链接内选区格式化也保持 href。链接外编辑不会吞并目标，整条链接替换为普通文字时不保留旧目标。聚焦测试覆盖链接各字符位置和引用块中的编辑；原生文档、文本事务、块格式及附件测试 44/44、Expo typecheck、iOS bundle（4774 modules）、`git diff --check` 与 Quick Tunnel 轻量核验通过；真实 iOS 输入法仍待验收。
- 原生富文本选区现在有「链接」入口；键盘避让的原生编辑层提供保存、移除和取消，打开时绑定 Draft ID 与选区，避免切换会话后误写。链接变更保持原有 strong/emphasis/code marks、周围段落及 quote/list 容器；只接受 HTTP(S) 网页地址，生成的目标可由共享 AppServer 编译器安全序列化为 Markdown。链接文字在 iOS 属性文本中显示下划线与强调色。文档模型与地址校验测试已覆盖；原生文档、文本事务、块格式及附件测试 46/46、Expo typecheck、iOS bundle（4775 modules）、`git diff --check` 与 Quick Tunnel 轻量核验通过。真实设备的选区和键盘交互仍待验收。
- Android 的独立根布局此前未加载 HeroUI Native 样式或 Provider，但它消费的共享 Chat 工具栏已使用 HeroUI Native 按钮。根布局现与 iOS 一样加载样式并包裹 Provider；Expo typecheck 与 Android bundle（4873 modules）通过。此项确保共享输入控件有完整的主题上下文，Android 真机呈现仍待验证；iOS Quick Tunnel 清单和 bundle 来源轻量核验通过。
- 人设页在已应用自定义人设时，状态文字和编辑/下载按钮原先挤在同一行，长名称可能被面板裁掉。该状态现允许换行、长名称在可用宽度内断行，触屏按钮至少 44px；触屏环境不渲染悬浮提示。`agent-buddy-panel.test.tsx` 36/36、前端类型基线 0 新诊断、Bot DOM 构建与普通/本地 Bot smoke、iOS bundle（4775 modules）、`git diff --check` 和 Quick Tunnel 轻量核验通过；长名称在 iPhone WKWebView 的实际视觉仍待核对。
- 文件页在手机上不再为容量值预留固定 56px 表格列：文件名独占一行，容量和修改时间作为行内次级信息；桌面仍为名称、大小、修改时间三列。文件夹「进入」触控区增加至 44px。文件管理组件测试 32/32、前端类型基线 0 新诊断、Bot DOM 构建和普通/本地 Bot smoke、iOS bundle（4775 modules）及 Quick Tunnel 轻量核验通过；真实长文件名、文件夹进入和横向手势仍需 iPhone 验证。
- 原生附件会话现在区分草稿被丢弃和发送成功：前者释放已暂存的 Host 文件，后者保留文件供会话记录引用；正在处理的任务被丢弃时继续中止并清理迟到结果。切换会话后后台完成的暂存由附件会话保存引用；共享 Composer 也会在缓存草稿的发送结果结算时通知订阅者，并提供按 Draft ID 查询阶段，确保失败后重置缓存草稿能清理 Host 文件。两个遗漏清理回归均先红后绿，另覆盖缓存草稿发送成功时保留文件；Composer 与附件会话测试 31/31、Composer/Workbench Web/Expo typecheck、iOS bundle（4775 modules）与 `git diff --check` 通过。真实 Host 文件发送与清理仍待设备验收。
- Bot「总览」服务卡在 320px 容器内扣除两侧 20px 内边距只剩约 280px；旧三张统计卡至少需要 `3×104+2×12=336px`，会被外框裁切。复用的主站 `HeroBanner` 现在按容器断点在手机排两列，恰有三项时第三项占整行；宽屏三列以及四项时的宽屏换行保持。总览相关测试 54/54、前端类型基线 0 新诊断、Bot DOM 构建与 smoke、iOS bundle（4775 modules）和 `git diff --check` 通过。实际 iPhone 排版仍待核验。
- 原生列表首项开头按退格，现在将该项变成普通段落并保留行内 marks；后续项仍在列表中，有序列表从下一序号继续。此步原生文档、块格式与文本事务聚焦测试 43/43、Expo typecheck、iOS bundle（4775 modules）、`git diff --check` 和 Quick Tunnel 轻量核验通过；真机 Fabric 退格及光标位置仍待验证。Expo CLI `whoami` 为 `beordle`；本轮 localhost 回调端口已关闭，手机应在 Expo Go 点 Try Again 使用现有登录。
- 后续简单列表项开头退格也可与前项合并，保留两段文字各自的 marks、前项 ID 和后续项 ID；编号列表按剩余项重新连续编号。复杂多段落项仍拒绝标记编辑，防止结构丢失。原生文档、块格式与文本事务聚焦测试 44/44、Expo typecheck、iOS bundle（4775 modules）、`git diff --check` 和 Quick Tunnel 轻量核验通过；真机 Fabric 退格、光标及输入法仍待验证。
- 2026-10-03 再次直接以 Chromium 打开当前打包 HTML：320/375/768px 模拟触屏上，人设卡、带长文件名的文件列表、重命名编辑态与新建文件夹态的根文档、外层面板和文件行均未横向溢出，渲染异常为 0；人设卡操作按钮高 44px，触屏悬停提示隐藏。探针用本地假 Bot、假人设卡和假文件响应；不证明 iPhone WKWebView 或真实 Host API。Expo CLI `whoami` 仍为 `beordle`，当前外部地址的 iOS manifest 与 bundle 来源轻量检查通过，无须再兑换已关闭监听端口的浏览器回调。
- 当前打包 HTML 的 15 个可见 Bot DOM 功能页在 320/375px 模拟触屏下正向逐一切换：根文档与内容列均未横向溢出，浏览器未报渲染异常。轮播离屏卡、横向筛选条及输入内部文字有局部 `scrollWidth`，外层均保持在视口内；假 API 不证明业务数据和 iPhone WKWebView。
- 原生引用块末尾已是空段落时，第二次回车现在把该空段落移到引用外；引用内容与 marks 保留，纯文本投影不额外增加换行，输入缓冲按共享草稿校正。独立空引用也能退出。原生文档、块动作、文本事务与附件聚焦测试 56/56、Expo typecheck、iOS bundle（4775 modules）通过；实际 Fabric 回车与光标仍待设备核验。
- 发现切换 Bot 导致 Controller 在附件发送途中销毁时，旧附件会话会立刻删除已暂存的 Host 文件，可能与未完成的发送竞争。附件会话现在把 `submitting` 草稿的 ready 文件所有权留给异步发送：接受后保留供会话使用，失败或拒绝后才清理；普通未发送草稿仍在销毁时清理。原生发送与快捷建议发送都回报结算。聚焦附件测试 12/12、Expo typecheck 通过；真实 Host 文件发送和清理仍待 iPhone 验收。
- 窄屏截图复核发现已填人设卡虽无横向溢出，但 320px 容器内两列卡片只有约 126px 宽，标题和摘要难读。打包 DOM 现仅在卡片容器宽度不大于 360px 时把已填卡跨两列居中并限宽 240px，空卡仍保持两列；768px 容器沿用三列。Chromium 模拟触屏 320/375/768px 测得已填卡宽 240/240/218px，根和面板无横向溢出，44px 操作按钮与渲染均正常；Bot DOM build/smoke、前端类型基线 0 新诊断、iOS bundle（4775 modules）与打包资产 SHA-256 一致。真实 iPhone 视觉与点击仍待验收。
- 对照仓库锁定的 RN 0.86.3 `TextInput` 源码发现：公共包装器在卸载时会清除正在聚焦的原生输入，而当前 iOS 属性文本适配器只注销了输入引用。适配器现用 layout-effect 卸载清理焦点与键盘，避免切换 Draft 或 Bot 后留下旧输入宿主；Expo typecheck、iOS bundle（4775 modules）和 `git diff --check` 通过。实际 iPhone 键盘切换仍待验收。
- 附件链路核对发现 iOS 与 Hermes 都允许 20 MiB 内联图片，但 Hermes 用 Base64 字符数估算时没有扣除结尾 `=`，恰好 20 MiB 的图片被多算 1 字节拒绝。桥现按填充精确计算原始字节数；真实 20 MiB Base64 输入的 Gateway 发送边界回归先复现失败、修复后通过。Hermes 插件 typecheck 通过；尚未验证真机图片发送和更大文件的内存峰值。
- 普通文件暂存过去用一次 `atob` 解码整份 Base64、保留完整二进制字符串，再复制到 `Uint8Array` 并完整重编码验证；摘要入口还复制一次整个数组。32 MiB 文件会形成多份临时大对象。Hermes 桥现在以 1 MiB Base64 对齐块解码到最终数组，只复核末尾 quartet 的规范填充位，平台摘要直接消费该数组（提供者不得修改）；保留原有 32 MiB 上限、精确大小和重放摘要校验。跨块文件与非规范填充回归 4/4、插件 typecheck 通过；这减少 JS 临时副本，仍需 iPhone 上测量实际内存峰值和真实 Host 上传。
- 原生普通文件的 Host 暂存请求发出后，不再随本地附件取消而提前放弃 RPC 回复；删除附件仍立即退出本地草稿，迟到的 Host 文件引用由附件会话释放，避免服务端已写完而客户端失去清理依据。附件会话 12/12（含迟到结果清理）、Expo typecheck、iOS bundle（4775 modules）、文档校验与 `git diff --check` 通过；真实网络中断后的 Host 状态仍需设备验证。
- 原生 Composer 的共享撤销/重做接口过去是空操作；现在记录每次输入、格式修改、链接修改和外部文本插入前后的 `ComposerDocument` 与光标，按 Draft ID 隔离并限制历史容量。原生输入区在有历史时显示撤销/重做按钮；外部动作替换文档后拒绝回放旧分支，附件不进入文本历史。历史、文档与事务聚焦测试 36/36、Expo typecheck、iOS bundle（4776 modules）、文档校验与 diff check 通过；真机键盘与光标回放待核验。
- 原生输入框的文字、焦点和选区事件现在验证事件来源的 Draft ID；旧输入框在切换会话后迟到的事件不会写入新草稿，选区也约束到当前草稿的 UTF-16 文本范围。新增嵌套块投影回归覆盖 Emoji、链接、引用中的编号列表和代码块，确认可视文本与共享草稿的选区字符串一致。文档/历史/事务测试 37/37、Expo typecheck、iOS bundle（4776 modules）与 diff check 通过；真实 Fabric 事件先后顺序仍待真机核验。
- 补测 500、600、601、639、640px 发现人设网格原本在 601px 从两列切三列，单卡从 266px 掉到 162px；内嵌 Bot 的两列断点现延续到 740px，741px 切三列时单卡约 209px。600、601、680、740、741、768px 带模拟人格记录的触屏容器无根/面板横溢，操作按钮高 44px。文件夹「进入」原被 `sm:hidden` 在 640px 起隐藏，触屏平板只剩双击；现内嵌触屏容器始终显示 44px 入口。640、768、1024px 带模拟文件的触屏点击均进入目标路径，页面/面板/文件行无横溢；桌面双击规则保留。iPhone WKWebView 真机仍未验证。本轮组件测试 68/68、前端类型基线 0 新诊断、Bot DOM build/smoke、iOS bundle（4776 modules）与打包资产 SHA-256 一致。
- 原生富文本在引用块开头退格时，现将首段接到前一个普通段落，保留两边行内格式和引用块剩余段落；若引用只有一段，则移除空的引用包装。生成的文本已与键盘删除一致，不再额外重写原生缓冲。结构化编辑聚焦测试与 Expo typecheck 通过；iPhone Fabric 退格事件仍需真机核验。
- 打包 DOM 的 320px 触屏截图发现人设空卡在公共 CDN 图片失败时露出浏览器破图符号。共享卡背现在有本地渐变底色与矢量拼图兜底，远程纹理成功时仍按原样覆盖；假网络返回 401 的浏览器实测破图已消失。320/375/768px 触屏探针根宽与内容宽一致、卡片操作高 44px；Bot DOM smoke、前端类型基线 0 新诊断、相关组件测试 36/36 通过。公共人设图片的真实 CDN 可用性和 iPhone WKWebView 呈现仍待核验。
- 原生附件菜单现在以当前 Host 的 `client-bytes` 声明决定是否显示「文件」入口；没有暂存能力的 Host 只显示「照片」，避免用户选择文件后才必然失败。Hermes Host 声明了该能力，现有 Bot 文件路径仍保留。Expo typecheck 通过；需在真机上核验选择器打开、暂存与发送。
- 共享卡背的桌面探针用打包 DOM 移除 `lv-mobile-bot-runtime` 类，在 1280px 非触屏视口看到原有四列卡片和悬停操作布局；页面宽度未超过视口，破图兜底仍可见。此探针不等于真实主站路由，因此完整桌面视觉仍未声称验收。
- 原生附件选择改为每个 Composer Controller 顺序处理：多个文件仍同时出现在各自 Draft 中，第二项等待第一项的读取、编码及 Host 暂存结算后才开始，避免 20–32 MiB 附件并行形成多份 Base64 内存峰值；移除排队项会取消其工作，移除正在处理的项会清理迟到的 Host 引用。附件会话回归 15/15、Expo typecheck、iOS bundle（4776 modules）、文档校验和 `git diff --check` 通过。真实 iPhone 的峰值内存与多文件发送仍待验证。当前 Hermes Host 的项目/权限目录均返回空列表，移动端按共享能力目录隐藏对应选择项，不造假选项。
- 原生富文本链接操作与加粗等格式操作共用可编辑文字选区映射：跨普通段落和引用的选区现在可添加、查询并移除同一 Web 链接，保留各段 marks 和引用包装；跨列表生成标记、代码块、分隔线或原子内联时仍拒绝，以免破坏结构。文档模型与共享提交编译 45/45、Expo typecheck、iOS bundle（4776 modules）、文档校验和 `git diff --check` 通过；实际 iPhone 选区及链接弹层待核验。
- 附件移除路径现在只把 `ready` 的 Host 引用交给清理回调；尚在 `pending` 的文件立即从 Draft 移除并取消本地任务，若 Host 随后返回引用仍由附件会话单次清理。此前会先把空 URI 的 pending 对象交给清理边界。会话回归 15/15、Expo typecheck 与 diff check 通过；真实 Host 的迟到回复仍需设备网络条件验证。
- 内嵌人设已填卡的窄屏单列规则增加 `@supports not (container-type: inline-size)` 下的媒体查询回退：旧 WebView 不支持容器查询时，至 440px 视口仍给已填卡 240px 可读宽度；支持容器查询的浏览器沿用原有按面板宽度计算的规则。Bot DOM 构建及 smoke、前端类型基线 0 新诊断、iOS bundle（4776 modules）与 diff check 通过。尝试以 Linux Playwright WebKit 探测真实内核，但当前 TencentOS 缺少其 GTK/GStreamer 运行库，未取得 WebKit 渲染证据；仍需 iPhone WKWebView 视觉与触控验证。
- 原生 HEIC 等图片转换 JPEG 后，转换产物只用于读取 Base64；读取结束、尺寸失败或取消时删除该临时文件，原始选择器 URI 仍供 Draft 预览。避免反复选图把转换缓存留在设备上；若清理失败不遮蔽附件本身的结果。用隔离的 Expo 原生模块假实现运行真实解析器，成功、取消/超限和同 URI 保护回归 3/3；Expo typecheck 与 iOS bundle 通过。真实 iPhone 相册转换和文件清理仍待验证。
- Linux 主机缺少 Playwright WebKit 依赖后，改用隔离的 Playwright 1.58.2 官方容器运行当前打包的 Bot HTML。模拟触屏 320/375/600/740/768px 人设页中，根文档和内容宽均等于视口，三张已填人设卡在 320/375px 为 240px 宽，操作按钮高 44px；320px 截图确认卡片文字和操作区可见。320/375px 点击「人设解读」后预览弹层打开，根宽仍等于视口。文件页 320/375/640/768px 带长文件名、重命名和新建文件夹状态时，根、面板和文件行均未横向溢出；320/375px 点击 44px 的「进入」按钮，路径改变为目标文件夹。探针使用假 Bot、假认证和假文件响应，API 的 401/CORS 错误是模拟响应；这证明 Linux WebKit 布局与 DOM 点击，不证明 iPhone WKWebView 手势、真实业务数据或原生输入。
- 原生附件到共享发送编译新增贯通回归：用 Expo 文件对象假实现读取选择器文件，把 Base64 交给 Host 暂存，得到的 `AttachmentRef` 进入共享 `SubmitIntent` 后编译为 Agent 可读的 Host 文件 mention；含空格和括号的 Host 路径仍能还原。`native-attachment-resolver.test.ts` 4/4、`git diff --check` 通过。此检查覆盖客户端契约，不替代真机选择器与真实 Host 发送。
- 扩展 Linux WebKit 探针到侧栏全部 15 个可见 Bot 功能后，发现「总览」的最新动态配图在 320/375px 容器内触发 CSS Grid 自动最小宽度，图片列达到约 508px；外层裁切使右侧文案不可见，根文档未横溢，因此只测根宽会漏报。共享 `LatestNewsSection` 的网格和图片列现明确允许收缩并让图片列匹配父宽。重新打包后 WebKit 在 320/375/768px 的总览内容区无内部溢出，1280px 非移动样式也无溢出；320px 和 1280px 截图确认图片及文案排列。探针使用假 API，图片资源返回 401，未验证线上图片加载或 iPhone WKWebView。Bot DOM smoke、Expo typecheck 和 iOS bundle（4776 modules）通过。
- 登录后首页曾再次异步读取凭证和缓存作用域，期间整屏显示「正在打开 LightVela」；账号门禁其实已完成会话验证。iOS 账号模块现在先计算凭证作用域，再原子发布 `authenticated`，首页同步取得已验证会话直接挂载原生外壳；未取得会话只显示可重试错误，不再有独立过渡页。登录按钮忙碌态改为「正在登录…」。账号恢复回归覆盖成功、过期、切站和 401 清理，4/4 通过；Expo typecheck、iOS bundle（4776 modules）、diff check 和 Quick Tunnel 轻量核验通过。设备上从登录回调到首页的过渡还需观察。
- 进一步移除 iOS 账号门禁在初始化或恢复会话期间独立显示的全屏品牌图标页；同一段等待现在保留登录页布局，主按钮禁用并显示简短等待文案。认证完成仍直接进入工作台，不跳中间页。Expo typecheck、登录与会话恢复聚焦测试 13/13、iOS bundle（4789 modules）和 diff check 通过；当前 Expo Go iOS manifest 名为 OpenCraft，外部 Expo Go 启动提示仍需用户截图区分。

## risks
- 当前分支落后主线且工作树已有大量未提交改动；只编辑本任务所需路径，不重置、不提交。
- 真实账号、设备和 Host 的附件能力需要独立验收；静态检查不能证明线上链路。
- 当前 Hermes Host 没有工作区和权限目录，手机 Bot Chat 的相应控件不会出现；这不是原生呈现层可独立补齐的能力。
- iOS Fabric 适配层引用 React Native 0.86.3 私有组件，升级版本必须复核；选区、中文输入法、格式原位显示与键盘交互尚未在真机核验。手机文件夹「进入」按钮也缺少真机触控反馈。跨 quote/list/divider 边界的编辑仍保持原草稿并显示简短引导；嵌套结构块只在只读预览显示格式。桌面富文本块类型尚未完全对齐。

## validation
- DOM build/smoke、frontend check、Expo typecheck、聚焦测试与相关文档影响检查。

## decisions
- 业务状态留在已有 frontend/Composer/Host，移动端只提供呈现和平台文件选择适配。

## scan_scope
- `frontend/src/mobile-dom/`, `frontend/src/pages/marketing/agent-buddy-panel.tsx`, `frontend/src/components/domain/tat-file-manager-panel.tsx`, `opencraft/apps/workbench-expo/src/components/`。

## scan_output
- 有界 `rg` 与当前源码读取；未生成外部扫描文件。

## handoff
- 进行中；等待真机对人设/文件宽度、附件与键盘交互的反馈，并继续完善复杂富文本编辑。
