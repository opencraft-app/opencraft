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
保留广泛 dirty worktree；本任务仅修改相关边界。隔离构建 /data/opencraft-ssh-management-ui-wMFF9v/web。错误路径猜测后改为有界文件发现；初次 DB 测试失败为夹具权限 0644，已修为 0600。页面管理缺失原因是浏览器 fetch 被错误绑定，已修且完整管理复验通过。不存在的 Back to app 按钮改用实际路由导航。一次 npx 缺失已补任务 PATH；一次无内容 patch hunk 被拒绝，改为有效 patch。旧入口 3 轮停在初始 target=Codex；检查定位为夹具虚构 draftId，但当前用户导航改动明确拒绝未保留 Draft（workbench-location-restoration.test）；已改用真实选择器，不篡改导航。API absence 增加明确 JSON 404；初次其测试失败为 fetch 缺 HTML Accept，已按真实页面修正夹具，不改产品。

## next_action
已发布 SSH目录修复Web `/data/opencraft-ssh-catalog-JiRUrn/web`，buildId `20261005-ssh-catalog`；运行仍为 PID1048792 / `opencraft-ssh-connect-menu-20261005-preview.service`，NRestarts0。用户刷新后检查远端会话目录；本轮无后端重启。实际替换前版本为消息排序 overlay `20261005-timeline-overlay-VOAeGc`，完整备份位于 `/data/opencraft-ssh-catalog-JiRUrn/previous-web`，原有排序 planner 摘要一致。密码、访问密钥不得输出到日志、回复、源码或浏览器存储；不主动Git提交/生产发布，不改永久安装指针。

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
