# 新建会话的 Agent 与模型

新建会话的 Composer 顶行只提供 **机器 → 文件夹 → Agent** 三个选择；不再在输入框上方追加“使用某 Agent”的大卡片。Agent 消费当前机器的真实模型目录，选择它即提交该 Agent 的可用默认模型，不创建会话、不发送输入。下方模型菜单仅显示当前 Agent 的模型、思考档位及支持的控制项，不再重复 Agent 标签页或 Agent 名称。未固定执行目标的其它 Composer 仍可沿用菜单中的分层选择；既有会话不改变执行身份。

沿用 Composer、ExecutionUtilityBar 的共享 Radix 菜单与 DisclosureButton。Composer 是模型选择事务的唯一前端 owner，通过 header 槽位交出 Agent 呈现，机器与文件夹仍由现有 Workbench 意图提交；不复制另一份 Agent 选择状态。顶行按容器压缩机器和文件夹名称，Agent 保留可读宽度；完整名称仍在菜单中。Manage agents 收进 Agent 菜单，模型配置保留在模型菜单。

## 数据与所有权

服务器的 model/list 给每个模型附带 agentId/agentLabel；聚合 Host 在引擎边界填充，connected-agents 给原生已登录 Agent 填充，聚合不得覆盖其身份。onboarding/status 同时声明 engineId，与 model/list 使用相同的身份；前端不维护 onboarding id 到执行引擎 id 的映射。旧服务器没有这两个字段时保留 Host 级单组，不根据模型名字或括号猜 Agent。安装/登录状态只消费 onboarding/status 声明的 Agent，不在客户端注册可执行能力。

启用是本机用户的新建选择偏好，不是服务器运行配置或权限。UiPreferencesRuntime 的 installation key chat.agentAvailability 按 display/account/Host 隔离，保存 Agent 的明确开关；未配置默认开启，显式全关有效，新增 Agent 默认开启。Web IndexedDB / Electron Main SQLite 继续由已有 adapter 选择。设置与 onboarding 共用同一偏好，不直接读写物理存储。关闭不终止引擎、旧线程或服务端任务；只有独立客户端、用户可选择 Agent 的新草稿，其目录和发送准入受影响。embedded 的 host-default/session 和固定执行模式沿用宿主选择，不消费此偏好。

## 设置与 onboarding

设置与 onboarding 复用 HostAgentOnboarding 的主机级目录（useComposerCatalog(null)，不借用既有线程的 scoped 目录）和同一个合并目录和 SettingsListItem 行，每行包含共享图标、产品名称、状态与开关，不按引擎/原生接入来源分组；状态刷新是标题旁垂直居中的图标动作，窄容器保持同排；设置不再附加重复的引导入口。未安装或未登录时开关显示关闭且不可操作，仅安装/登录动作可用，不写入虚假的开启偏好。界面使用 DSH、Claude Code 等产品名，协议名留在实现层。继续与开始必须使用已开启且真实可选的 Agent 模型。首次进入可用服务端声明的默认模型直接继续。关闭所选 Agent 保留原选择并阻止继续，在按钮旁说明需选择已开启的 Agent 与模型，必须明确选择另一个 Agent 或重新开启；读取失败只提供目录已声明的备用选择。所有 Agent 都在同一引导中选择其模型，“Skip for now”只关闭引导；已有线程从设置完成引导时新建草稿，不修改原线程。开始前刷新真实目录并核对导航、账号、显示作用域与引导代次；等待期间关闭/返回/开始均禁用，结束或重开使旧代次失效。保存失败原位反馈，等待写入期间禁用重复操作。设置与引导的写入按同一 Runtime 排队，通过 UiPreferencesRuntime.update 在最新持久值上合并每个意图，CAS 冲突后重算，跨窗口不覆盖其他开关；作用域改变撤销尚未提交的意图，失败不改变可见开关。原生区和 API 区共享保存状态。

## 空态与连续性

全关时显示“没有开启的 Agent”及 Manage agents，不默认偷偷选回关闭的模型；可编辑草稿，发送禁用。某 Agent 无模型或读取失败显示已有目录反馈和重试；未安装/未登录只在管理与引导显示状态与安装/登录动作，不进入可发送目录。服务端目录始终是能力依据。已选 Agent 被关闭时保留草稿和选中意图，要求重新选择后才能发送；旧线程沿用完整目录。

## 输入与容器

鼠标点击与触控点按使用相同的共享控件，键盘可 Tab 到具名 Agent 按钮并选择，再使用模型菜单的键盘导航；Escape 关闭并由已有焦点 owner 恢复编辑区。菜单不重挂载编辑器、不清草稿。Agent 组在窄容器换行，模型区滚动，触控密度由现有输入偏好决定。页面留白、滚动和路由属于现有 Settings/Composer owner。

## 验证

验证模型的 Agent 元数据投影、偏好隔离与显式全关、新草稿准入和旧线程不变；实际 Web Shell 在桌面及触控窄屏验证选择、发送、设置开关、onboarding 和空态，保留截图及验证边界。参考 BB 的 provider/model picker 与 ProvidersSettingsSection，参考版本固定为 `73fe7b4ad9a0c7f7c3f16b8e369fc61cccaea7d2`，只读查看 `ModelReasoningPicker.tsx` 与 `ProvidersSettingsSection.tsx`，只借鉴分层选择、启用投影及旧会话保留；实现独立。

## 发送准入与本轮验证（2026-11-17）

原生 Pi CLI 的 `pi-cli:` 选择使用其原生登录与 Host 目录，不再误读 API provider 凭据；随包 Pi 的 `pi:` 仍走自己的 API 凭据检查。新草稿的设置检查与 Composer 使用相同的默认模型回退顺序。空文本保持发送禁用；有文本且模型与连接可用时发送启用。机器断线、偏好尚未加载、模型不可用或正在切换 Agent 时，在输入框内说明原因；切换失败保留旧选择与草稿。等待期间键盘、按钮与语音提交共用准入边界；迟到结果不能解除新选择的等待。

沿用真实 AppShell/NewThreadDraftPage/Composer 组合，外部模型目录用合成数据。`smoke-draft-agent-selector.ts` 验证三个顶行入口、底部目录隔离、Pi/Cursor/Codex 切换、失败重试、快速重复选择及迟到完成、断线恢复、空目录、320px 容器和同一编辑器/草稿保留。另复查旧模型浏览器的菜单路径。真实本地 Web 也选择已安装 Pi、输入文字核对按钮启用，再清空恢复禁用，没有提交模型请求；截图记录在 `/tmp/opencraft-draft-live-desktop.png` 与 `/tmp/opencraft-draft-live-touch.png`。浏览器触控仿真不是手机真机验收，Electron 窗口、远端机器的付费推理未验证。实际查看了本地首页的电脑与触屏画面，以及 fixture 的浅色、深色和 lavender 组合；三项顶行清晰，底部模型没有重复 Agent 名称，触屏 Pi 名称不会被机器/文件夹挤成单字。fixture 的外部麦克风按钮只用于布局验收，不是产品控件变更。六组输入/主题 smoke 与旧模型浏览器 smoke 通过；7 条模型准入单测、相关包类型检查、i18n/controls/boundaries 检查通过，Web 构建及其兼容性检查通过。源码由现有本地 Vite 进程提供，未升级远端 Host 或发布发行版。全仓 gate 仍有此前记录的 Expo/worklets 依赖版本问题，本轮没有改动该依赖链。

## 模型/Agent 配置页面整理（2026-11-17）

Settings master-detail 范式沿用现有 Model services 真消费者的滚动与宽度 owner。页面标题统一为“模型/Agent 配置”，Agent 配置在前，模型配置在后；通过平台 AgentConfiguration 槽位复用客户端已有接入/导入 owner，不允许插件反向导入 App。两个页签保留挂载，模型编辑草稿和各自选中项不随页签丢失。Agent 左侧按设备与 Host 身份列目录，右侧保留安装、登录、启用与会话导入操作。接入远程是目录的 Add 目的地；已接入的 Agent 回到同一目录并标记远程。按所属 Host 读取能力和历史，不切换正在聊天的 Host；离线保留已读目录，撤销/移除清理对应作用域。窄容器保留目录到详情的返回路径，触控命中范围与键盘导航复用共享 owner。

Agent 目录先读取轻量能力/安装元数据；API 引擎的模型目录独立读取，不能让远端模型探测阻塞 Agent 名称出现。旧 Host 对新目录方法返回标准 -32601，或明确的旧 DSH unsupported -32603 包装时，才回退现有状态方法；其它错误保留错误语义与已读目录。真实旧远端 Codex 已核对可通过该路径呈现“远程”，不需要升级远端或停止其正在执行的任务。构建里为已有的按需历史模块保留独立 chunk，避免新增设置消费者使它合并进启动共享 chunk；不放宽启动预算。

验收：查看了真实本地 Web 设置路由 `/settings/opencraft.builtin-agents.model-services` 的 Agent/模型两页签，截图为 `/tmp/opencraft-agent-settings-live.png`、`/tmp/opencraft-model-settings-live.png`；旧远端设备的 Codex 已在同一左侧目录标记远程。真实页面只读取状态与目录，没有修改真实模型凭据、登录状态或执行真实导入/推理。另查看合成外部边界的真实组件组合中桌面 lavender 和触屏深色画面，确认两栏、窄容器目录/详情返回与导入列表可达。

六组输入/主题 smoke 验证了远程来源隔离、会话导入提交、导入等待时锁定目录、页签切换后模型草稿/选区与导入目录保留、后台读取失败与恢复、离线缓存保留、命令草稿保留和切语言后的焦点/输入连续性。22 条目录与模型服务单测、相关类型检查、i18n/controls/boundaries 和 Web 构建通过；原有按需历史不进入启动包的检查保持生效。已有全仓 gate 的 Expo/worklets 依赖版本问题不属于本改动。

交付为本 checkout 的源码、已验证的 Web 构建与当前 Vite 预览；只重载了前端开发服务，执行 Host 进程保持原 PID，远端后续观察到 idle。未发布发行版、未升级远端伴随程序；Electron 窗口和手机真机未验证。
