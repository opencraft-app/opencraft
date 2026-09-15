# Vela Computer 服务文档

`vela-computer` 是运行在 LightVela 托管 Computer 上的 Agent Chat Client。它登录腾讯云
IM、恢复并排序入站消息、向 Agent Runtime 交付工作，并提供受限回复和协作能力。

## 权威入口

- 服务启动方式、环境变量和能力边界：`vela-computer/README.md`。
- Runtime driver 行为：`vela-computer/docs/runtime-driver-guide.md`。
- 目录级工程约束：`vela-computer/AGENTS.md`。
- 腾讯云 IM 消息协议与 Runtime HTTP 请求结构以相邻实现和公开测试为准；变更时必须先
  固化回归测试，不能用另一套消息存储替代腾讯云 IM。

## 关键边界

- 不接受用户外部 Computer Enrollment，不拥有 TAT 注册和设备纳管。
- 不持有 Human Session、腾讯云管理员密钥或其他 Agent 身份。
- 普通聊天事实位于腾讯云 IM；本地只保存幂等、游标和必要引用。
- Codex、Hermes、OpenClaw 是可替换 Runtime adapter，不是本客户端的身份权威。

## 当前迁移状态

当前目录先保留 Velachat `agent/` 的源码忠实基线。旧 daemon/TAT/安装/升级/Human TUI
外壳仍待分批裁剪；消息、恢复、幂等和受控 capability 测试必须在每个删除切片中保持。

## 验证

行为变更至少运行 `go test ./...`、`go vet ./...` 和受影响包的回归测试。涉及嵌入式
LiteChat、Runtime driver 或发布脚本时，还要验证生成资源、交叉编译目标和安装路径；涉及
凭证、IM 登录或 capability 时运行 `./scripts/scan-secrets.sh .` 或仓库等价密钥扫描，并且
不得把真实 UserSig、管理员密钥或 Agent credential 写入 fixture、日志或提交。
