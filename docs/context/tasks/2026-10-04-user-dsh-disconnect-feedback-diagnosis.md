# 用户DSH断连与反馈提交失败诊断

## goal
只读定位usr_6c706b83dbd17c2f76314218的DSH频繁断连和反馈提交失败，区分同一链路故障与独立问题。

## non_goals
- 不修改生产、账号、实例、登录态或网络配置，不重启、不修复、不创建反馈。
- 不复用本会话其他用户的处理权限，不输出凭据、签名链接、原始用户消息或敏感日志。

## requirement_excerpt
- 用户确认断连/反馈失败发生于今天；追加要求核对最新DSH修复按钮的数据边界，并验证用户给出的TAT上游WS异常分析，不执行修复。
- 23:19用户称已点击修复但问题依旧，并给出23:07–23:13疑似channel泄漏/15秒generation-ready超时的分析；继续只读核验，不因用户点击修复而推断获准再执行生产操作。
- 10-05追加：只能拿到用户ID，不再把浏览器复现或额外截图作为继续诊断前提；直接核对代码、历史生产日志及VM当前状态，不执行新的修复。

## context_receipt
- 已读根AGENTS、frontend/AGENTS、ctl/AGENTS、user/auth/AGENTS。
- 路由原始精确user ID/DSH/feedback无pack匹配，已在frontend/ctl/opencraft相关目录做有界搜索；扩展服务符号路由命中agent-gateway-runtime、identity-access、upstream-subtrees、control-plane-ops，全部must_read已读。
- 已补读site-environment-routing、Task模板及argocd-ci-secrets邻接；核对Auth上海kustomization与反馈客户端/API base及相邻auth-api-base.test入口。

## interface_refs
- origin/master:frontend/src/lib/support-feedback-cos-client.ts：生产新版multipart POST /support/feedback/submit、浏览器30秒超时；当前工作分支旧COS实现不作为生产解释。
- frontend/src/lib/auth-api-base.ts：提交主站API与反馈后台list/sign分别路由。
- origin/master:frontend/src/lib/deepseek-harness-command.ts：修复会隔离profiles/web，仅复制cordis.patch.yml与空package.json，失败尝试恢复、成功删除旧目录。
- origin/master:frontend/src/pages/marketing/agent-deepseek-harness-repair-dialog.tsx：明确自装插件及相关自定义文件会移除。
- 实际COS install-deepseek-harness.sh：运行时安装、候选验证、切换、失败回滚与成功清理；只读获取，未执行。

## evidence
- 两生产集群可只读访问；账号所在环境待核验。
- 反馈客户端包括预签名、附件PUT、记录PUT三个独立失败点，不能直接归因为DSH的WebSocket断连。
- 注意上述为当前工作分支的旧源码，production日志及origin/master已证明反馈新版使用POST /support/feedback/submit与MySQL，旧COS实现不作为现网结论。
- 账号只在shprod Admin查询命中，sgprod未命中；上海Bot ins-7e957c8934de42179dc203b4fe89041b为Running，Sandbox a52ffd6b-eda5-413b-ab56-b1f6c00e3221；Pass pass-rfoey5cu/bundle_launch_ai_01 active，2026-10-28到期。
- 用户确认问题是今天。日志限定2026-10-04北京时间（UTC10-03 16:00起）。登录/套餐/实例查询200，20:55:11和21:09:21 debug/exec出现500；约20:56-21:14多次internal TAT session创建200。当前service-gateway日志没有该用户的feedback请求，尚不能认定反馈失败的具体环节。
- 21:27通过CTL/TAT执行只读systemctl/端口/资源诊断：DSH自10-03 23:45:10 CST运行、NRestarts=0、版本0.2.0-rc.2；TAT Agent 1.2.2亦无重启。内存available约2.8GB、磁盘59%，今天未见kernel OOM。
- DSH本机3080正常监听，但未认证GET /返回401；master状态检查与实际COS安装器健康检查均curl --fail /，会将鉴权拒绝归入不健康，不能据此建议重装。
- 该用户.dsh/sessions有47个文件、41,022,229字节；位于Web插件目录之外，当前修复脚本不删除此目录。profiles/web有26个非node_modules文件；不承诺这些自定义文件全部保留。
- TAT实际日志关联Proxy start/timeout及目标127.0.0.1:3080，发现21:07:19、21:09:26、21:11:32、21:12:36四次代理生命周期300.013～300.014秒，21:18:55一次306.589秒。证明5分钟代理超时独立存在，不能只看site-gateway的1h SessionAuth MaxIdleTime或20m HTTP超时。
- 腾讯官方Tencent/tat-agent master源码proxy.rs：PROXY_TTL=5min，Proxy循环超时主动退出；session.rs get_channel刷新channel timer；代理输出读取不刷新timer。与实际日志行号/时长相符，但未找到与部署1.2.2完全一致的tag，因此源码机制解释标注为推断，日志超时本身为确认事实。
- 读该VM两份现有轮转TAT日志，按src/network/ws.rs:317去重：10-04有3次上游WS异常（00:48:36、01:47:01、04:15:51 CST），10-03当前保留日志有7次。相同错误在ws.rs:232又打印一次，今日6条匹配不等于6次断开。今日晚间未见该类WS断开，不能解释全部晚间5分钟proxy timeout。
- 官方ws.rs表示previous connection is dead/reconnecting是下一次ConnectForward事件触发重连，不是自动持续高频重连的证据。WebSocket无关闭握手异常不能单独证明TCP RST或判定发起者；proxy.rs读写reset/broken pipe对应VM到本地3080的socket，不能直接当成上游WS同因。
- Feedback数据库无该账号记录；Ticket今日5次submit均为其他请求，未找到该用户提交的服务端证据。RUM项目154516已定位，但公开API查询格式/TSM返回422导致无法获取该账号浏览器事件，未以失败的查询结果认定无事件。
- 23:20最新只读核查：修复任务dshi-13e850aa1369b29a3b08dd81b76bd881在22:59:23 CST succeeded；运行时切到0.2.0-rc.2-871f7bc1ada6-13e850aa，DSH从22:59:13运行、NRestarts=0，本机首页现在200。此前401探针问题不是修复后现态。sessions现在51文件/41,326,760字节，Web profile非依赖文件由26变9，未找到留存修复备份。
- TAT新日志新增21:55:03 ws.rs:317异常，上游重连22:13:18；23:07–23:13没有该类异常。不能把早前的3次统计套到整天末尾。
- 对同一23:07:00–23:13:00窗口，以proxy_new中的Session:Channel ID与所有关闭路径（Proxy closed/stopped/timeout/send-total、remove_channel）关联：318独立3080 channel，317在窗口内结束、1随后结束。截至23:25:34，318全部有remove_channel，无未回收channel。311的首个终止事件为Proxy closed，7首个记录为remove_channel。用户“301泄漏”统计漏了关闭路径；累计创建数255不等于并发驻留255。
- 用户新建频率观测可复核：23:01为72/min，23:07～23:12分别64/46/47/48/59/54；新建数量不能直接等同/api/remote.mux物理WS重连，因为同时承载HTTP RPC/静态请求。
- 直接读取VM当前release编译源码：dsh-client-connection/lib/client.js默认generationReadyTimeoutMs=15000，超时catch abort，存在候选机制；尚无该用户浏览器的not-ready日志证明实际触发。Backoff是带jitter的cap/2～cap，而非精确固定0.5s×2。
- dsh-api-gateway/lib/client.js证实/api/remote.mux确为一个共享WebSocket，多个逻辑stream复用；初始ready是$events首帧，而不是直接等到所有业务快照都传完。不能把大快照与ready超时因果视为已证实。
- dsh-api-gateway/lib/index.js实际默认websocketHeartbeatIntervalMs=2000，MAX_MISSED_HEARTBEATS=2，后续tick发现两次未收到pong即terminate；理论无pong连接寿命约4～6秒。当前cordis.patch.yml没有上述三项timing覆盖。
- VM Node v22.22.2默认HTTP keepAliveTimeout=5000、keepAliveTimeoutBuffer=1000，普通HTTP空闲连接也约6秒关闭。许多TAT channel寿命6秒不能区分HTTP正常回收和WS heartbeat丢失。
- 23:30前后对loopback:3080进行25秒仅在内存的被动诊断，过滤输出请求路由、HTTP状态、Ping/Pong计数与FIN/RST/寿命，不写pcap、不输出请求体/凭据。该窗口无流量，不能凭空认定WS关闭原因；已请求用户打开DSH复现并提供connection Console错误。
- 10-05 00:54及01:12重新查询实际VM：DSH active/running、NRestarts=0、PID2438567；00:51:30发生一次正常Stopping/Stopped/Started，未见崩溃或自动重启证据，未确定操作者。运行release仍为昨晚修复后的0.2.0-rc.2-871f7bc1ada6-13e850aa，本机首页200。此重启不是本轮操作。
- 按上海页面实际默认envd后端执行master的只读providers命令，成功返回5个provider的布尔配置状态；测试旧版helper确定失败为HTTP401并返回DEBUG_EXEC_FAILED/exit1。旧版失败为本轮受控诊断，不混入用户故障统计。
- 直接读取线上/agents/labs/deepseek-harness当前release的静态JS，提取内嵌provider helper，仅输出SHA256/字节数/版本比较；13418字节、SHA256 f235c5acd4e48f4a6f87e093cbdae8e84b25c1b46008ac6f9f96fd5accda08c0，与master helper完全一致、包含现代RPC兼容。不能归因为当前生产页面漏发该修复，亦不能据此断言用户旧tab已经加载新包。
- CLS历史补查该UID：用户debug/exec的5次500分别20:55:12、21:09:21、22:21:16、22:44:15、22:56:24（10-04 CST），均早于22:59修复完成；查询的另外两次10-05 00:59/01:03的500是本轮旧helper只读对照测试。访问日志只保留状态/路径/trace，不能推定历史500均来自旧helper。
- CLS共享网关主题查询UID AND feedback未命中；RUM查询仍因TSM 422失败，不把它解释为浏览器没有事件或反馈没有发起。
- 10-05 01:12左右读当前cordis.patch.yml的纯数字timing字段：generationReadyTimeoutMs=60000、generationReadyWarnMs=20000、websocketHeartbeatIntervalMs=10000，patch mtime为00:50:11 CST。与前一晚未覆盖的状态不同；此配置不是本轮写入。不能继续套用15秒/2秒默认值描述当前运行态。
- 创建一次临时只读TAT代理诊断（授权限于该UID/该Bot，内部CTL查询仍检查归属；令牌/native cookie仅内存）：Bootstrap核对真实CVM ins-avrwrz0t/ap-shanghai，首页200约1085ms，HTML bootstrap明示ready超时60000/warn20000；/api/remote.mux升级101约117ms，只读$events首个item/value.ready约153ms，立即cancel并关闭诊断连接。未执行会话、模型或配置写入。
- 另一次同机TAT载体观察40秒：升级101，4次Ping及4次Pong正常，未收到远端关闭，由诊断计时器主动结束。这个测试覆盖VM和Tencent TAT隧道及本地同源握手，不覆盖用户浏览器、生产site-gateway/CLB及真实大快照负载，不能将通过当作用户已恢复。
- 最新sessions元数据51文件/42,210,509字节，仍在独立目录；不存在留存repair backup。证明目录及文件保留，不证明用户自装插件/所有Web profile数据无损，也不输出或读取用户会话内容。
- 确认现有site-gateway DSH代理观测缺口：升级后的ReverseProxy.ErrorLog指向io.Discard；握手前ErrorHandler只记status/error_type，无Bot、路由或具体原因。仅已有日志无法给该用户的快速重连闭合到ready超时、丢Pong或backpressure的唯一触发原因。

## checkpoint
- stage: 仅凭ID完成修复前后时间线、当前生产helper、VM实际配置及主动只读TAT carrier/ready握手核对；不再依赖用户补充浏览器信息。
- verified: 修复成功、sessions仍在；23:07–23:13全部318 channel已移除。00:50配置改为60秒ready/10秒heartbeat，00:51正常重启，实际bootstrap和Ping周期验证生效；TAT ready只读探针153ms、40秒载体正常。
- unverified: 用户当前页面是否仍重复失败、真实浏览器/生产site-gateway/CLB/快照负载下的断开触发点；未采集到新的真实故障，不能宣称已恢复。历史5次500的命令结果未留存；上游异常来源与反馈失败仍未闭环。
- discard: 旧COS上传链不再解释此次生产反馈；ctl/pkg/logic/instance、sandbox/cmd/ingressproxy、cloudagent/internal等猜测路径无效，后续先rg --files定位实际路径。
- restore: 生产只读诊断；明确usr/Bot/Sandbox ID；没有变更账号或服务。
- next_action: 不再重装或重复调15→60（当前已经60）；若继续实施，应先在托管代理的握手与升级后终止路径补齐脱敏Bot/路径/原因/时长及容量事件，并关联实际mux故障。新增日志/部署或单用户生产配置改动需另获授权。仅缺用户浏览器资料不是停止其他只读检查的理由。

## risks
- 原始日志可能有临时令牌/签名URL；查询输出限定账号ID、时间、路径、状态码、非敏感error code与request ID。

## validation
- 无服务源码改动，使用实际production读操作和代码调用链交叉验证。

## handoff
- 未执行修复/重装/重启/生产配置或用户数据变更。关闭本任务创建的Auth/CTL/DB端口转发与内存DB桥；本地Task Pack和脱敏诊断helper保留。
- 本轮重新建立的CTL转发session21038在交接前关闭；被动诊断进程25秒自动结束，无捕获文件或生产遗留对象。
- 10-05本轮75601转发已退出；重建21159用于后续只读探针，交接前关闭。Go临时诊断本地运行，其TAT manager、HTTP及WS连接均defer关闭；没有生产Pod或持久诊断文件。
