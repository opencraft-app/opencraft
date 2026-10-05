---
id: checkpoint-opencraft-ssh-management-20261005
type: task
scope: Recovery checkpoint for backend SSH connection management implementation.
triggers: ["SSH checkpoint", "远程连接恢复", "management handoff"]
owner: mingyuxiao
authority: derived
source_of_truth:
  - docs/context/tasks/2026-10-05-opencraft-ssh-management.md
status: candidate
reviewed_at: 2026-10-05
review_due: 2026-11-30
revision: 1.0.0
precedence: task
derived: true
---

## stage
复验DSH与AppServer lab/Chat已通过，Workbench新增master只读面板渲染测试的fixture没有host资源，引起两例TypeError。产品Runtime的host为必有字段，不扩大optional contract掩盖fixture缺失；给真实渲染fixture补准确的method admission，并新增不支持搜索时disabled断言。聚焦两例2/2通过，正在继续完整Workbench及后续gate步骤。尚未推master/切服务。
集成检查：41615e60d合并提交已生成。i18n/边界、所有workspace类型检查、扩展221/221、连接器32/32、AppServer257/257、SSH65pass/1skip及后续项目/Thread/语音均通过；DSH四例因该隔离checkout尚未安装独立runtime依赖失败。已按锁文件prepare:dsh-runtime安装并验证0.1.1-rc.2，继续复跑DSH以及其后剩余gate步骤，不重跑已通过且源码未改变的检查。工蜂MCP只读鉴权探测报告Unknown MCP server（本地未配置），Git既有凭据已证明可推送修复分支；没有API写入。额外两次猜测frame/client单独文件不存在，改读实际src/index.ts，不扩大搜索。
交付进展：源码提交468da9350已推送fix/opencraft-ssh-native-surface-20261005；原基线完整gate退出0（含Web/Expo Web/iOS构建）。为保留其他dirty并吸收master新改动，在独立worktree集成origin/master=7698f334f。两处冲突保留最新嵌入账号preflight、预览模式enabled与本次SSH能力/目录恢复规则；正在安装该checkout自身依赖并复验。未合入远端master、未替换预览。一次全仓diff输出超出Node缓冲区（ENOBUFS），已停止全仓输出，改限定任务路径与独立worktree。
最新用户授权提交/推送/master合并后替换当前临时预览。已暂存本任务37文件（SSH目录恢复+native surface），无关dirty/ref/.kube保留；真实staged文档影响与秘密扫描通过。使用已有私有credential helper进行限定mono2 fetch成功，origin/master=7698f334f，当前基线已在master中。完整gate正在跑；须集成最新master、核验实际临时owner/独立候选实包后切换。不得把上一阶段“未授权替换”作为当前边界；生产/GitOps/永久指针仍不在范围。
实现与验证已完成，未发布/重启：真实已批准 SSH“文档”新源码恢复 live/authoritative=true；实际构建 Workbench 桌面/触屏浅深色 idle/active 两组烟测通过，包括 paginated items、刷新、Queue 偏好下按钮/Control+Enter 仅原生 Steer。SSH65pass/1skip、AppServer全套/Chat471pass、聚焦新增41/41、受影响包及protocol typecheck、边界/i18n/diff/doc通过。正式文档和SSH-09已同步，候选Web `/data/opencraft-ssh-native-surface-eWGxoW/web`。当前80端口仍旧Web/后端hash；只读检查PID已外部变化为2120682（同unit同bundle），原因未调查，不能声称PID不变。本轮源码修改授权不包含预览替换。最新具体边界/证据在Task native_surface_implementation_result。
最新“搞起来”已授权实现，不含发布/重启/Git。新增共享 native RPC admission 声明，保留上游 metadata，放行 turns/items 分页、Skills、默认配置写入；Runtime/command port/Composer 消费同一声明，不支持排队时改为可用 Steer，拒绝早于草稿收养。真实已批准远端“文档”只读新源码恢复通过（phase live、authoritative true、turns/items 请求实际穿过 SSH）；当前80端口仍旧后端。新增端到端夹具恢复/旧历史/刷新/无 queue RPC 测试通过，appserver、chat、六包 typecheck 与边界通过；实际 Web 烟测正在执行。
验证失败已修/待复验：新测试误用 Composer constructor（缺 services），已修为真实 target/services；把 Turn 错当一个 display frame 的测试断言已改为 segment identity 唯一及回答不重复。嵌套 npm 吞 --outDir，改直接 workspace build。隔离 Web 初次静态 Host 配置漏 kind，引起启动失败，需使用实际 packager 的配置并重构建；未修改产品来绕过失败。没有系统依赖安装或运行中服务修改。
最新用户追问SSH为何改变AppServer语义：扩展审计确认不止分页遗漏，原生skills/list实机支持却被桥接拒绝；共享Composer仍允许queue、读默认被误当可写，而remote阻断queue与config/batchWrite。合成initialize能力整块替换也已复现（实机未返回capabilities，不能归为实机根因）。架构差异在remote Engine facade而非SSH传输本身；连接级搜索/watch/PTY与本地附件/Goal/queue扩展仍需正确owner，不应全部开放。7/7现有路由测试通过但未覆盖这些消费能力一致性；本轮无产品/服务修改，证据audit.json/native-audit.json同诊断目录。
最新“现在是无法恢复会话”已实机只读复现并定位：目录可见、原生thread/resume成功，但remote CodexEngineAdapter未放行thread/turns/list，当前paginated历史策略因此收到-32601并进入error/authoritative=false。当前部署server.mjs亦缺该方法；不是密码/目录发现/原生resume失败。隔离真实Runtime回执在 `/data/opencraft-ssh-resume-diagnose-ZXNFfV/runtime.json`，记录逻辑请求包含turns/list但物理请求不含，固定错误为This operation is unavailable on the remote connection；没有推理/远端文件写入。尚未修改产品源码/替换/重启，不宣称已修复。
用户后续提供已解锁“正在连接/结果尚未确认”及SSH目录已出现但“文档/无法恢复此会话”截图。调查转向单会话恢复，非目录消失：后端远端adapter最近多次thread/resume均结果succeeded（PID null）且initialize成功，不能再归因目录/密码/断线。需追恢复响应后的历史与replica提升步骤。已确认前端控制请求12s小于SSH握手15s，会造成提前未确认提示，但未证明是会话恢复根因。无代码/服务修改。
最新用户替换后仍看不到SSH会话，实际入口仍未恢复/原因未闭环。本轮仅只读定位：发布版本/health/PID/NRestarts正常，配置enabled/revision3、现有SSH TCP仍ESTAB；无用户browser tab或私有目录读日志。代码存在未授权无SSH profile/无侧栏说明、目录成功默认前10混排两条待鉴别路径，不能推断用户属于哪条。已请求侧栏与SSH设置截图，不重启、不改产品。
本次用户授权的Web-only替换已完成并验证：当前80端口 `20261005-ssh-discovery-recovery`，458资源HTTP摘要/缓存、旧入口和health通过；PID1048792/NRestarts0/unit/runtime不变，无后端重启。实际发布页面桌面/触屏均验证合成管理GET失败后留在Chat自动恢复，page errors0，不触及真实授权/历史。证据与完整旧Web回退在 `/data/opencraft-ssh-discovery-recovery-PPFPWK`；用户HTTPS/手机端到端仍待验收。下方保留实施及发布准备历史。
最新用户“替换预览”已授权临时 Web-only 发布；10/10 发布工具测试通过，现网仍为 `20261005-ssh-indexed-catalog`、PID1048792/NRestarts0/runtime摘要不变。即将运行隔离目录中的发布脚本，先完整备份旧 Web，再发布并核验，失败自动回退；不重启后端、不复制账号数据、不修改永久安装/Git。
最新用户“至少这个需要修复”已授权实施源码/验证，不含发布重启。Controller新建Application启动/销毁的单一discovery生命周期，移除Settings定时器；读单飞/完成后调度/10-20-30秒退避/可见在线唤醒/授权变更暂停和取消旧读。侧栏管理读取失败独立于Host列表反馈与重试。最终SSH suite62pass/1skip、Web/builtin类型检查、边界/字体/i18n/diff检查通过。独立候选 `/data/opencraft-ssh-discovery-recovery-PPFPWK/web` / `20261005-ssh-discovery-recovery` 已构建；完整Workbench浅/深色桌面/触屏通过自动恢复、侧栏重试、online唤醒三条故障恢复路径，均不拨号、不切目标。旧发布候选同一测试未出现来源错误反馈，负例按预期失败。未更改当前80端口/发布/Git状态；这不等于已证明用户HTTPS入口的原故障根因或已完成实机验收。
用户明确否定已实现；当前交付仍未闭环。只读发现并以合成故障复现管理目录恢复 owner 缺口：启动一次refresh失败后网络恢复不重读，周期刷新仅在Settings View，SSH profile消失时sidebar没有对应反馈；6.5秒等待请求次数不变，显式refresh恢复。不能把这一缺口直接认定为用户实机根因。公共AppHost日志不含private SSH请求证据，不支持归因或盲目重启。未修改产品源码/服务。
最新用户再次报告侧栏未显示并询问后端重启：本轮只读诊断确认当前后端已接收索引参数，实际页面独立桌面/触屏展开42个SSH行、刷新可恢复；默认混排仅10行且未授权页面不查SSH。原生默认筛选42、放宽provider43、全source82。用户实际HTTPS无法由服务器回访，尚缺其侧栏截图与管理授权状态，不把单一根因冒称已定位。产品/服务没有新增修改。
用户随后授权“替换”：Web-only 发布已完成，当前 `20261005-ssh-indexed-catalog`；456HTTP资源/缓存/旧依赖校验通过，实际页面桌面/触屏分别42条、44/48ms与40/44ms，page errors=0。原后端PID1048792/NRestarts0/health正常，无后端重启或推理。回退及证据在 `/data/opencraft-ssh-indexed-catalog-m0KlGA`。下段为实施与此前发布历史。
本轮已实施索引读取和侧栏查询状态修复；新 Runtime 对批准机器只读目录42条/29ms，SSH52 pass/1 skip、邻接34/34，独立候选完整管理与Sidebar桌面/触屏浅深色通过。缓存按配置revision/认证epoch隔离。当前预览未替换或重启，保持 `20261005-ssh-catalog`。下方保留既往交付历史。
最新跟进为 SSH 会话发现缺口修复。源码已接通已认证后端 open → 逻辑 catalog reader；SSH suite 48 pass/1 skip、Web/builtin类型/边界/i18n通过。独立Web真实桌面/触屏浅深色管理目录流程、旧静态SSH选择/目录/历史恢复通过。用户随后授权替换，Web-only overlay 已发布为 `20261005-ssh-catalog`，实际 HTTP 资源和后端身份检查通过；无后端重启。
后端数据库、受保护管理 API、独立 SSH WebSocket 与设置页已实现；先前预览已部署，本轮连接/菜单跟进修复仍仅在源码和隔离候选 Web 中，未替换运行预览。
用户已授权完整 dirty 工作区临时预览，明确不固定访问地址；最新正式 headless 候选包包含动态地址 opt-in 和 Thread 加载圆环。独立切换成功，已重新连接并核验实际 owner/PID/cwd/runtime SHA/buildId/health 与真实持久管理 API；旧包保留。

## verified
基础 SSH 实机只读与真实 Workbench 合成上游验收通过。本次 AppHost + 管理 + controller 聚焦测试通过，最终 SSH suite 33 pass、1 skip；Web、插件、Daemon、AppHost 类型检查及边界/字体检查通过。真实页面已通过解锁、主机信任、添加、重载保留、菜单转弹窗、写入式密码、修改、启停、动态目标连接、重连、删除与锁定。旧静态配置入口的选择、目录、历史和刷新烟测通过。appserver、extension 全套命令通过，共享控件 18 项通过。管理 Task/Checkpoint 元数据错误为零；全仓 context 存量 4358 错误、route smoke 0 失败，不声称全仓绿灯。

## unverified
完整 gate 未跑、物理 iPhone 未实测。真实目标已加密写入私有数据库，initialize/thread/list/model/list 只读实机探测成功；真实推理未验证。服务器无法回访 join.devcloud.woa.com:443，需用户侧刷新确认。新管理页仍需访问密钥解锁，不输出密钥到聊天/日志。

## discard
不把同源、rendererId、前端登录或隐藏按钮当后端授权；不创建第二份客户端持久连接配置。不自动接受扫描到的主机密钥。

## restore
本轮误猜 packages/app-host 与 ssh-codex-engine-adapter.ts、appserver-client/session.ts/resume.ts 不存在，已按真实headless imports及rg --files改为 packages/app-host-server、ssh-codex-connections/CodexEngineAdapter，并定位独立appserver-session包；不继续猜路径。
发布后附加页面验收第一次阻断所有 WebSocket，错误地阻止应用初始化；改为仅允许 initialize/list/read/get/status/capabilities。第二次在 touch 隐藏侧栏等待可见项，第三次等待 attached 仍因未挂载侧栏失败（桌面恢复通过、touch 读次数2/页面错误0）；改为等实际 Show sidebar 按钮挂载后打开侧栏再断言。不修改产品或放宽恢复断言。
本轮猜测构建脚本路径不存在3次，改为读取package.json定位实际package-headless-linux.mjs；浏览器先后缺libgbm/libwayland，找到两处既有隔离libs并用显式LD_LIBRARY_PATH补齐，不安装系统依赖。bounded目录枚举一次输出过多，改为仅过滤相关文件名，不读取用户临时文件内容。
保留广泛 dirty worktree；本任务仅修改相关边界。隔离构建 /data/opencraft-ssh-management-ui-wMFF9v/web。错误路径猜测后改为有界文件发现；初次 DB 测试失败为夹具权限 0644，已修为 0600。页面管理缺失原因是浏览器 fetch 被错误绑定，已修且完整管理复验通过。不存在的 Back to app 按钮改用实际路由导航。一次 npx 缺失已补任务 PATH；一次无内容 patch hunk 被拒绝，改为有效 patch。旧入口 3 轮停在初始 target=Codex；检查定位为夹具虚构 draftId，但当前用户导航改动明确拒绝未保留 Draft（workbench-location-restoration.test）；已改用真实选择器，不篡改导航。API absence 增加明确 JSON 404；初次其测试失败为 fetch 缺 HTML Accept，已按真实页面修正夹具，不改产品。

## next_action
本轮可交接源码修复和验证结果。用户要求替换时再读自托管Skill，构建新后端与Web一致候选、实包验收，再独立切换/失败回退并核对实际owner；当前后台未含本轮修复，不能请用户仅刷新当作已交付。下方为先前阶段历史。
完成实际 Workbench 分页与跟进能力桌面/触屏验收，更新正式 SSH/架构文档与不变量，交接源码/隔离 Web 产物/旧运行后端分别说明。用户另授权替换时，必须同时更新后端和 Web；不能仅换 Web 声称恢复修复已上线。
针对已确认的历史读取放行缺口修复remote adapter，并补真实paginated history恢复的跨层回归（旧夹具无historyMode/cursor，只测thread/read，不能证明当前服务器兼容）。如用户授权实施再修改产品；后端发布/重启单独获授权并按自托管Skill执行，单换Web不能修此缺口。更旧的侧栏待截图阶段已被最新截图与协议证据取代。
当前优先获取用户实际侧栏及SSH连接设置状态，区分授权/来源发现/读取反馈/更多折叠；若收到截图据其真实链路推进。不能继续宣布“已解决”，不要重复独立浏览器成功或重启充当用户验收。下方为此前发布记录。
已发布并完成本轮验证；请用户刷新当前预览确认SSH会话目录。若仍不显示，沿实际用户入口授权状态/侧栏投影继续只读定位，不以又一次重启替代证据。无Git提交推送；旧Web保留可回退。下方为此前步骤历史。
执行 `/data/opencraft-ssh-discovery-recovery-PPFPWK/publish.mjs`，通过实际 HTTP 摘要/缓存/health/进程不变核验后报告。此前“未授权发布”仅是历史状态；本次用户已授权 Web-only 替换，不含后端重启。
当前恢复生命周期修复已实施并完成独立候选验证，未发布。用户若授权替换，先复核实际运行owner/版本与候选差异，保留旧Web回退，再按维护发布流程执行；不自行重启或发布。仍需实际用户入口证据才能宣称解决本次问题；不重复用独立浏览器成功作为用户交付结论。下方为既往阶段记录。
等待用户当前侧栏（含更多入口）截图和SSH设置状态以区分未授权、未进前10、默认source/provider筛选或实际入口版本差异；不以重启代替诊断。证据 `/data/opencraft-ssh-sidebar-diagnose-qcHwCk/visibility.json`，只读统计与模拟触屏不是用户实机验收。
已交付本轮临时预览替换。让用户刷新并确认实际SSH会话列表；物理手机/公网HTTPS仍由用户侧验收，不继续扩大改动。没有Git提交推送；旧Web保留可回退。下段“如用户授权替换”属于已完成的历史状态。
当前实现可交付，独立候选 `/data/opencraft-ssh-indexed-catalog-m0KlGA/web` / `20261005-ssh-indexed-catalog`；如用户授权替换，使用正式Web发布流程复核当前owner/旧包并保留回退，本轮不自行发布。
用户随后授权“好的 搞起来”：实施原生索引读取与侧栏状态修复。当前开发基线由其他工作更新为 `fix/remaining-worktree-20261005` / `1a53b96c36571a1094c45ef2cd84266468172370`；保存已有任务文档与无关未跟踪文件。本轮不替换或重启预览、不提交推送。下段为此前只读诊断历史，不再是当前禁止实施决策。
用户反馈实际不显示，并明确先定位；保持只读，不修复/发布/重启。真实80端口独立浏览器已观察open、initialize正常、两条目录读取约19秒返回40个，20秒前侧栏没有远端行，展开更多40条可见。原生默认请求两次超过20秒；同参数索引读取17–20ms返回41个。确定慢目录请求与等待/错误空投影缺口，但用户当前Client是否鉴权、收到响应、超时或被默认10条折叠隐藏尚未闭环，已询问连接设置状态/截图。运行仍为 `20261005-ssh-catalog` / PID1048792 / `opencraft-ssh-connect-menu-20261005-preview.service`、NRestarts0。Web回退位于 `/data/opencraft-ssh-catalog-JiRUrn/previous-web`；密码、访问密钥不得输出，不主动Git或永久指针修改。

## followup_connection_menu
- 用户报告持续待连接与菜单图标/文字错位，要求复用成熟菜单控件。本轮修复，不自动重启/Git 发布。
- Router query `OpenCraft SSH management waiting connection menu icon shared controls lifecycle` 无匹配；已读取维护 Skill/verification、平台架构和 SSH 专题，检查 frontend-runtime-openspec-i18n 邻接及独立 Web smoke 邻居。
- 根因边界：DB enabled 是可用配置，lazy AppHost 未实际启动；reconnect HTTP 只 resetHost，没有 connect admission。菜单用内部 data-radix 属性排列，而未消费 design-system/menu.web 的 item。不能以假状态或新增另一份 SSH transport 修补。
- 已实现：AppHost 的可信服务级连接 admission（共享同一物理 slot、reset barrier，无逻辑 Client/Thread/执行权限）；管理 API 接通显式连接与真正重连；idle 显示未连接。Radix 仍管行为，DS 既有 surface/item 管呈现。物理准入前再核对鉴权/CAS，等待关闭屏障时失效的请求不启动通道。
- 检索失败路径：view.scss、app-host-server.test.ts、agent-runtime-directory.ts、server-managed-profile-store.ts、application-supervisor.ts 等猜测不存在；改为限定 rg --files，实际位置为 Web styles、tests/app-host.test.ts、agent-runtime/directory.ts 与 Web runtime/server-managed-profile-store.ts。
- 追加失败记录：Checkpoint 在根 docs/context/tasks 而非 opencraft/docs/context/tasks；design-system 无 src/index.ts，样式名实际为 codex-accounts.scss；smoke-settings-controls.ts/themes.scss 不存在，改用已发现的 smoke-account-controls.ts/appearance-theme.ts。嵌套 npm release 命令吞掉 --outDir，被 Vite 当根目录；改为直接 workspace build，standard release env 与 headless 静态配置不变。一次多文件 patch 的参数名不匹配，被工具整体拒绝；读实际 serverId 参数后重做，无局部残留。
- 负例：旧候选真实菜单计算 display:block，几何断言失败。新产物首轮14px断言测到13.85px，是菜单入场 scale 动画未结束；验收等待现有动画完成再测实际几何，不改产品动画、不放宽对齐目标。
- 最终验证：39/39 AppHost/管理/controller，Headless28/28，SSH34pass/1skip；Web/AppHost/Daemon/builtin-agents 类型检查，i18n、边界/字体与 diff check 通过。真实完整页面桌面/触屏、浅色/深色及键盘交互、显式连接/真正重连 smoke 通过，截图已人工查看。远端 exec 为合成边界，不冒称实机/付费推理。
- 候选 Web `/data/opencraft-ssh-connect-menu-FESsEj/web` / buildId `20261005-ssh-connect-menu`。未替换80端口、未重启当前预览、未提交或推送；用户若要求替换再按独立候选与切换纪律进行。`--staged` impact通过但无暂存文件，不冒称覆盖本轮未暂存 diff。

## connection_menu_cutover_authorized
- 最新用户“替换”明确授权当前临时预览切换；不包含 Git/生产/永久安装。已重读维护、自托管切换 Skill、验证清单、构建矩阵、实际 package/smoke 脚本和邻接卡。
- Router query `OpenCraft SSH connection menu fix replace current temporary headless preview` 未匹配；在已知 package/headless/当前候选路径做有界检查。保留旧包与数据，由独立 supervisor 切换，失败回退。
- 当前80端口实际仍为 PID576109 / opencraft-ssh-flex-20261005-preview.service，cwd及runtime SHA与既有记录一致。发现 Web 已独立更新为 `20261005-navigation-ownership-l5qv5Y`，不可沿用旧 thread-ring 标识断言；已核对导航 Task 的独立 overlay记录，当前SSH候选Web构建时间更晚，并保留同一工作区既有导航能力。
- 候选采用保留旧 runtime依赖与Node/Codex/DSH的独立复制，替换为已验收 Web 并按仓库 buildHeadlessBundle 重新构建入口；核对旧/新bundle差异，仅接受本轮AppHost/SSH管理/入口变化。更新manifest后执行正式包级smoke，再准备独立切换脚本。当前尚未切换。
- 候选 runtime SHA `96b6fc0042b4d348fe42e298253185d5703e4021e84c94c25923d75dc1f00347`；新旧bundle diff仅AppHost/SSH管理/入口三块。真实最终包Web桌面/触屏public-access smoke已通过。旧hash资源按既有publisher规则保留，以支持旧tab延迟加载。
- 验收失败记录：在复制过程中提前diff新bundle尚不存在；等待构建完成后通过差异核验。临时组装脚本误将assets视作平铺目录，实际含public skills目录，已按publisher的hash规则递归保留；不存在的publish-web-static.mjs已改为实际publish-workbench-web.mjs。保留assets后重建manifest时误包含旧manifest自身hash，正式包smoke拒绝；改为与仓库packager一致排除manifest自身，重新封装验证，不修改产品代码或绕过校验。
- 最终正式包 smoke 通过：manifest全量核对、全新隔离数据根实际DSH/Codex初始化、目录与项目能力通过，无推理。归档 SHA `a6cc8665084f668a5fd85510dcd9e29568304718328d81551752c77aafed15c3`。切换脚本 `/data/opencraft-ssh-connect-menu-FESsEj/switch-preview.sh` 语法检查通过，核验旧PID/实际端口/当前Web标识/新旧runtime后才停止；失败恢复保留旧unit。新unit预定 `opencraft-ssh-connect-menu-20261005-preview.service`，使用原数据根和同样公开SSH认证模式，不改 `/opt/current`。
- 下一步：将脚本交独立 `opencraft-ssh-connect-menu-cutover-20261005.service`，提交返回后切换。重新连接后核验实际PID/cgroup/cwd/runtime/buildId/health与已批准SSH目标显式连接；未核验前不能声称升级完成。

## connection_menu_cutover_result
- 独立cutover已退出0、Result=success，未触发回退。重连后再次核验80端口PID1048792 / `opencraft-ssh-connect-menu-20261005-preview.service`，active、NRestarts0；cgroup/cwd/runtime SHA与候选一致，Web buildId `20261005-ssh-connect-menu`，health ok。
- 实际运行包管理API复验：匿名连接列表401，保存目标与启用配置保留，显式Connect返回200，后端物理状态open；用户批准的 `9.134.163.40:36000` 已实际建立SSH连接。没有真实推理或远端文件写入，不输出密码/访问密钥/Cookie。
- 旧包及旧unit保留，原数据根沿用；不修改永久安装指针、不提交/推送。当前用户应刷新预览验收菜单和已连接状态。公网HTTPS/物理iPhone本轮未单独验证，不能将本机80端口核验冒充手机端到端回执。当前任务交付完成。

## remote_catalog_followup
- 用户授权替换后，已Web-only发布 `20261005-ssh-catalog`；实际HTTP456资源、缓存策略、旧入口保留、后端身份/health均通过。发布后桌面/触屏模拟设置刷新→Chat→Back/Forward无page errors；隔离浏览器禁用WS和写请求。Web完整回退备份 `previous-web` 和生成证据 `publication.json` 均在 `/data/opencraft-ssh-catalog-JiRUrn`。此交付记录更新下方历史“未替换”状态，不包含公网/实机验收。
- 用户明确是 SSH 服务器上的会话不显示，授权继续并参考 /codex；参照最新 26.930.31428 的 host 分离/连接 gating，不把 service Connect 冒称前端 ready。
- Application 现有管理 source 作为读准入事实，Query 通过唯一 registry 获取逻辑读连接；autoConnect 仍 false，不切目标、不建/激活 Thread。读取前、连接后、回复前验证 profile revision/启用/存在/认证代次；旧会话期间的回复不能跨 logout/unlock 发布。
- 新测试19/19，受影响 Web/builtin 类型检查通过。隔离构建 `/data/opencraft-ssh-catalog-JiRUrn/web`，未替换运行包。
- 新失败记录：host-connections/contract.ts、host-runtime-registry.test.ts 猜测路径不存在，已改为实际单文件 host-connections.ts 与 chat-host-runtime-registry.test.ts；首次构建缺 VITE_APPSERVER_HOSTS_JSON，入口按规定拒绝，已使用正式 headless Host 配置重跑。
- 后续验证：旧编译包负例必须在 Connect 后无会话目录；新包桌面/触屏验证无需目标选择即可展示、重载恢复、锁定撤销。不做真实推理或远端写入。
- 已验证旧包负例（30秒无远端thread/list）与新包读准入、跨代次拒绝；应用Query仍消费唯一Registry/源投影，没有新catalog owner或autoConnect状态副本。SSH注销不影响本机读取；删除/停用/revision替换/新授权排除旧回复。
- 已完成真实Workbench桌面/触屏、浅深色/public-access、Connect后无需选目标即读取/显示、刷新恢复/锁定撤销；旧静态配置完整UI烟测也通过。仅SSH exec合成边界，没有推理、远端写入或真实手机验收。
- 验收修正记录：设置页没有任务sidebar DOM，必须先观察native读请求再用实际App导航回聊天；默认折叠/触屏先Show sidebar再Applications/Chat，而非猜测dock选择器。文档patch错误上下文被整体拒绝并修正。两次工作区UI类型检查/边界/i18n和最终SSH门禁通过；源码修改后重新构建最终Web并复验。
- 当前预览仍为旧buildId `20261005-ssh-connect-menu`，PID1048792、active、NRestarts0；本轮候选Web为 `/data/opencraft-ssh-catalog-JiRUrn/web` / `20261005-ssh-catalog`，未替换/重启/提交/推送。用户下一步若要求替换可仅发布经过验证的Web，不必重启或改动后端。
- 最终构建后浅/深色public-access完整管理UI再次通过；截图已人工查看，真实侧栏包含远端history而当前目标仍为Codex。documentation validator全仓0错误；context validator现有4439错误，其中这两个任务文件6条为既有产物SHA256长十六进制误报（人工核对为归档/runtime摘要，非凭据），不称context全仓绿灯。staged impact通过但暂存集合为空，正式SSH/架构/不变量已手动同步。
