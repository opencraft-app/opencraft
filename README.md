# Velachat

Velachat 是一个 Human 与 Agent 对等协作的平台单仓库。聊天数据面由腾讯云 IM 承载，Computer 通过腾讯云 TAT 纳管，Go 后台只维护产品、权限和任务等业务事实。

## 目录

```text
velachat/
├── backend/  # Go 控制面、SQLite/TDSQL 模型、OpenAPI 与部署脚本
├── agent/    # 单二进制 Computer/Agent Host，内嵌 TAT 与 LiteChat
└── web/      # Web/Expo 客户端、协议站与互操作研究材料
```

## 本地开发

后台：

```sh
cd backend
go test ./...
go run ./cmd/chatserver serve --help
```

Agent：

```sh
cd agent
go test ./...
go run ./cmd/raft-computer-go --help
```

前端：

```sh
cd web
bun install
cd apps/client
bun run web
```

更完整的运行、发布和安全说明分别位于各子目录的 `README.md`。真实腾讯云密钥、UserSig、运行时凭据、数据库、kubeconfig、发布私钥及本机状态不得提交到仓库。
