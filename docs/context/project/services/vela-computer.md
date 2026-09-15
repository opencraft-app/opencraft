---
id: vela-computer-service-detail
type: service
scope: 托管 Computer 上 Agent Chat Client、腾讯云 IM 接入和 Runtime driver 的派生服务上下文。
triggers: ["vela-computer", "agent chat client", "runtime driver", "托管 computer"]
owner: wisp/mono2-maintainers
authority: derived
source_of_truth:
  - vela-computer/docs/README.md
  - vela-computer/catalog-info.yaml
  - vela-computer/AGENTS.md
  - vela-computer/README.md
status: active
reviewed_at: 2026-09-14
review_due: 2026-12-13
revision: 1.0.0
precedence: service
derived: true
related_packs: ["agent-gateway-runtime"]
---

# Vela Computer 服务 Context

命中 `vela-computer/`、Agent Chat Client、腾讯云 IM 消息恢复或 Runtime driver 时加载；先读取
`vela-computer/AGENTS.md`。

## 当前边界

- 本服务下发到 LightVela 托管 Computer，负责把腾讯云 IM 消息交付给可替换 Agent Runtime。
- 不拥有 Human 登录，不接受外部 Computer Enrollment，也不建立第二套聊天消息权威。
- 幂等、游标、消息排序和 capability 是迁移必须保留的稳定行为；Codex、Hermes、OpenClaw
  只是可替换 driver。
- 当前源码仍保留旧 daemon/TAT/安装/升级和 Human TUI 外壳，后续应以回归测试保护的切片裁剪。

## 按需深入

- 服务入口、边界和验证：`vela-computer/docs/README.md`。
- 运行方式与配置：`vela-computer/README.md`。
- Runtime driver：`vela-computer/docs/runtime-driver-guide.md`。
- 涉及 CTL 实例或 Collaboration API 时再加载对应服务 Context，不加载 cloudagent 作为依赖。

## 验证

运行 `go test ./...`、`go vet ./...` 和受影响消息/driver 回归测试；涉及嵌入资源、交叉编译、
安装路径或凭证时追加对应构建与密钥扫描证据。
