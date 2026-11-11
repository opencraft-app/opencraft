# 本机真实验收复查 — 2026-11-11

旧 Codex 路径也在工具调用前失败，终态为 HTTP 429
`responseTooManyFailedAttempts`。当前阻塞是 Core 账号认证不可用：池内
access token 已过期，认证恢复后仍无可选账号，本地账号池代理返回 429。
没有依据把它归因于新 bridge、额度耗尽或本地累计失败次数。
在不登录、不刷新账号、不部署的本次边界内无法恢复，按任务步骤 1 停止。
没有代码修复。

脱敏证据：[codex-429.json](../../design/agent-bridge/recordings/live-recheck/codex-429.json)。
这是原生历史、日志和只读投影的字段摘录，不是成功任务录制。原始线程 ID
一致散列；凭据、账号身份、机器路径与进程 ID 不进入交付。

## 429 的证据链

| 观察 | 结果与含义 |
| --- | --- |
| 对照入口 | 现有网关 `/rpc/codex`，没有选择新 bridge；一次新线程、一次 `turn/start` |
| 模型与提示 | 当前模型列表包含 `gpt-5.6-luna`，low；`Reply exactly OK. Do not call tools.` |
| 对照终态 | 03:11:21 UTC，failed，429，items 为空；没有工具执行或有效回答 |
| 对照前账号投影 | 一账号 enabled、credentialConfigured、ready，无 hold；周额度使用 65% |
| 投影时效 | 额度观测时间为 11 月 7 日；ready/额度投影不能证明当前凭据有效 |
| 凭据只读元数据 | 池持有的 access token 到期时间为 `2026-11-07T19:39:27Z`；未输出 token |
| 当前 native HTTP 日志 | 03:11:20–21 UTC，POST 先 401 后 429；终态仅保留最后的 429 |
| 原生上游认证证据 | `codex_apps` MCP 日志为 401、`token_expired`，提示 authentication token expired；最早保留记录为 01:36:25 UTC |
| 对照后账号池数据库 | `pool_quota.error=authorization-rejected`，账号投影由 ready 变为 error，仍无 hold |
| 只读代理核对 | 03:13:06 UTC，GET `/v1/models` 返回 429，body 为 `No eligible Codex account` |
| 历史对应 | 保存的 P2a native 线程在 11 月 10 日 19:30:22 UTC 先 401 后 429；P7b once/cron 在 11 月 11 日 01:36:30–31 UTC 收到 429，同期已有上游 `token_expired` |

运行中的 Core bundle 和当前源码都保留同一因果路径：过期凭据续期失败或
上游认证拒绝会记录 `authorization-rejected`；账号选择排除 error 账号；
后续请求没有可选账号时，代理生成 `No eligible Codex account` 的 HTTP 429。
原生 `responseTooManyFailedAttempts` 是最后一次 HTTP 失败的终态包装，
不能据其名称断言账号触发了失败次数封禁。

POST 的 401 可能是 Core 续期失败后本地生成，不能声称捕获到了上游推理
接口的 401。直接的上游过期证据来自同期 MCP。既有 Core 自动鉴权恢复
有日志，但凭据到期时间未改变；本轮没有调用账号登录或
刷新命令，没有手动重试自动续期。续期失败的具体服务响应未保留，不能
判断 refresh token 撤销、维护进程失败或其它原因。收尾只读复核时 error 已被
其它运行活动清空、账号投影又变为 ready，但 token 到期时间仍未变；没有追踪
这次并发写入者，也没有将 ready 当作恢复成功或再跑模型。旧 P2a 没有保留足够
凭据快照，不能证明当时与当前使用同一个过期 token。

## 真实验收结果

| 项目 | 本轮结果 | 缺少的证据 |
| --- | --- | --- |
| P2a | **未验**；旧路径对照触发停止条件，新 bridge 不再重跑 | 真实读文件、工具中 steer、运行中网关重启、无重复副作用 |
| P7a | **未验**；未发起编排链 | 经 opencraft CLI 的有界 spawn/tell/wait/output 完整结果 |
| P7b once | **未验**；保留此前接纳后 429 的结论 | 一次成功模型输出及执行闭环 |
| P7b cron | **未验**；保留此前接纳后 429 的结论 | 一次成功模型输出及执行闭环 |
| P4 | **未验**；本轮未重试 session/new | 任务步骤 1 要求修不了即停，步骤 2 以 429 解决为前提；此前 HTTP 500 仍未排除 |

本轮没有测试或构建行为变更，未运行 `test:agent-bridge`、根 typecheck，
也没有代码修复需要派发独立审查。既有通过记录不当成本轮验证。
没有客户端验收、网关重启、服务部署、默认引擎切换、Hermes 修改、推送或 PR。

## 自行引入的决定

- 对照沿用用户指定的同一低成本模型 `gpt-5.6-luna`。当前模型目录无价格字段，
  不声称核实了绝对最低价；没有换模型。
- 将“修不了就停”和“429 解决后”应用于整个第二阶段，因此没有额外跑 P4。
- 证据采用 allowlist 字段摘录并散列线程 ID；保留时间、错误码与关联关系，
  不提交原始私有日志或身份资料。

后续缺口是由账号 owner 在另行授权下恢复 Core 认证，并先重新确认旧路径
可回答；然后补 P2a、P7a、once、cron 与 P4。不得靠清掉账号 error、放宽
筛选或换贵模型把本轮未验写成通过。
