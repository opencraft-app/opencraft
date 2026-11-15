# 新建会话的 Agent 与模型

用户先认出要使用的 Agent，再选择它的模型。沿用 Composer 的共享 Radix 菜单：上方为 Agent 页签，下方只列该 Agent 的模型；模型厂商不再充当 Agent。外部触发器显示 Agent 与模型。选择 Agent 先浏览，不启动会话；明确选模型才提交。有可选模型时只保留 Manage models；全部 Agent 关闭的空态仍提供 Manage agents，用来重新开启。

## 数据与所有权

服务器的 model/list 给每个模型附带 agentId/agentLabel；聚合 Host 在引擎边界填充，connected-agents 给原生已登录 Agent 填充，聚合不得覆盖其身份。onboarding/status 同时声明 engineId，与 model/list 使用相同的身份；前端不维护 onboarding id 到执行引擎 id 的映射。旧服务器没有这两个字段时保留 Host 级单组，不根据模型名字或括号猜 Agent。某 Agent 已有带身份的页签时，不再单独显示同名且没有 agentId 的 Host 目录：本机 Codex CLI 出现后，内置 Codex app server 不再占第二个 Codex 页签；只有本机 Codex 不在目录里时才显示内置目录。安装/登录状态只消费 onboarding/status 声明的 Agent，不在客户端注册可执行能力。

启用是本机用户的新建选择偏好，不是服务器运行配置或权限。UiPreferencesRuntime 的 installation key chat.agentAvailability 按 display/account/Host 隔离，保存 Agent 的明确开关；未配置默认开启，显式全关有效，新增 Agent 默认开启。Web IndexedDB / Electron Main SQLite 继续由已有 adapter 选择。设置与 onboarding 共用同一偏好，不直接读写物理存储。关闭不终止引擎、旧线程或服务端任务；只有独立客户端、用户可选择 Agent 的新草稿，其目录和发送准入受影响。embedded 的 host-default/session 和固定执行模式沿用宿主选择，不消费此偏好。

## 设置与 onboarding

设置与 onboarding 复用 HostAgentOnboarding 的主机级目录（useComposerCatalog(null)，不借用既有线程的 scoped 目录）和同一个合并目录和 SettingsListItem 行，每行包含共享图标、产品名称、状态与开关，不按引擎/原生接入来源分组；状态刷新是标题旁垂直居中的图标动作，窄容器保持同排；设置不再附加重复的引导入口。未安装或未登录时开关显示关闭且不可操作，仅安装/登录动作可用，不写入虚假的开启偏好。界面使用 DSH、Claude Code 等产品名，协议名留在实现层。继续与开始必须使用已开启且真实可选的 Agent 模型。首次进入可用服务端声明的默认模型直接继续。关闭所选 Agent 保留原选择并阻止继续，在按钮旁说明需选择已开启的 Agent 与模型，必须明确选择另一个 Agent 或重新开启；读取失败只提供目录已声明的备用选择。所有 Agent 都在同一引导中选择其模型，“Skip for now”只关闭引导；已有线程从设置完成引导时新建草稿，不修改原线程。开始前刷新真实目录并核对导航、账号、显示作用域与引导代次；等待期间关闭/返回/开始均禁用，结束或重开使旧代次失效。保存失败原位反馈，等待写入期间禁用重复操作。设置与引导的写入按同一 Runtime 排队，通过 UiPreferencesRuntime.update 在最新持久值上合并每个意图，CAS 冲突后重算，跨窗口不覆盖其他开关；作用域改变撤销尚未提交的意图，失败不改变可见开关。原生区和 API 区共享保存状态。

## 空态与连续性

全关时显示“没有开启的 Agent”及 Manage agents，不默认偷偷选回关闭的模型；可编辑草稿，发送禁用。设置页只写入当前 Host 的开关；新建草稿用这一份开关过滤每个 Host 上的同名 Agent，关闭 Codex 后不能从另一 Host 的目录点选并切走执行来源。某 Agent 无模型或读取失败显示已有目录反馈和重试；未安装/未登录只在管理与引导显示状态与安装/登录动作，不进入可发送目录。服务端目录始终是能力依据。已选 Agent 被关闭时保留草稿和选中意图，要求重新选择后才能发送；旧线程沿用完整目录。

## 页签、键盘与旧会话

Agent 页签同时显示共享品牌图标和产品名称，选中项用下划线标出。名称在点按前就可见，触控不必靠悬停或逐个试图标。页签右侧仍标出已有线程的当前会话（“当前会话”或“当前：Codex”）。无障碍名称经应用 IntlRuntime 组合。只有一个 Agent 时仍保留该页签和名称。触控命中区域继续由 `--size-control-hit-min` 与共享按钮密度提供。页签横向滚动，不把名称折成多行把模型列表顶出。页签支持方向键、Home、End；方向键焦点停留在页签上，不把浏览当成选择。

## 思考深度层

新线程第一次打开选择器时先是 Agent 页签和模型列表。选中一个声明了思考深度的模型后，菜单留在打开状态并进入滑条层：上方是当前档位名称，模型名可点，下方是共享 DiscreteSlider。已有线程，以及新线程再次打开选择器时，直接进入滑条层。点模型名才回到 Agent 与模型页，沿用页签、搜索和当前会话标记。模型没有声明档位时不显示滑条，选择器停在模型页，也不把线程里别处记下的档位画成可调状态。只有一档时滑条禁用，仍可回到模型页。拖动只预览，松手才提交；方向键、Home 和 End 调整同一档位。Codex 以具体模型 id 表达档位的，滑条仍提交那个 id，不另发 effort。减少动态效果时档位立即到位。草稿、编辑器身份和焦点租约保持不变。

CodeBuddy、Claude Code 等 ACP 会话如果用 `thought_level` 或 `effort` 声明一组档位，且目录不是 Codex 那种带方括号的具体 id，model/list 把这组档位投影到该会话的每个模型上，默认档位保持未声明（当前值不是默认值）。选择后通过 `session/set_config_option` 下发。没有这组声明时不显示滑条。

`agentNext` / `agentPrevious` 注册在 Web/Electron 快捷键表中（Alt+P / Alt+Shift+P），设置页的快捷键列表投影同一份定义。快捷键只改变正在浏览的 Agent，不写入模型；选择器关闭时，只有在当前 Composer 内才打开选择器并移动页签。Option 组合键的 `event.key` 会随键盘布局变化，按物理 `event.code` 归一化。

已有线程打开选择器时，从服务端声明的执行引擎和模型身份识别当前 Agent；浏览当前 Agent 时显示“当前会话”，浏览其他 Agent 时显示“当前：Codex”等身份。只有 Host 声明 `opencraft/thread-access.agentHandoff` 时才开放跨 Agent 选择。只换当前 Agent 的模型仍在原线程发送。

## 会话中途换 Agent

在原线程里选中另一个 Agent 的模型后，仍停在原页面；Composer 显示“继续自 @thread:…”引用及“下一条消息将在所选 Agent 的新会话中发送”。此时可以继续编辑文字、附件、模型、思考深度与权限，不修改原线程的执行选择。引用旁的取消按钮退出 handoff，恢复开始前的选择，移除引用，保留期间编辑的文字及附件；再次选择原 Agent 也退出 handoff。重复选择目标 Agent 不叠加引用。

发送时才创建新线程，显式提交 agentId、模型、思考深度及权限；第一条消息包含源线程的稳定 conversation reference、用户文字和附件。新 Agent 使用当前执行的 OpenCraft 线程 CLI `thread output` 分页读取旧上下文，引用本身不携带历史，也不授予访问权限。Host 提供该次输入专属的 launcher 路径，不把 bearer 放进提示词或持久草稿。CLI 按发起人的委托、源线程 private ACL 和协作空间成员关系重新授权，执行结束撤销 launcher。认证排队输入把原始签发证明保存在原生私有队列中以支持重开；编辑、重放与手动启动队列不替换该证明，队列及历史的客户端投影不携带它。

服务端在新建准入和响应交付时都检查源线程权限，新线程继承源线程的 private/shared 可见性和协作空间，不使用当前选择空间覆盖来源。原线程和原生 session 保持原 owner；不迁移工具执行、审批或原生 session，不导出完整历史文件。失败时保留原页草稿和附件，以非阻塞通知提供重试。创建成功后 Router PUSH 到新会话（草稿晋升仍由原有 owner replace），返回可回到旧线程；晚到结果不能抢回用户已经离开的页面。

## 输入与容器

鼠标点击与触控点按使用相同的共享控件，键盘可 Tab 到 Agent 页签并选择，再使用模型菜单的键盘导航；Escape 关闭并由已有焦点 owner 恢复编辑区。菜单不重挂载编辑器、不清草稿。页签在窄容器横向滚动，模型区滚动，触控密度由现有输入偏好决定。页面留白、滚动和路由属于现有 Settings/Composer owner。

## 验证

验证模型的 Agent 元数据投影、偏好隔离与显式全关、新草稿准入和旧线程不变；实际 Web Shell 在桌面及触控窄屏验证选择、发送、设置开关、onboarding 和空态，保留截图及验证边界。Agent 页签验证图标加名称、下划线、悬停/焦点/触控可见名称、无障碍名称、触控命中区、方向键和焦点环不裁切；推理区验证滑条层只在模型声明档位时出现，新线程首次打开停在模型页，已有线程直接进入滑条，点模型名才回到 Agent 页；快捷键验证注册、设置列表、循环、长按 repeat 不写入搜索和边界；旧会话验证单 Agent/无跨 Agent 能力时的当前身份、跨 Agent 提示以及新草稿交接。参考 BB 的 provider/model picker 与 ProvidersSettingsSection，参考版本固定为 `73fe7b4ad9a0c7f7c3f16b8e369fc61cccaea7d2`，只读查看 `ModelReasoningPicker.tsx`、`ModelReasoningMenu.tsx`、`modelPickerCycle.ts`、`modelPickerToggle.ts` 与 `ProvidersSettingsSection.tsx`，只借鉴分层选择、快捷键与旧会话标记；实现独立。引导里的 Codex 目录按模型族聚合，深度用同一滑条选择具体 id，不再把每个档位展开成独立模型。
