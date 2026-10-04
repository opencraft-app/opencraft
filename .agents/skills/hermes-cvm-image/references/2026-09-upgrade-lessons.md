# 2026-09 Hermes 0.21.3 升级复盘

来自本线程 2026-09-23/24 的构建、API 和 runner 日志，只是当时证据，不代表当前线上状态。
ID 用于定位历史；后续每轮重新发现。不保存密码、授权 token、Cookie 或密钥。

## 版本正确却验证失败

#19 (b-61dba00975dd4acdaf67610c35f35b98) 解析 COS src_version=0.21.3，实际 blueprint
lhbp-42vfur7i。runtime 验证把 SSH 重试错误中的临时 IP 识别为版本：

```text
Connection closed by 43.128.150.116 port 22
WARN: ssh transport failed (attempt 1/4), retrying in 5s
Hermes Agent v0.21.3 (2026.9.14)
```

原解析器抓第一段数字成为 43.128.150。source/import/dist/identity 都为 0.21.3，失败在镜像
创建/同步前。MR [!4581](https://git.woa.com/wisp/mono2/-/merge_requests/4581) 改成严格
版本行解析，#20 后续构镜通过。stderr 被标 error 不一定失败；fixture lhbp-latest 也不是实际
云端选择，判断实际退出码、调用位置和 resolver 日志。

## 补齐新山与北京重装量

MR [!4571](https://git.woa.com/wisp/mono2/-/merge_requests/4571) 补新山预检/审批/Pool/TAT，
以及共享 sgprod inventory region 过滤。当时 cn-pool node_alias 在 9.135.92.56；最初误认旧
北美 9.208.245.238，后经任务日志纠正，不能凭历史 IP 猜 runner。

北京预检 173 台：154 CLEAN、18 ALLOCATED、1 PAUSED。刷新后 109 CLEAN、38 DRY、7 RESETTING、
18 ALLOCATED、1 PAUSED，Pool 镜像从 img-067icnv1 改为 img-ilo236i3。这符合全 CLEAN reset
策略，包括 paused Pool。数量一致支持状态转换，但不足以证明同一批用户机未受影响，应比对 ID。
stage SUCCEED 当时也没有等 45 台待 reset 全恢复。

## 新山高内存 Pool 被回写

#20 (b-488fdc0cc6a0439685be88106ab1b04c) 新山目标 img-7ycxsp3v。两个 Pool 被回写到
img-2299bown：

| Pool | SKU |
|---|---|
| pool-1790148242956389919-3 | sku-hermes-2c8g50g |
| pool-1790148246434710411-4 | sku-hermes-4c16g80g |

两 SKU 当时仅绑定新山，旧 desired/stable 未更新，last_autoscale_action=sku_rollout_start。
CI 因整个 Hermes 集合跨地域而跳过所有 SKU，worker 却按单条 SKU 判地域，回写旧期望。
MR [!4595](https://git.woa.com/wisp/mono2/-/merge_requests/4595) 修成每 SKU 判定。

用户明确授权后用 internal API 更新两独占 SKU base/desired，保留 stable 让 controller 收敛，
不改跨地域共享 SKU。校正后旧 #20 可直接 retry；实际 checkout 固定 03779619，所以该恢复
依赖 live 期望校正，不表示 retry 消费了新源码。

## 存量验收与上海中断

新加坡对用户指定 Bot 用 TAT 只读 hermes --version 返回 0.21.3/exit 0，用户 API Running。
这证明实际版本和一次读命令成功，不能等同整套 repair 或业务全部完成。新加坡清单 1,695 台，
长时间 RUNNING 是批量规模，不能据此推断用户那一台卡死。

上海 runner 中断导致 heartbeat timeout。旧 payload 含 force 且无目标版本跳过，顶层未接
skip 入口，直接 retry 会再派发。MR [!4604](https://git.woa.com/wisp/mono2/-/merge_requests/4604)
引入 build/env checkpoint。它记录派发接受，仍需查原任务完成，也有接受与落盘之间的重复窗口。

当时旧上海结果约 7.2 MB、7,849 行且有坏尾行。恢复源码 78ba0362 已合入 master 9ebe471e，
复制到隔离目录、迁移 checkpoint，非交互 SSH 成功后 nohup 续跑。交互 SSH Broken pipe 不足以
归因于密码/PAM 或唯一会话限制。nohup 可脱离 SSH，但机器再重启仍需要续跑。

| 历史指标 | 数量 |
|---|---:|
| 去重目标输入 | 11,770 |
| checkpoint 已接受，跳过 | 425 |
| 续跑目标 | 11,345 |
| 新增 INVOKED | 971 |
| INVOKE_FAILED | 10,374 |
| 其中 AgentNotInstalled | 10,332 |
| 其他派发错误 | 42 |

exit 0 表示遍历完成，累计 1,396 条接受记录；没有核对全部远端终态，不能称为 1,396 台升级
成功。也不能把 10,332 台自动认定为已销毁；从 CVM 存在性/TAT 在线、owner/原 invocation
核对，库存清理另行授权。

## 门禁与报告

- 发布流程变更要同步 docs-impact 指定正式 release-gitops 文档，images README 不能替代。
- root PATH 未必有 jq，运行时 ci_ensure_jq 注入；测试明确依赖。stub 覆盖控制流，但不能代替
  真实 jq filter 验证。本机通过不证明国内 runner 通过。
- 同步 master 后无关失败要追 commit。当时 CIDR 配置已 /27、契约仍 /29，不能为门禁随意
  放宽生产权限或混入无关行为。
- 始终区分 merge、自动触发、image NORMAL、Pool 收敛、TAT 派发、远端完成、用户业务可用。
