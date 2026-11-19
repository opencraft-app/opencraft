# wecom CLI

单文件、零依赖的企业微信内部客服接口命令行（Node ≥ 24）。覆盖文档中的全部接口：建群/查群/改群/退群，
text、markdown、image、file、rich_text、template_card 六种消息，模板卡片更新，流式回复，rtx↔userid，机器人信息。

```sh
export WECOM_CONFIG=/path/to/wecom.json   # {"corpId","corpSecret","serviceId"}，0600，不入库
node wecom.mjs --help
node wecom.mjs <任意命令> --dry-run   # 只打印请求，不发送、不需要凭据
```

目标写法：`g:<chatid>` 群聊，`u:<userid 或 rtx>` 单聊（rtx 名可直接用）。

## 实测（2026-11-13，真实客服号）

| 能力 | 结果 |
|---|---|
| chat create/get/update(rename)/quit、user id/name、robot | 通过 |
| text、markdown（含 `<font color>`）、rich_text（@人、view/click 链接）、image、file | 通过 |
| text_notice、button_interaction、vote_interaction、multiple_interaction、news_notice 卡片 | 发送通过 |
| 单聊 `u:skipzhang` | 通过（rtx 名可直接作为 userid）|
| 流式 `respond_msg` | 通过；**同一流约 10–12 分钟后不可再更新**（10 分钟 ok，12 分钟 780011）|
| 已结束（finish=true）的流再更新 | 仍返回 ok，不能依赖服务端锁定 |
| 同一条原消息下再开新流 | 可以，过期旧流不影响新流 |
| 卡片点击/选择回调、`update_template_card` | 需要回调处理方：回调进入 Relay，ResponseCode 5 秒有效 |

## 玩法

- **CI / 发布播报**：`card notice` + `--big 通过数=用例` + `--kv 分支=…`，失败时 `send rich` @ 负责人。
- **流水线直播**：`some-long-job | node wecom.mjs stream pipe <msgid>`，日志逐段刷新在同一个气泡里（≤20KB、≤10 分钟）。
- **一键作战群**：`chat create "事故 #123" 张三 李四` → `send md` 贴背景 → 结束后 `chat rename "【已恢复】事故 #123"`。
- **轻量审批 / 投票 / 排期**：`card buttons`、`card vote --multi-choice`、`card select`；结果经 Relay 回调，凭 ResponseCode 5 秒内 `card update` 改成“已由 xx 批准”。
- **交付物直达**：`send file g:… report.pdf`、`send image g:… chart.png`。
- **身份互转**：`user id`/`user name` 给脚本把 T 号翻译成 rtx。

管家托管卡片已有 Relay 回调闭环；运维 CLI 任意构造的 task_id 不会自动获得管家 owner/回调绑定。

## 管家/Agent 的安全 CLI（已与运维原始 API CLI 分开）

不要将本页开头的 `WECOM_CONFIG` 或机器人总密钥配给 agent。原始 `wecom.mjs` 是运维入口；管家使用 `scoped.mjs` 生成的私有 `wecom`，通过本人的现有助理通信端口执行，不直连企微 API。

- 每个有效“助理＋企微会话＋成员/归属版本”生成独立 launcher，放在共享 execution 目录，Gateway 与 Hands 使用同一路径。仅打印 launcher 路径，不将连接凭据放进提示词、回执或日志。
- CLI 不安装成一个跨人的全局账号。管家可用 `thread_command` 的 `argv:["wecom","capabilities"]`；群运行时固定目标会话，客户端不能选择另一个 scope。
- 委派给主人的完整 OpenCraft 时，任务提示自动携带该会话 CLI 的绝对路径。Agent 可以直接执行它或将其目录加入本次 shell PATH。不需要手工配置企业微信凭据。
- 本机 Unix socket 和 binding 文件仅当前运行用户可读；每次请求重新复核原助理身份、主人、来源和群成员版本。作用域撤销/关闭会取消服务，旧 launcher 不继续授权。
- `capabilities` 区分可调用命令、自动协议能力和运维专用能力。不会声称所有底层接口都应交给 agent。

```sh
WECOM=/本次任务提示中的路径/wecom
"$WECOM" capabilities
"$WECOM" groups
"$WECOM" chat get                  # 原生授权成员；实时企微名单用下面的 members
"$WECOM" chat members --idempotency-key members-1  # 发实时成员/机器人名单到原会话
"$WECOM" chat create '事故 #123' zhangsan lisi --idempotency-key incident-123
"$WECOM" chat rename '事故 #123 已解决' --idempotency-key rename-123
"$WECOM" send md '检查通过' --idempotency-key report-123
"$WECOM" send file report.pdf --idempotency-key report-file-123
"$WECOM" card vote '{"title":"午餐","options":["面","饭"]}' --idempotency-key lunch-1
"$WECOM" card select @form.json --idempotency-key collect-1
"$WECOM" card buttons '{"buttons":[{"title":"检查构建","prompt":"查询我有权限的构建状态"}]}' --idempotency-key shortcuts-1
"$WECOM" file info f01234567890123456789012345678901
"$WECOM" status wecom-assistant:回执中的消息ID
```

已配置统一连接的群，`chat rename/add/remove` 自动走原生群操作，无需改用同步命令。返回 `receiptId`，继续用 `status RECEIPT` 查询：本群已生效不等于企微已确认。成员参数仍是已登记的 RTX；权限沿用原生群主规则。未关联企微身份的人只加入本群，不猜测身份、不自动注册。未配置统一连接的历史群保持原行为。

`--group` 可省略，私有入口默认当前会话；显式指定必须仍是同一授权会话。写操作必须提供稳定 `--idempotency-key`，同键改变内容拒绝。stdout 为 JSON，错误为非零退出码。返回 messageId 仅证明原生 outbox 接收，不证明企微已送达；`status` 区分 queued/delivered/rejected/unknown 等真实状态。文件在客户端读取、限制20MiB、按40KiB私有帧发送；服务端不接受客户端文件路径，不解析原件。

卡片使用已有管家业务格式，不是任意提供方 JSON：`notice/news` 接日报 report 对象，`buttons` 接 `{buttons:[{title,prompt}]}`，`vote` 接 `{title,options,multiple?,deadline?,remindBeforeMinutes?}`，`select` 接 `{title,questions:[{title,options}],deadline?,remindBeforeMinutes?}`。回调验签、owner约束、卡片更新、投票汇总/结束/CSV导出沿已有回调闭环处理；不是让 agent 读取 ResponseCode 或伪造点击。

`task stop|rerun TASKKEY`、`daily pause` 由当前群运行时处理，不能停止别人的任务。`@所有人`仍遵守原显式请求与频控，不因CLI放宽。客服总 token、任意 media_id、跨人私聊、任意目录查询和任意原始卡片 handler 不暴露给 agent。私有 CLI 不是新的企业级搜索或授权来源。

新增只读 `chat live`：返回实时企微群名、memberIds、成员名称/类型和查询时间；
仍受本人的当前会话限制，不等于原生成员授权。`status` 增加群修改后核验结果。
投票/表单可显式设置 `onClose` 保存结束后的agent续办指令。
当前群的私有入口支持 `watch add NAME JSON`、`watch list`、`watch remove NAME`；
增删要求幂等键。订阅需指定实时机器人id和instruction，默认5分钟频控、24小时有效、
最多触发20次，可分别在60–86400秒、1–168小时、1–100次范围内明确配置。
JSON参数同样支持文件、@文件和stdin。告警和收集结果不成为新的授权来源。

### 收集管理与交付形式

```sh
"$WECOM" collection list
"$WECOM" collection get oc-m-任务ID
"$WECOM" collection get oc-m-任务ID --before 50  # get 返回 nextOffset 后按偏移分页
"$WECOM" collection close oc-m-任务ID --idempotency-key close-1
"$WECOM" collection export oc-m-任务ID --idempotency-key export-1
"$WECOM" collection cancel oc-m-任务ID --idempotency-key cancel-continuation-1
"$WECOM" send file original.gif --idempotency-key original-1  # 原字节，保留动画/元数据
"$WECOM" send image preview.png --idempotency-key preview-1  # 图片消息，不能转换则拒绝
```

收集创建返回 messageId/taskId；list 为本人的有界登记索引，get 才是实时答案和未提交名单（创建时成员且目前仍在群）。cancel 仅取消 onClose 续办；close 结束收集并发汇总，不能绕过5秒 ResponseCode 约束任意更新历史卡片。索引最多128项，登记超时10分钟、收集续办最多等待7天、结束记录有界保留7天；错误、到期、撤销状态可查询，失败收集不会永久占用续办槽位。旧版本未登记的普通卡片不自动认领。

订阅把冷却期的后续消息持久化，冷却结束后成批交给 agent；单批20条/128KiB，达到缓冲边界时不越过未缓存消息推进原生历史游标。触发次数按批次计数。list 的 pendingMessages/processedMessages 区分“缓冲中”和“已交给助理”；这不代表用户已读或 agent 已完成分析。

### 群名与成员统一同步

`sync status | configure JSON | request JSON | cancel OPID` 复用当前群的私有 CLI。
仅原生群主可配置/发起；变更需要 `--idempotency-key`。字段可单向或双向同步，
成员默认只对账，不自动授予历史阅读权。本地操作立即生效，企微异步同步。完整配置、重新入群语义、未知结果与
容量限制见 [统一同步层](../../plugins/wecom/GROUP-SYNC.md)。
