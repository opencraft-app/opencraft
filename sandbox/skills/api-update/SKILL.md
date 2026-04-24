---
name: api-update
description: 更新/再生成 openapi.yaml 对应的 gin API（oapi-codegen）并重新构建运行环境的快速步骤。
---

# API 更新指引（openapi.yaml → gin）

当 openapi.yaml 变更时，按以下顺序操作：

1) 生成代码  
```bash
cd api-gin
make generate        # oapi-codegen --include-tags sandboxes
go fmt ./...
```

2) 快速校验  
```bash
cd api-gin
go test ./...
cd ..
go test ./...
```

3) Docker 构建 / 运行  
```bash
./scripts/dev-compose.sh down
./scripts/dev-compose.sh up --build
# 确保 .secret/sandbox/local.env 存在（相对仓库根目录）
```

4) 常见坑  
- 若 `go mod download` 报 Go 版本，确保 go.mod 与 Dockerfile 的 Go 版本一致（当前 1.22 + GOTOOLCHAIN=go1.24.0）。  
- 环境变量统一来自 `.secret/sandbox/local.env`；本地 compose 走 `scripts/dev-compose.sh`。  
- 未实现的 sandboxes 子路由仍返回 501；扩展时在 `api-gin/handler.go` 补充逻辑并同步 openapi。

5) 提交前  
- 查看 `./scripts/dev-compose.sh config` 确认 env 已加载。  
- 若调整生成标签/路径，更新 `api-gin/DEV_GUIDE.md` 以避免漂移。
