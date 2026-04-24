# CTL Weixin Login Tech Debt

本文件记录微信登录链路当前已知但未阻塞上线的技术债，供后续重构时收敛。

当前基线：

- 镜像内正式协议入口是 `openclaw-weixin-login-session`
- `ctl` 已切到结构化 `start/status/cancel` 协议
- 端到端默认门禁已覆盖到 `waiting_qr`

## 1. 协议字段类型仍不够刚性

现状：

- `pid` 在镜像协议里出现过 `number` 和 `string` 两种类型
- `ctl` 当前已经兼容宽解析

问题：

- 调用方被迫承担协议兼容成本
- 未来再接其他消费者时，容易重复踩坑

建议：

- 把协议字段类型收紧成固定 JSON schema
- 至少保证 `pid`、`ok`、`status`、`error_code` 的类型稳定

## 2. `status` / `cancel` 仍依赖状态文件回退

现状：

- `envd process` 的短命令返回偶发不稳定
- `ctl` 当前通过读取
  `/tmp/lightclaw-weixin-login/<session_id>/state.json`
  作为补偿事实源

问题：

- 现在的稳定性建立在“双通道读取”上
- 排障时需要同时理解 process 返回和状态文件

建议：

- 明确把状态文件定义成协议的一部分，并文档化其兼容承诺
- 或继续排查 `envd process` 短命令返回稳定性，尽量减少 fallback 分支

## 3. 默认烟测只覆盖到 `waiting_qr`

现状：

- 当前自动化通过条件是“成功获取二维码”
- `scanned -> success -> gateway restart` 还没有纳入默认门禁

问题：

- 二维码链路通了，不代表完整登录闭环稳定

建议：

- 后续补充一个受控的完整扫码成功回归
- 或至少补充一条可人工触发的 staging 专项验收脚本

## 4. `cancel` 与后台轮询的并发语义仍然脆弱

现状：

- 当前通过 runtime `closing` 标记避免状态回刷

问题：

- 这属于调用方状态机层的保护，不是协议天然保证
- 如果未来增加更多终态或事件类型，并发竞态可能再出现

建议：

- 在镜像协议层补更清晰的终态语义
- 或在 `channel_login_sessions` 上增加更严格的终态写入约束

## 5. 运行时状态目录仍是临时目录

现状：

- 状态目录固定在 `/tmp/lightclaw-weixin-login/<session_id>/`

问题：

- 临时目录语义清晰，但天然不适合更长周期状态保留
- 对排障和事后审计不够友好

建议：

- 保持当前目录不变的前提下，补充更明确的 `gc` / TTL / 排障采样策略
- 如果未来要扩展多阶段登录协议，再评估是否需要更明确的持久化或 artifact 方案

## 6. pool rollout 与协议验证还没有统一成单条流水线

现状：

- 构镜验证、pool 切镜像、CTL 端到端验证目前都已经有脚本
- 但整体仍是人工串联

问题：

- 容易出现“镜像已构建，但 pool 没切”或“pool 已切，但库存没回填”的误判

建议：

- 后续把“制镜 -> verify -> rollout pool -> smoke CTL”串成一条标准发布 runbook 或流水线

## 7. 文档债

当前已收敛：

- 旧的 PTY 主链路说明已从微信专项文档中移除

仍需持续注意：

- 以后如果镜像协议状态枚举或状态文件路径变更，必须同步更新：
  - [../agent-guides/ctl-weixin-login-api-guide.md](../agent-guides/ctl-weixin-login-api-guide.md)
  - [../agent-guides/ctl-weixin-followup-guide.md](../agent-guides/ctl-weixin-followup-guide.md)
  - [../agent-guides/sandbox-image-agent-guide.md](../agent-guides/sandbox-image-agent-guide.md)
  - [../../images/README.md](../../images/README.md)
