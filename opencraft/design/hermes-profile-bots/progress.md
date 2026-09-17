# 进度

维护/TDD规范和Ctl/frontend最近AGENTS及must_read已核对（上一轮源码评估），当前只修改OpenCraft。先做只读能力阶段，旧预览与用户改动保持。
# 2026-09-15 实现检查点

身份/parser已RED→GREEN；managed handler、Bridge协商/协议拒绝、正式transport绑定已接通。
现有Bot View此前未注册，现补注册并抑制空应用入口；成功/回滚两条卸载路径释放Source。
聚焦81测试通过；新增6测试通过（协商、缺失降级、401不伪造、断开迟到、两profile发送/取消/恢复）。
完整gate进行中，尚未有真实Hermes实例端到端证据。未提交/推送，未改CTL或生产。
下一步：真实AppServer client+目录+Bot UI通过本地原生RPC替身验收；类型/完整gate；独立客户端。
## 最终源码检查点

冷激活收纳live execution和native profile提示歧义均以RED测试复现后修复。
实际浏览器Bridge/client/Cordis目录/resolver/source/View双profile路由与generation恢复通过；构建CSS有几何断言，浅/深主题截图已留证。
最终完整gate复跑中；最终独立签名包从最后源码重新构建，旧预览/其他用户窗口不覆盖。
根文档/映射检查通过；根context-audit33测试通过；根context26测试有4项既有失败，无当前Task新增命中。
真实账号/TAT/推理不在本次边界验收，不提交推送。
# 完成检查点

第一阶段本地实现/边界验收完成。最后源码的完整gate复跑成功，126项扩展测试通过；真实协议/组件浏览器probe通过。
最终独立ad-hoc签名Mac包严格签名验证通过；453个renderer文件匹配当前构建，真实Shell/Composer启动/reload无白屏、无空Bot应用入口。
真实Hermes账号/TAT/推理未验收；根context仍4项既有失败，当前Task无新增命中；无commit/push/生产变更。
后续真实实例验收需要用户指定和授权测试目标，不能以本地远端替身代替。
# 管理能力追加检查点

## 云端实例固定归属

用户澄清Bots页面不允许选择实例，当前Bot创建只可能属于云端Hermes。已移除实例下拉框，管理目标只解析启用的lightvela.hermes Host；Local/其他provider排除，多云端无唯一已连接owner时fail-closed。
16项Bot管理测试、Workbench类型、Web/电子端构建、131项扩展测试和真实管理UI验收通过；UI probe明确断言无combobox及无Local文本。
签名Mac预览release/cloud-bot-owner-20260915已启动并保留原登录profile；实机Bots页确认无选择器，仅云端连接状态。未提交推送。

## 自动目录加载与原因

用户要求连接对用户透明，进入页面直接呈现Bot列表；View现自动执行唯一云端Hermes Host连接+目录刷新，没有连接按钮。
首版deadline只覆盖连接，实机仍卡目录刷新；现将完整事务统一限定15秒。Transport投影阶段原因，目录阶段补“正在读取Bot列表”。
签名预览release/bot-deadline-20260915实机确认15秒后解除busy并显示最后阶段；随后收敛为单条“加载Bots超时”错误，不叠加空态。最终包待更新。

## 账号IPC实机缺口修复

完成：修复包签名验证通过，沿用原用户profile重启，登录状态保留。实测新包允许Bot GET发到服务端；返回国际站404 route_not_allowed。
只读核对service-gateway sgprod配置未列Bot路由，config_policy_test分domesticWant/baseWant；不是请求身份错误或网络失败。
桌面修复完成，国际站Bot API尚未开放，须另行授权后端/生产工作。未进行云端增删。

用户当前19844预览只读复现：已登录，GET实例目录200；GET嵌套bots被Main allowlist拒绝并被catch改成Account request failed。
补准确Bots路由、blank/clone/rename载荷校验；保留区域/目标限制，Main仅公开安全错误分类。
47项账号登录测试通过，其中生产管理端口穿过真实Electron validator再到fetch替身；Electron类型/构建及边界/文档/影响检查通过。
修复包release/bot-account-fix-20260915正在生成，将沿用用户当前profile重启并只读验证真实Bot目录，不创建或删除云资源。

最终交付：release/bot-management-ready-20260915已启动并打开Bots。严格签名验证、457文件匹配、真实进入Bots与深路由reload通过，无assets404/JS异常。
静态资源base修复后的8项发布测试及实际静态server资源probe通过；完整gate在资源base修复前已全绿，本次配置变更追加上述针对性验证。
管理API仍为本地边界替身验收，未对真实云端资源执行写入；独立预览未登录。

最终Mac深路由reload发现真实白屏：Electron base='./'导致/views/assets资源404。此前无reload的管理交互通过不覆盖此场景。
修正Vite base为服务origin根'/'，与生产loopback static server一致；需重新构建包并实机验证/views/vela.bot-management.view刷新。

最终：完整gate通过；14项管理聚焦测试、真实Radix管理控件/API替身验收通过。最终签名Mac包457个renderer文件逐一匹配当前构建。
SCSS同步导入导致Node Host测试失败已通过动态加载修复，10项Host入口测试通过；客户端已打开Bots页。
未操作真实云端Bot；根context仍4项既有失败，文档及实际变更影响检查通过；未提交推送。

用户要求已从readonly扩展到创建/克隆/删除及Bots入口。控制面mutation owner、Host/单Bot能力、真实UI管理页完成。
聚焦13测试通过；管理UI通过真实AppServer/Bridge/控制面适配器加远端API替身，确认CRUD、克隆来源ID、默认Bot保护、取消删除。
完整gate执行中；最终源/包需复核。预览沿用独立产物/profile，不覆盖用户旧窗口。不进行真实云资源创建或删除。
