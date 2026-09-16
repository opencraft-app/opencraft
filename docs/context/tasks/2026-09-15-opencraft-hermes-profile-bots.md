---
id: opencraft-hermes-profile-bots-20260915
type: task
scope: Hermes已有多profile Bot的AppServer只读目录和聊天适配。
triggers:
  - opencraft hermes profile bots
  - Hermes 多profile适配
  - bot conversation binding
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - opencraft/docs/platform-architecture.md
  - opencraft/design/hermes-profile-bots/task_plan.md
status: active
reviewed_at: 2026-09-15
review_due: 2026-12-14
revision: 1.0.0
precedence: task
derived: false
---

## goal
单实例Host内已有多profile Bot，经typed AppServer扩展发现/聊天/恢复/取消，控制面身份明确。
第二阶段（用户追加）：实现Bots应用入口及创建、克隆、重命名、删除，按Host和单Bot能力呈现，经现有控制面管理Profile。
第三阶段（2026-09-16）：桥接Hermes Hosted Room原生多Bot群聊，并补齐Hermes agent/list与模型目录联合协商。
## non_goals
不改CTL/生产，不付费推理，不提交发布，不新增profile Host；不把默认Bot删除升级为实例销毁。
## requirement_ids / requirement_refs / requirement_excerpt
用户同意评估第一阶段：先接已有Bot，不新造协议或把profile路由放React。
## interface_refs / data_structure_refs
vela/bot-conversations、HermesBotAppServerHandler、HermesInstanceProfileBot、session profile ownership、LightVela实例Host。
## history_context
current_design_refs：platform-architecture；relevant_evolution：Bridge dormant capability已有，正式Host仍单实例单Bot投影；superseded_refs：display name拼profile及一profile一Host猜测。
## acceptance
控制面ID映射、main/default别名、readonly能力探测、不支持不伪造；多profile会话与取消隔离；换账户/Host失效拒绝旧数据。
## affected_paths
OpenCraft Hermes plugin、Bot protocol bridge、tests与docs。
## required_context
OpenCraft路由无匹配；Ctl契约评估曾路由must_read。
## context_receipt
| 文件 | 原因 | 用途 |
|---|---|---|
| opencraft/AGENTS.md | service | workspace/gate |
| opencraft/.agents/skills/opencraft-maintenance/SKILL.md | 所有权 | scoped端口 |
| opencraft/docs/platform-architecture.md | 当前设计 | 扩展边界 |
| ctl/AGENTS.md | readonly参考 | 不改控制面 |
| docs/context/project/services/ctl.md | must_read | 契约authority |
| docs/context/domains/agent-gateway-runtime.md | must_read | provider/协议归属 |
| frontend/AGENTS.md | readonly参考 | 比较bot契约 |
| docs/context/project/services/service-gateway.md | 404只读诊断must_read | 公共路由归属 |
| service-gateway/AGENTS.md | 404只读诊断 | 不修改生产 |
## evidence
见design/hermes-profile-bots/findings.md。
## risks
不能以UI隐藏代替management禁止；没有能力的旧Dashboard不得伪造Bot；实网与RPC替身区别说明。
## validation
TDD、类型/完整gate、profile并发恢复/取消/readonly拒绝与实际目录组件或签名客户端。
## decisions
Control/catalog身份与runtime profile分离，typed Bot扩展复用；physical Host单连接。
## scan_scope
限定Hermes bridge/transport与当前profile Bot契约，不扫描私人实例数据。
## scan_output
design/hermes-profile-bots/findings.md。
## handoff
第二阶段Bots入口及控制面创建/克隆/重命名/删除实现；完整gate、14项管理聚焦测试和真实控件/API替身验收通过。
最终签名Mac包457个renderer文件匹配当前构建，已打开Bots页。真实Hermes云资源写入未执行；根context仍4项既有失败，未提交推送。
## checkpoint
Unknown-provider最终根因：机器config.yaml真实存在`lightvela-custom-111-1yq8src`且默认路由引用它；错误文案出现双单引号是因为Adapter把shell-quoted token传给按`split()`解析的config.set RPC，Hermes查找的是含字面量引号的provider。现改为RPC原始token并拒绝空白/flag；自动发现目录完整保留，不按配置模型过滤。旧/外部provider仅按当前目录唯一模型owner动态重绑定。84项Hermes/能力一致性测试通过。
真实实例只读核对：`acli provider list --agent main`投影默认显示名=`111`、默认模型=`deepseek-v4-flash-0731`；随后脱敏读取config.yaml确认其底层provider key为`lightvela-custom-111-1yq8src`且默认路由引用该key。未修改远端配置。
Bot Chat optimistic消息布局修复：`Sending…/Not sent`从气泡正文移到外层状态槽，传输确认只移除状态，不再改变正文气泡高度/圆角；不使用固定高度或布局动画。Bot Chat、Workbench类型检查及137项扩展测试通过；合并群聊能力的最终预览为release/hermes-groups-draft-stable-20260916。
Hosted Room首个完整切片已实现：能力探测、目录、2–6 Bot创建、state/log恢复、发送、日志增量投影、停止、审批、改名和永久解散；authority epoch/seq投影AppServer live cursor。Web Bots页增加能力驱动“新建群聊”选择器。Hermes agent/list补齐，协商失败返回空页避免抹掉model/list。聚焦群聊与联合模型目录测试通过，待完整gate及最新版真实Server验收。
2026-09-16最终实机验收通过：release/bot-canonical-identity-final-20260915使用既有登录profile连接国际站New Bot，打开conversation `20260915_220527_127dc9`后恢复标题为`New chat`、Bot为`New Bot`且历史文本正常出现，不再显示Could not restore/Conversation not found。未发送新消息或修改Bot。
最终根因闭环：`Conversation not found`有两处同文案来源。除Dashboard HTTP200语义错误信封外，Bot Handler还曾以恢复后的展示标题必须等于`Bot Chat`验证canonical身份；session.list可投影`New chat`，因而在历史回退前主动notFound。现以`profile + resolveNamedThread`返回的canonical session ID验证身份，并让历史回退消费同一个验证结果，不再重复检查标题。History Client同时在边界解包HTTP200错误信封。新增“message_count=1但未物化”“恢复标题变化但canonical ID相同”“HTTP200语义错误”回归；90项聚焦测试及插件类型检查全过。最终包release/bot-canonical-identity-final-20260915已启动，Mac随后锁屏，尚未完成最后UI点击验收。
第二次实机反馈证明messageCount门槛仍错误：Hermes Gateway的message_count包含Gateway状态，不等于Dashboard持久消息行数。最终规则限定在已被loadThread成功Resume且标题为canonical `Bot Chat`的Bot会话；此时Dashboard的Session/Conversation-not-found仅表示当前无持久 transcript，live/inflight仍由Resume投影。普通线程和其他错误仍失败。端到端测试已把新建canonical会话设为message_count=1且历史缺失并验证返回空页。最终包release/bot-canonical-history-20260915已打开；本次最终实网重验遭账号服务网络失败阻断，前一轮实机已证明Dashboard以HTTP200语义错误信封返回not-found。未发送消息或修改Bot。
Bot空会话恢复根因修复：Hermes Gateway `session.resume` 已拥有会话存在性和实时 `message_count`，Dashboard REST仅拥有已物化消息；新Bot首条消息前REST会返回`Conversation not found: <id>`。实机传输日志证明该Dashboard版本以HTTP 200错误信封承载该语义，而非HTTP 404；适配层现遵循Hermes Desktop按语义错误建模，不从HTTP状态推导所有权。Adapter同时以Resume消息数覆盖可能缺失/滞后的session.list投影，并仅在Resume确认`messageCount=0`时映射为空历史；非空会话及其他错误继续失败。精确Bridge端到端回归、88项聚焦测试和Hermes插件/Web类型检查通过。预览过程中还发现普通Web build不会更新Electron专用`dist-electron`，最终包已按`OPENCRAFT_BUILD_TARGET=electron`重建；未发送消息或修改Bot。
真实New Bot打开失败：Gateway恢复返回空会话，但Dashboard历史404使用`Conversation not found`新文案；adapter仅识别`Session not found`。修复严格限定恢复messageCount=0+HTTP404两种文案为空历史，非空会话及其他错误继续失败。
用户要求不展示部署原因，route_not_allowed对用户统一呈现“内部错误，请稍后重试”，代码仍用于内部诊断和立即失败。实时核对GitOps MR !4038仍opened，尚未合入或同步国际站。
用户指出超时提示仍无真实原因。实网已知国际站返回404/error=route_not_allowed，但Bridge此前把所有HTTP404当能力缺失并进入20秒waitForCapability。修正为HTTP控制面错误立即传播并给出站点Bot接口未开放文案；仅Hermes RPC -32601按能力缺失降级。
实机首版仍卡“正在读取Bots”：deadline仅包Host connect，后续directory.refresh未纳入。修正为连接+目录统一15秒事务，目录阶段原因明确；待重新构建实机验证。
用户进一步明确连接不应成为用户感知步骤，进入页面应直接是Bot列表。View现对唯一云端Hermes Host自动单次连接/刷新，移除连接按钮；加载显示阶段，失败展示原因并可从刷新动作重试。
用户实机发现云端连接按钮永久“连接中”。根因是View直接等待Registry的未完成单例Promise且无UI deadline。补15秒有界等待，超时释放busy并提示后台连接；不取消/复制Registry所有的物理连接。测试与预览验证进行中。
用户修正交互：Bots页面不允许选择实例，当前Bot创建只属于云端Hermes。实现固定筛选lightvela.hermes Host并移除下拉；Local/其他provider排除，多云端无唯一owner时fail-closed。聚焦与真实UI验证进行中。
账号IPC修复完成：47项账号测试、Electron类型/构建、签名、边界/文档/影响检查通过。
修复包release/bot-account-fix-20260915沿用用户原preview-bot-management-ready-20260915目录重启，登录保留。
真实只读对比：旧包实例GET200而bots在IPC拒绝；新包实例GET200，bots抵达国际站后返回404 {error:route_not_allowed}。
service-gateway配置测试区分domesticWant，sgprod不含Bot路由，属于区域开放边界；本轮不修改网关/CTL/生产，国际站Bot功能仍受此限制。
用户实机报告Account request failed：定位Electron主进程白名单漏掉嵌套Bot GET/POST/PUT/DELETE，之前renderer/API替身未覆盖Main校验。
已补精确路由与payload校验，安全错误分类，并增加生产management port→实际Electron validator→fetch边界集成测试。修复包待验证/启动。
第二阶段完成：正式控制面管理端口接通，能力驱动菜单，当前Host/目录/会话删除失效及未知创建结果不重发均验证。
最终独立预览为release/bot-management-ready-20260915；管理实网写入未验收，无生产变更。
实机发现深层路由相对assets导致reload白屏，已将Vite base改为loopback origin根路径。实际静态server资源检查、8项发布测试、最终Mac进入Bots+reload全部通过；457个renderer文件匹配当前构建，签名通过。
第二阶段收尾：Bots应用入口、控制面CRUD与clone、Host/per-Bot能力、未知创建回执、迟到结果/目录刷新隔离、删除失效均实现；14项聚焦测试和真实管理控件/API替身验收通过。门禁曾发现静态UI导入泄漏SCSS到Node测试，现改为应用启动时动态加载，Host测试10项通过。完整gate复跑及最终Mac包进行中。真实云资源管理未执行。
第二阶段开始：原readonly产品限制已被用户明确替换。复用bot/create的templateId表达克隆，接入控制面blank/clone操作；未知POST结果不得自动重发。新建Bots入口和管理界面复用主题控件/Radix。
身份、readonly协商、目录/会话/执行所有权完成；最终完整gate通过，126扩展测试与受影响包类型检查通过。
实际Bridge/client/Cordis目录/Source/Resolver/Bot View在本地Hermes边界替身上通过双profile发送、切换与重连历史恢复。
Mac独立签名启动/reload正常；453个renderer文件与当前构建逐一匹配。根context仍4项既有失败，无当前Task命中。
第一阶段本地源码/产物验收完成，真实远端链路未验收；不提交推送。见design/hermes-profile-bots/task_plan.md。
