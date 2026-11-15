# 新建会话的 Agent 与模型

用户先认出要使用的 Agent，再选择它的模型。沿用 Composer 的共享 Radix 菜单：上方为 Agent 页签，下方只列该 Agent 的模型；模型厂商不再充当 Agent。外部触发器显示 Agent 与模型。选择 Agent 先浏览，不启动会话；明确选模型才提交。Manage models 保留，增加 Manage agents 进入聊天设置。

## 数据与所有权

服务器的 model/list 给每个模型附带 agentId/agentLabel；聚合 Host 在引擎边界填充，connected-agents 给原生已登录 Agent 填充，聚合不得覆盖其身份。onboarding/status 同时声明 engineId，与 model/list 使用相同的身份；前端不维护 onboarding id 到执行引擎 id 的映射。旧服务器没有这两个字段时保留 Host 级单组，不根据模型名字或括号猜 Agent。安装/登录状态只消费 onboarding/status 声明的 Agent，不在客户端注册可执行能力。

启用是本机用户的新建选择偏好，不是服务器运行配置或权限。UiPreferencesRuntime 的 installation key chat.agentAvailability 按 display/account/Host 隔离，保存 Agent 的明确开关；未配置默认开启，显式全关有效，新增 Agent 默认开启。Web IndexedDB / Electron Main SQLite 继续由已有 adapter 选择。设置与 onboarding 共用同一偏好，不直接读写物理存储。关闭不终止引擎、旧线程或服务端任务；只有独立客户端、用户可选择 Agent 的新草稿，其目录和发送准入受影响。embedded 的 host-default/session 和固定执行模式沿用宿主选择，不消费此偏好。

## 设置与 onboarding

设置与 onboarding 复用 HostAgentOnboarding 的主机级目录（useComposerCatalog(null)，不借用既有线程的 scoped 目录）和同一个合并目录和 SettingsListItem 行，每行包含共享图标、产品名称、状态与开关，不按引擎/原生接入来源分组；状态刷新是标题旁垂直居中的图标动作，窄容器保持同排；设置不再附加重复的引导入口。未安装或未登录时开关显示关闭且不可操作，仅安装/登录动作可用，不写入虚假的开启偏好。界面使用 DSH、Claude Code 等产品名，协议名留在实现层。继续与开始必须使用已开启且真实可选的 Agent 模型。首次进入可用服务端声明的默认模型直接继续。关闭所选 Agent 保留原选择并阻止继续，在按钮旁说明需选择已开启的 Agent 与模型，必须明确选择另一个 Agent 或重新开启；读取失败只提供目录已声明的备用选择。所有 Agent 都在同一引导中选择其模型，“Skip for now”只关闭引导；已有线程从设置完成引导时新建草稿，不修改原线程。开始前刷新真实目录并核对导航、账号、显示作用域与引导代次；等待期间关闭/返回/开始均禁用，结束或重开使旧代次失效。保存失败原位反馈，等待写入期间禁用重复操作。设置与引导的写入按同一 Runtime 排队，通过 UiPreferencesRuntime.update 在最新持久值上合并每个意图，CAS 冲突后重算，跨窗口不覆盖其他开关；作用域改变撤销尚未提交的意图，失败不改变可见开关。原生区和 API 区共享保存状态。

## 空态与连续性

全关时显示“没有开启的 Agent”及 Manage agents，不默认偷偷选回关闭的模型；可编辑草稿，发送禁用。某 Agent 无模型或读取失败显示已有目录反馈和重试；未安装/未登录只在管理与引导显示状态与安装/登录动作，不进入可发送目录。服务端目录始终是能力依据。已选 Agent 被关闭时保留草稿和选中意图，要求重新选择后才能发送；旧线程沿用完整目录。

## 页签、键盘与旧会话

Agent 页签只显示共享品牌图标，选中项用下划线标出。页签右侧始终显示当前浏览的 Agent 名称，并在已有线程同时标出当前会话 Agent（“当前会话”或“当前：Codex”），键盘聚焦、触控点按和读屏都能得到同一身份；无障碍名称经应用 IntlRuntime 组合。只有一个 Agent 时仍保留该页签和身份名称，不渲染虚假的竞争页签。触控命中区域继续由 `--size-control-hit-min` 与共享按钮密度提供，不另写像素尺寸。页签支持方向键、Home、End；方向键焦点停留在页签上，不把浏览当成选择。

`agentNext` / `agentPrevious` 注册在 Web/Electron 快捷键表中（Alt+P / Alt+Shift+P），设置页的快捷键列表投影同一份定义。快捷键只改变正在浏览的 Agent，不写入模型；选择器关闭时，只有在当前 Composer 内才打开选择器并移动页签。Option 组合键的 `event.key` 会随键盘布局变化，按物理 `event.code` 归一化。

已有线程打开选择器时，无论 Host 是否支持跨 Agent，都从目录和当前模型识别并标出当前 Agent；浏览当前 Agent 时显示“当前会话”，浏览其他 Agent 时显示“当前：Codex”保留身份；当前 Agent 模型缺失时保留当前身份，不因其他 Agent 有缓存而消失。只有 Host 声明了跨 Agent 上下文导出能力时才显示其他 Agent；浏览其他 Agent 时提示将带着当前会话上下文新建会话。选择其他 Agent 的模型沿用现有 `continueWithAgent` 打开新草稿，不伪装成同一线程续聊。没有该能力的旧线程只显示当前 Agent 的目录。

## 输入与容器

鼠标点击与触控点按使用相同的共享控件，键盘可 Tab 到 Agent 页签并选择，再使用模型菜单的键盘导航；Escape 关闭并由已有焦点 owner 恢复编辑区。菜单不重挂载编辑器、不清草稿。页签在窄容器横向滚动，模型区滚动，触控密度由现有输入偏好决定。页面留白、滚动和路由属于现有 Settings/Composer owner。

## 验证

验证模型的 Agent 元数据投影、偏好隔离与显式全关、新草稿准入和旧线程不变；实际 Web Shell 在桌面及触控窄屏验证选择、发送、设置开关、onboarding 和空态，保留截图及验证边界。Agent 页签验证图标-only、下划线、悬停/焦点/触控可见名称、无障碍名称、触控命中区、方向键和焦点环不裁切；推理区验证只在模型声明 effort 时出现；快捷键验证注册、设置列表、循环、长按 repeat 不写入搜索和边界；旧会话验证单 Agent/无跨 Agent 能力时的当前身份、跨 Agent 提示以及新草稿交接。参考 BB 的 provider/model picker 与 ProvidersSettingsSection，参考版本固定为 `73fe7b4ad9a0c7f7c3f16b8e369fc61cccaea7d2`，只读查看 `ModelReasoningPicker.tsx`、`ModelReasoningMenu.tsx`、`modelPickerCycle.ts`、`modelPickerToggle.ts` 与 `ProvidersSettingsSection.tsx`，只借鉴图标页签、组合推理、快捷键与旧会话标记；实现独立。
