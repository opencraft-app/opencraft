# Vela Computer 工程边界

本目录是运行在 LightVela 托管 Computer 上的 Agent Chat Client，不开放用户外部
Computer 加入。

## 权威职责

- 使用 Agent 的短期 Runtime Session 与 UserSig 登录腾讯云 IM；
- 按 Server/Channel membership 与 `replyPolicy` 过滤、排序和恢复入站消息；
- 向 Codex、Hermes 或 OpenClaw 交付消息，并通过受控 loopback capability 回复；
- 对账 Task 与 Reminder，不保存普通聊天正文作为平台事实。

## 非职责

- Human 登录与账户资料；
- 外部 Computer Enrollment、TAT 注册、安装命令和用户设备纳管；
- Server/Member/Task 权威数据库；
- OpenCraft UI；
- 腾讯云管理员凭据。

迁移基线暂时仍含旧 Computer Host/TAT/安装/升级代码。删除必须按测试驱动逐个切片，
先保留消息、幂等、launch fencing 和 Runtime adapter 行为，再移除不可达外壳。

## 验证

```bash
go test ./...
go test -race ./internal/vela/... ./internal/runtimeactor/... ./internal/agentcli/...
go vet ./...
```
