# Model usage policy（实施设计）

目标：管理员可禁止模型或思考深度；所有新轮次和续跑在执行前读取最新策略，拒绝时给出可用替代项，绝不自动降级。正在执行的轮次继续，下一轮执行新规则。

## 策略与权限

核心拥有部署级策略、校验器及审计。使用独立 managed SQLite 库，追加 migration 建立 singleton policy（revision、规则 JSON）和不可由业务删除的 audit（actor、时间、前后规则、revision）；CAS 更新与审计在同一事务提交。规则按 engine ID + 规范模型 ID 定位，思考深度存协议值，支持引擎范围禁止深度及特定模型范围禁止深度。空策略允许现有能力；未知字段、未知引擎、重复规则及无效深度拒绝。目录变化不删除旧禁令；已下线模型的禁令保留以防再次出现。

设置读写须通过服务端当前 membership/admin 判断；身份、准入与角色来源继续由产品身份插件提供，不向核心引入企业身份依赖。普通用户只能读过滤后的可用目录与禁用原因，不能读取管理配置、审计或修改接口；管理员自身发起轮次同样受策略约束。写接口执行同源、有效身份和大小校验，提交时复核权限；审计记录服务端 Actor，不能信任客户端姓名。

owner 内最终准入点必须读取共享 authority 的最新 revision。不能仅在网关缓存策略：内部调度会绕过它。authority 不可用时拒绝新增执行，历史读取仍可用；不以旧缓存放行。提交与准入有确定的序列化边界，更新完成后新准入均消费新 revision。各 owner 通过共享路径逐次只读 SQLite；写入用 BEGIN IMMEDIATE 事务串行更新。

## 执行点与回归契约

| 路径 | 已定位代码 / 所需校验 | 回归观察 |
| --- | --- | --- |
| 网页、API | daemon Codex adapter 的 send / requestPhysical；聚合 Host/provider 路由 | 显式覆盖、默认值、持久线程选择都不能绕过；拒绝前不写输入 |
| Codex IM、恢复、goal | codex-engine-adapter.ts 的内部 requestPhysical(turn/start)，含恢复分支与 goal 定时器 | 新禁令后下一轮拒绝；保留原配置并给替代项 |
| Pi IM、定时任务 | pi-engine/src/index.ts 的 inputs.submit 与 scheduled handle(turn/start) | 与普通请求同样拒绝 |
| Pi 队列、自动派发、重启恢复 | dispatchQueue / native.submit，及普通 handle(turn/start) | 入队后禁用也必须拒绝派发，不丢输入，不宣称已执行 |
| DSH goal、队列与恢复 | dsh-thread-engine.mjs 的 goals 服务及 DSH 原生调度准入 | 原生 prepareCall 解析后 await policy admission，覆盖 goal 自动续跑；不能仅检查 adapter RPC |
| ACP / DSH ACP | acp-engine/src/index.ts，代绑定及原生 prompt 前 | 旧会话绑定与新建都检查实际模型；不能以默认模型绕过 |
| 线程编排 | thread-orchestration-execution.mjs、各引擎编排 create/continue 与最终 Turn 准入 | 子线程继承和显式覆盖都检查，工具返回明确拒绝 |
| 活跃轮次 steer / 队列 steer | 检查是否开启新执行或改变模型；最终执行点兜底 | 不通过 steer 偷换禁用模型；不打断已开始轮次 |
| 管理与目录 | 当前角色权限、CAS、审计、目录投影 | 非管理员读写禁止；并发冲突不覆写；写失败无审计成功记录 |

上述为执行点及回归契约，每条入口必须有可观测回归测试，包括合成 provider 的调用计数为零、明确错误码与替代项、旧线程下轮生效、管理员角色撤销。

## 引擎模型目录对应

| 引擎 | 目录与模型身份 | 思考深度 |
| --- | --- | --- |
| Codex | 原生 model/list 的 model ID，保留实际代目录；显示名称不作为键 | supportedReasoningEfforts 的 reasoningEffort；Ultra 的显示词须映射真实协议值（如 xhigh），不得用字符串 ultra 猜测 |
| Pi | PiEngine.models() 的 piModel(provider,id)，从 SDK 可用目录生成 | getSupportedThinkingLevels；off 对外映射 none，其余保留原值 |
| DSH | dsh-appserver-adapter.ts 的模型目录适配，保留 provider/model 唯一身份 | model.reasoning.efforts 的 id |
| ACP（含 DSH ACP） | 从 session/new、session/resume/load 的 models/configOptions 获取实际目录与默认值，持久化到会话；model/list 按 driver 与模型 ID 隔离 | 当前明确拒绝 reasoningEffort；不制造不存在的选项 |

RemoteEngineProvider 的 modelPrefix 只用于路由，不替代引擎内部的真实模型身份。所有省略选择、默认配置、旧线程和 fork 继承必须先解析实际选项再校验；目录未知不能解释为策略不适用。ACP peer 未声明实际模型时，存在该引擎限制的执行按未知选择拒绝。

## 界面

沿用 Settings 文档容器、共享 SettingsRow 和现有模型选择器；管理员入口按服务端 canManage 投影，主动作保存。普通用户的禁用选项置灰，附简短原因；旧选择仍可显示为受限，不自动改写草稿。错误走既有非阻塞通知，回复包含结构化可用替代项；无替代项时提示联系管理员。英文稳定 ID + 中文本地化，保持切语言时草稿与焦点。

最终中文界面：模型使用限制 / 禁用模型 / 禁用思考深度 / 保存 / 无法保存限制，请重新加载后重试。 / 部分选项已被管理员禁用。服务端拒绝包含结构化替代项，沿用英文协议错误文案；没有替代项时提示联系管理员。

## 独立 owner 生效边界

Pi、多引擎 Host、DSH、ACP 是独立固定 owner，仅更新 gateway 不更新其内存代码。Pi dispatchQueue 直接调用 native.submit；DSH 原生 goal 可以在客户端断开后继续。完整生效需要分别更新这些 owner 的固定制品并按照已有交接协议维护，不能把 gateway 的 buildId 当作独立引擎已加载新代码的证据。

## 实现与验证

核心包 model-usage-policy 拥有独立 managed SQLite 库、CAS+审计、只读原生 reader、HTTP authority 和网关 Transport。所有策略均适用于管理员自身。原生 reader 不持有策略缓存；策略库不可读时拒绝新增执行。Pi 被禁队列暂停并保留输入；ACP 已证明拒绝的 IM 输入清除未知回执，允许改配置后重试。

回归覆盖权限、CAS、审计、目录投影、网关执行与队列入口、Pi 普通输入与真实自动派发、Codex 外部/内部恢复和 goal、ACP 默认模型与 IM、DSH resolved request 边界。真实 locked DSH smoke 覆盖运行中更新策略、当前轮次继续且下一轮不再发起模型请求。设置页使用真实 Workbench Settings 路由验证保存和非管理员无入口；宽窄、浅深主题的截图应在每次界面变更后复核。
