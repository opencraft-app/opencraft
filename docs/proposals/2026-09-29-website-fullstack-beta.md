# AI 建站后端：实施现状与发布门禁

初稿：2026-09-29；范围澄清：2026-10-01。当前结论：北京与韩国测试主链路已有真实验收，
最终新机镜像与真实功能闭环已验收；最新主干整合候选已在两边复验，发布配置和最终产物
签字仍在收口，**尚不能宣称整体上线 ready**。
未提交、未推送、未创建 MR、未发布生产、未执行生产 Skill 下发。

## 目标与边界

复用现有站点、控制面、域名、发布操作；首版为无状态 `fetch-v1` JavaScript API。
不支持任意 Node 服务、监听端口、安装 npm、自定义 workerd 配置、WebSocket、后台
任务、任意出网或数据库。用户需要带数据的应用时，不得用静态 localStorage 冒充后端。

远端检查曾覆盖 3099 个 heads、master cfb478aef、9 月以来 1225 个未合入源码/文档 blob。
未定位 Skip 所述 runtime，不代表其它仓库/未推送代码不存在。继续开发不再以等待该
代码为唯一前提；若找到，按相同契约评估复用。日会百分比不能当上线完成比例。

## 实现说明与不持久化含义（2026-10-01）

当前已接入的是本工作树的受控 fetch-v1 实现，尚未定位并验收 Skip 所述独立 runtime，
不得将本候选架构归属为已确认的 Skip 原方案。

Agent 通过 Skill 将静态目录与单文件 JavaScript 后端打成统一 release；CTL 控制发布，
worker 分离私有后端与静态文件并准备 runtime，成功后联合切换活动版本。静态请求沿用
原托管；`/api/*` 经 site-gateway 的所有者登录、Origin、版本和大小校验后，在每次调用
的 runsc 隔离容器中由 workerd 执行 `export default { fetch(request) }` 并返回响应。
这不是任意 Node/Express 服务，也不允许用户监听端口或后台常驻任务。

“无业务数据持久化”不意味着网站代码和发布记录不保存：平台保存代码制品与发布历史，
runtime 保存已准备的后端版本；没有给生成网站提供存订单、留言、账号等业务数据的
数据库接口。内存与临时目录不保证跨请求保留；禁用任意出网，因此不能宣称可连接外部
数据库或任意第三方 API。当前后端接口仅限网站所有者登录调用，不是公开访客写入服务。

## 已实现（候选源码）

| 层 | 实现 | 仍须注意 |
|---|---|---|
| CTL | 能力门禁、fullstack/digest、migration 000032、联合活动版本切换、带代次回滚 | 真实 MySQL 迁移与兼容已验收；最新检查 master 最大31，候选32无撞号；合入前仍重查 |
| Worker | ZIP 私有后端分离、runtime prepare/readiness、静态上传、删除/回滚、丢完成回执保留制品 | 真实 COS 发布/删站、保留窗口与超过32版本容量回收已验收；保留活跃/在途版本 |
| Gateway | owner-only API、同源写保护、最新站点状态、版本头、请求响应限制、剥离认证头 | 北京和韩国真实平台登录/OIDC/浏览器/API/负向矩阵/联合回滚已验收 |
| Runtime | 固定 digest 引擎、每调用 runsc 容器、网络禁用、资源限制、超时销毁、独立 deploy/invoke token | 双区域专用测试宿主、TLS、隔离、速率/并发/清理、manager重启已验收；生产地域绑定尚未冻结 |
| Skill | Fullstack Beta 流程、版本绑定、离线打包、回滚说明 | 真实 Hermes Skill discovery/view/packager及实例凭据发布已验收；不是额外自主LLM对话生成验收 |
| Skill 交付 | 同包版本的新镜像安装、存量 Skill-only TAT runner | 两边最终镜像正常建机/自动凭据已验收；同版TAT安装/回滚准备完成，生产下发由用户上线后执行 |

## 已有证据与不能替代的验收

独立本地 Colima profile `codex-website-runtime`，不使用/修改默认 Colima。
真实 Linux/runsc 验证了 POST 计算、metadata 出网失败、宿主环境隔离、无限循环超时
后强制销毁、后续请求恢复和无遗留容器。配置使用 `host-uds=create`，测试管理器以
root 连接容器创建的 Unix socket；生产运行方式仍须明确并预检，不能直接复制假设。

跨模块集成实际执行 CTL Logic、worker、gateway 和上述 Linux runtime，验证了：
v1 发布/调用、v2 发布、旧页面 409、新版本返回、回滚 v1、坏 JS 不影响旧版、暂停/
恢复及删除（runtime storage=0）。边界：SQLite 而非 MySQL；模拟 COS SDK 协议端点
而非真实 COS；合成 owner session 而非真实 OIDC；不是浏览器端完整用户流程。

Skill 交付验证见 [双通路交付](2026-09-29-website-skill-delivery.md)：本地默认 dry-run、
版本完整性、canary 确认、最多 100 台、断点恢复、丢回执对账、原子目录升级/回滚，
不签发或修改凭据。Linux 本地执行生成的完整内嵌命令，不等于 TAT 云端验收。

## 当前验收与剩余收口（2026-10-01）

完整证据和过程保留在 `docs/context/tasks/2026-09-29-website-backend-foundation.md` 与任务工作树
`.tmp/website-fullstack-testing/evidence-20261001/`，不是依靠本文状态表代替实测。

已关闭：

- 北京最终 `img-7ynvqc9z`、韩国最终 `img-fuk1k47z`，走正常公共新建机器、预置最终完整
  Skill和自动实例凭据；无手工补装。两边实际运行最终同版Skill发现、打包、上传和发布工具链。
- Runtime 真实 Linux/runsc、请求隔离、禁止metadata/任意出网、独立deploy/invoke鉴权、
  超时恢复、并发/速率准入、store保留、manager重启和无孤儿容器实测。
- 真实MySQL升级/备份还原演练、旧静态站兼容、发布失败/丢回执/代次竞态测试、保留GC。
  北京超过32历史版本后的回收及保留版本回滚；韩国真实暂停/恢复、删站/COS/runtime清理、
  额度释放和正常重建。不宣称可在1h保留窗口内无限突发发布。
- 最新检查master `48905e3f83137bd19a451a5c05b03b22cd34d7b8` 与任务变更在独立副本三方
  整合；不是直接晋级旧基线镜像。CTL公共配置/i18n与9个Linux可执行文件同源构建。
- 整合候选的北京v43→v41、韩国v10→v8实际联合回滚；静态/API恢复同一版本，旧页409。
  两边实际平台登录、OIDC、API sum12及8项异常/恢复检查通过。
- 同版Skill-only存量TAT安装/回滚包与测试地域Command内容一致；生产存量批量下发由用户
  上线后执行，不提前做，不重签发实例凭据。

仍待最终签字：

1. 将新增登录鉴权产物、最终容器实物核验和全服务focused门禁归入最新整合版冻结包；
   保留旧候选包作为历史，不能拿旧base包或旧测试输入当最后签字。
2. 核对新增runtime的区域HTTPS端点、CA、deploy/invoke Secret引用、生产发布消费配置与
   新机image映射的最终发布输入；测试宿主/测试token不能直接晋级生产。这里只做离线
   发布准备，不修改生产，也不新增历史告警重建/证书轮换工作流。
3. 对上述证据与固定产物逐项做最终Ready审阅；commit/push/MR/正式发布仍必须独立授权。
   源码、打包或仅Deployment Healthy不等于整体Ready，更不是生产Argo收敛。

## 发布顺序（执行前需独立授权）

冻结候选 revision、migration、引擎/管理器 digest、完整 Skill digest及地域清单。
先兼容 DB migration 和保持关闭的服务版本，再部署并独立验收 runtime；测试用户
白名单小流量验证；新机和存量 Skill 均验收后才评估扩大。任何一次安装/HTTP 200/
Argo Healthy 均不能代替完整业务验收。

失败时先关闭新建 fullstack 能力、按影响范围停止批次；站点回滚需成对切换活动
release，不单独覆盖静态文件或运行时版本。Skill 回滚使用机器保存的上一完整目录。
保留活跃版本和在途请求需要的制品，不因控制面回执不明删除可能已激活的版本。


## 测试执行授权更新

用户已授权在北京测试环境与韩国**共享**测试环境完成闭环并推进至双站可发布。
不执行生产；本条覆盖前文测试部署需再单独授权的历史描述。核心真实功能测试已完成，最终发布输入/产物签字仍未完成，不能
把授权或环境可访问当作 ready。实时执行位置与门禁见对应 Task Pack。
