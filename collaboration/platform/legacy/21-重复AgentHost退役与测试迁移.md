# 重复 Agent Host 退役与测试迁移

状态：已实施
日期：2026-07-31
前置决策：`20-Vela正式AgentHost收敛.md`

## 1. 退役范围

Chatserver 后台已经删除：

```text
cmd/chatserver-agent
internal/agentapi
internal/agentcli
internal/agentgateway
internal/agenthost
internal/agentmanager
internal/codex
internal/gatedsteering
internal/hermes
internal/hermesgateway
internal/protocol
internal/runtimeapi
internal/runtimecatalog
internal/runtimehost
internal/runtimeprompt
internal/runtimes
```

同时删除只被这些包使用的本地状态、JSON 包和文件锁。删除前确认正式后台 API、
TAT Worker、IM Adapter、Runtime Session 和数据库层都不导入这些包。

Chatserver 继续保留：

- Agent 定义、权限、Computer 绑定和 Runtime 配置；
- Runtime Credential 与短期 Session/UserSig；
- TAT 生命周期编排；
- 腾讯 IM 管理面适配；
- Node SEA Bridge 源码与原生构建。

## 2. 唯一实现

Agent Host、Agent Manager、Codex/Hermes Driver、Capability Gateway、IM Transport、
本地 processing journal 和 Agent-facing `raft` CLI 统一位于：

```text
/Users/skipzhang/new-api/research/raft-computer-1.0.13/go-client
```

正式入口：

```text
raft-computer-go --mode vela
```

后台加入架构测试，禁止上述旧目录重新出现。历史设计文档可以提及旧名称，但生产
源码、发布脚本和 TAT 模板不能再依赖它。

## 3. 测试迁移

删除不是放弃测试。迁移规则如下：

| 旧测试类别 | 新位置 |
| --- | --- |
| CLI、Runtime Session、credential、Host 生命周期 | `internal/vela/{cli,app,platform,credential,host}` |
| Bridge JSON Lines 与子进程监督 | `internal/vela/bridge` |
| Agent Gateway 与回复动作 | `internal/vela/agentgateway` 与 `internal/gateway` |
| Agent Manager、Codex、Hermes、Runtime Catalog | canonical 同名包 |
| 多 Human、多 Agent、Topic、自动回复、离线 exactly-once | `internal/vela/integration`，`canary` build tag |

Canonical 已有的同语义测试不机械复制。迁移前的 258 个旧 Host 测试中，195 个名称
与 canonical 测试直接重合；其余大部分由更强的 Vela 测试覆盖。额外迁入此前
canonical 缺少的 Bridge 安全边界：

- UserSig/Secret 只能经 stdin 协议帧进入子进程；
- 不继承非白名单环境；
- stderr 只记录字节数，超限终止；
- malformed/oversized stdout 终止并唤醒 pending request；
- request timeout 清理 pending 且不污染后续请求；
- parent cancel 终止子进程；
- shutdown 超时执行强杀；
- executable 必须是受信普通文件。

为承载真实 Human Topic 验收，canonical IM Transport 增加受校验的
`MentionUserIDs`：C2C 禁止 mention，Group/Topic 接受非空、不重复、无首尾空白的
UserID 列表。

## 4. Canary 归属

以下真实用例从 Chatserver 移到 canonical go-client：

- Human → Agent C2C 自动回复；
- Human A/B 与 Agent A/B Topic 路由矩阵；
- Codex/Hermes Runtime 自动回复双方可见；
- Agent wrapper 确定性 Topic 出站；
- Agent 离线恢复 Topic 且 exactly-once。

这些用例仍调用真实 Chatserver Platform API，但测试代码归属于实际运行 Host。
Chatserver 原先直接持有 IM 管理密钥、临时导入两个身份的 SEA Canary 被删除；
现有用例统一使用平台签发的 Human/Agent 短期 Session，避免在 Host 测试中扩大
管理员密钥暴露面。

## 5. 门禁

每次变更至少执行：

```text
Chatserver:
go test ./...
go vet ./...
./scripts/check-generated.sh
./scripts/scan-secrets.sh

Canonical:
go test ./...
go test -tags canary ./internal/vela/integration
go test -race ./internal/vela/...
go vet ./...
```

Bridge 使用固定 Node 24 执行测试。Chatserver release 只能生成 SEA Bridge 与许可证，
canonical release 再把 Bridge 与 `raft-computer-go` 组合成不可变平台产物。
