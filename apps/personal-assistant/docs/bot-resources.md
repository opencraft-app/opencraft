# Bot 资源、目录与运行所有权

本轮实现以独立管家 lab `8a2dc8d` 为基线，增加显式 `bot-v1` 布局和受信任 Host 接入端口。未上线，不迁移已有 profile，不改变现有个人助理的模型配置。平台群聊搜索与重启交接修复在独立 Core 工作树 `unified-native-channels` 中。

## 身份与职责

Bot 是可分配给 Human 或项目的稳定资源。持久绑定包含 `serverId + botId + assignmentId + owner(kind,id)`；名称、一次执行、Codex 线程和浏览器会话都不是它的身份。当前只允许个人助理申领和 provisioning，拒绝项目类型；只开放 Bot 自身私有记忆。

平台拥有资源注册、分配和授权。`provisionBotProfile` 只接受平台已经确认的绑定，校验并落本机目录；它不能认证用户、签发令牌或根据目录名创造权限。绑定同时写入 profile 和原有 Assistant identity，重开时严格比对。改变 owner、Server 或 assignment 必须另做显式迁移流程，本轮没有实现转让。

Bot 内可以运行多个 Work / Execution，不再套一层独立 `agents/<id>`。Work、Execution、Conversation、Outcome 和消息回执继续使用已有 owner；没有新造一份通用 Agent 调度账本。

## 实际布局

```text
<server-data>/bots/<botId>/
  profile.json                  # 不可静默改绑的身份和本地配置
  assistant.sqlite              # 工作、目标、执行绑定、幂等记录等业务状态
  memory/
    .owner.json
    .identity.json
    profile.md                  # Markdown 事实
    log/*.md
    .dreaming/                  # 提炼、遗忘等现有文件元数据
  engines/
    codex/<session-root-digest>/ # 原生会话，跨多次 Execution 保留
    pi/<workId>.sqlite          # 若显式配置 Pi，仍沿用其原生持久机制
  executions/<executionId>/     # 临时工作区路径；不包含引擎持久根
  artifacts/                    # 已交付产物
  attachments/                  # 消息附件
  mailbox/                      # 独立 lab 的旧结果渠道
  outgoing/                     # 独立 lab 的 local:main 消息渠道
  credentials/                  # 本地 Vault；不进入模型输入
  telemetry/                    # 本地有界 OTel 输出
  tmp/
  .transactions/                # 文件/SQLite 提交恢复日志
  .write-lock                   # 同步文件事务锁
  runner.sock                   # 本机控制入口
```

目录按实际使用创建；`executionWorkspace()` 定义临时路径，本轮没有新增自动垃圾回收器。Codex session-root 来自已有 ExecutionLedger；同要求续接复用原根，不能按最近一次 executionId 重建。旧 profile 没有 `layout: "bot-v1"` 时继续使用旧 `memory-space` 和 `executions/codex` 路径，不做隐式搬家。

`assistant.sqlite` 虽然也包含可重建的记忆索引，但**整库不是缓存**。不能为重建 BM25/搜索索引而删除工作、目标、执行绑定或幂等记录。备份需停止写入并一起保存业务库、Markdown、引擎状态和对应产物；不能只复制活跃 SQLite 主文件而漏掉 WAL。凭据另走受保护的备份策略。

单次执行结束不删除 `engines/`。临时工作区将来只允许由 Execution owner 确认无活跃引用后清理。删除 Bot、引擎压缩/归档、跨 Server 迁移均须独立流程，本轮不默认开启。

## 单写入者和异步边界

LocalRunner 先拿既有 profile 进程锁，再在 SQLite `meta` 内取得随机 writer token。每次 UoW 开始、调度、工具动作和消息交付前检查 token；新 owner 接管后，旧进程不能继续提交 Markdown/SQLite 或发起新的交付。

bot-v1 的 LocalRunner 必须由 Host 注入授权端口，缺少时拒绝启动，不能静默降级为无授权独立运行。普通独立 CLI profile 保持原来的本地模式。接入平台端口时，BotAuthority 维护可过期的授权租约。租约由 Host 返回，不从聊天或模型输入读取。刷新在事务外完成；过期/刷新失败时暂停后续操作，同 epoch 续租可以恢复；epoch 变化永久退休当前 runner。刷新共用在途请求，有 5 秒截止，关闭会取消等待，即使 provider 不响应取消也不阻塞关闭。

这里的租约不是平台权限缓存的替代品：原生请求仍由平台在实际读写时校验 Actor、成员和凭据。已发出的网络操作不能靠本地 token 撤回；结果未知时保留原请求 ID 对账，不改 ID 重发，也不假称从未发生。任意本机同 UID 恶意代码不属于这些文件边界的隔离保证。

## 群聊和会话读取

共享平台契约为 `opencraft/personal-assistant/*`；认证主体始终是 Bot，
平台按申领 Human 当前权限代理读取，不要求 Bot 入群。`PlatformChannels`
保留已有本机 channels.list/history/search 调用入口，映射新的 delegated read
协议；channels.send 明确拒绝，不能继承用户写权限。

模型可以通过原有 Reception 查询回合使用：

- platform.groups.list / history / search
- platform.conversations.list / history

无平台端口时不向模型声明这些能力。查询沿用原单轮次数、字节预算、截止
时间和 trace，返回标为 externalContext；不直接修改记忆或已读位置。
MemoryService 仍是后续学习的唯一写入者，不能把查询许可当永久复制许可。

`platformAssistantPort({request})` 用于可信本机/IPC 装配；HTTP adapter 固定
HTTPS 或显式 loopback origin，禁止重定向及附带 Human cookie。凭据只进入
Host 端口，不放入 profile、模型提示词或查询参数。读前后检查 binding 和
lease；平台还检查委托、成员代次和会话权限。CLI 的 local:main 历史仍是
自身渠道事实，不复制成平台群历史。

## 与 Grokbot 参考的关系

参考本机 `grokbot-reference-a9f633e` 恢复源码，重点是 `source/host/agents/agent-profile.ts`、`source/host/extensions/session/session-store-factories.ts` 和 `source/host/extensions/memory/agent-state.ts`。

采用其稳定 agent 持有目录、session 引用持久状态、私有与共享记忆分别界定的思路。我们的 Bot 已经是资源根，因此将私有记忆扁平到 `bots/<botId>/memory`，不重复嵌套 agent。它的本地分片规则不能直接替代我们跨 Human / Server 的权限协议。参考是非官方恢复源码，不能据此声称官方生产产品具备同样行为；历史研究边界见 [memory-files-and-shards.md](memory-files-and-shards.md)。

## 本轮范围与待接入项

已实现目录、稳定绑定、旧布局兼容、writer fencing、授权租约、本机 Channels 命令分派和原生搜索。新路径有真实 LocalRunner/SQLite/Markdown 重开测试。

已接共享平台申领/撤销协议、Host 认证端口和模型只读查询。尚未实现申领 UI、自动常驻 Host 托管、原生入站消息到 Reception 的映射、共享来源派生记忆撤权清理及备份/迁移/删除的产品操作。因此不能称为已上线的自动个人管家；也没有修改原工作树中正在开发的 stdio-server。

验证记录见 [bot-resources-validation.md](bot-resources-validation.md)。

## 用户确认的个人代理接入契约

本节是用户在目录实现后明确的产品要求，替代此前“入站自动分配”及“按 Bot 自身群成员资格读取”的接入设想。本次实现按此契约验收；尚未接通的产品入口见上节。

- 用户主动申领，首次申领才创建个人助理资源。登录、注册、查询申领状态或打开列表都不能创建资源。重复/并发申领返回同一个资源；运行进程与引擎会话仍按需要启动。
- 当前产品只支持个人助理，不提供项目助理或任意 owner 选择。申领 Human 必须取自已认证的请求上下文，不能接受客户端指定其他 Human。
- Bot 保持独立身份、持久目录和执行审计；申领产生明确的 Human→Bot 委托关系。不能把 createdBy、同名或模型给出的 ownerId 当作委托，也不能将 Bot 凭据伪装成人类登录。
- 读取群列表、群历史和搜索结果时，以申领 Human 当前的群成员资格为范围；不需要 Bot 逐群加入。退群或撤权后停止读取。只读代理不能顺带标记用户已读、发送消息、管理成员或唤醒其他会话。
- 平台会话列表和历史复用当前 Human 的 discover/read 授权与分页，继承平台已有的共享历史规则；不另建“助理可见会话”快照。读取前后校验 Bot、委托关系和 Human 权限，异步迟到结果不能越过撤销边界。
- 代表读取与代表写入分开。本轮确认的是可见范围；发送、修改、删除、执行指令不能通过构造一个 Human context 获得通用授权。入口应只暴露收窄的委托读能力，审计保留执行 Bot 和被代理 Human。
- 撤销委托立即失效访问；停用/恢复不默认抹掉记忆和引擎状态。群聊和平台会话来源的派生记忆还需保留引用及权限边界，不能因为属于个人助理就无条件永久复制群内内容。

平台落点：NativeChannels 拥有成员资格和历史，Collaboration 复用现有会话可见性。
个人申领关系和活动凭据在 Core 的统一安装数据库；桌面 Main 持有安装，Daemon
借用该安装，不新建第二个 Human 或助理。没有人类身份或未申领时拒绝激活。

可信 Host 先调用平台 provisionPersonalAssistant，再将 Bot 认证端口交给
`startPersonalAssistant({serverDirectory,port,profileOptions})`。入口验证平台
binding 后才创建 bots/<botId> 并启动原 LocalRunner。撤销后重新申领保留 Bot
身份、目录和记忆，旧凭据不能恢复代理权限；需要 Host 发放新凭据。

此轮为源码及合成链路验证，未发布、未跑付费模型，未修改原工作树 stdio-server。

## 平台任务委托

个人助理可在用户显式授权后创建并跟进 Human 所有的平台 Thread；它的本地 Work/Codex
引擎会话仍是不同对象。群聊权限仍为只读。配置入口、CLI、幂等与 Worker 所有权见
[平台会话委托](platform-threads.md)。
