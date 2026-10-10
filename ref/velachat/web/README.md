# Velachat Web

当前正式客户端是 Expo Router + React Native Web 单一代码库，Human 直接连接腾讯云 IM，并通过 Velachat 后台管理 Server、Member、Computer、Agent、Task 与 Terminal Session。

## 结构

```text
web/
├── apps/client/          # Web、iOS、Android 共用的产品客户端
├── packages/client-core/ # 平台 REST、领域模型和消息模型
├── deploy/               # 静态站容器与 Kubernetes 配置
└── docs/deployment/      # 静态托管说明
```

本仓库不包含原站镜像、恢复代码、旧 React 克隆、Node TUI、旧 Go 原型后台或验收截图。

## 开发

```sh
bun install
bun run verify
bun run --cwd apps/client web
```

构建静态站：

```sh
bun run build:web
```

产物位于 `apps/client/dist/`，该目录不提交 Git。
