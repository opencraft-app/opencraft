---
id: adjacency-cloudladdergateway
type: project
scope: CloudLadderGateway 的 Proto、配置、运行时入口、README 与测试共同变更邻接。
triggers:
  - cloudladdergateway
  - clgateway
  - 计费代理
owner: wisp/mono2-maintainers
authority: derived
source_of_truth:
  - cloudladdergateway/README.md
  - cloudladdergateway/docs/README.md
  - cloudladdergateway/config.example.yaml
status: active
reviewed_at: 2026-08-27
review_due: 2026-11-25
revision: 1.0.0
precedence: project
derived: true
related_packs:
  - subscription-entitlements
---

# CloudLadderGateway 邻接

## 当前实现锚点

- `cloudladdergateway/README.md` 与 `docs/README.md` 是服务说明入口；`config.example.yaml` 是可公开的配置形状示例。
- 协议和运行时实现位于服务目录；涉及认证、路由或 transport 的改动需要同时检查同目录单元测试。
- 服务 Context 已声明 Proto 为协议真源，生成代码和 `make generate` 的关系必须以当前源码/Makefile 为准，不应由本卡推断生成物名单。

## 适用触发

CloudLadderGateway、CLGateway、计费代理、Proto、HMAC、mTLS、webhook、路由或 transport。

## 必查邻居

1. 从 requirement 中的符号在 `cloudladdergateway/` 做精确 `rg`。
2. 检查对应 README 或 `config.example.yaml` 是否体现契约变化。
3. 检查命中包的 `_test.go`，特别是 server、clientauth、sdktransport 或 discovery 的相邻测试。
4. 若改动涉及 Proto 或生成物，再读取实际生成命令/Makefile；不要根据历史猜测路径。

## 验证命令

```bash
rg --max-count 50 "<符号或配置键>" cloudladdergateway
```

命中后读取一个实现/配置文件和一个相邻测试文件，所需生成或服务测试命令以当前 README/Makefile 为准。

## 失效条件

若服务拆分、配置示例迁移、Proto 生成流程重写或测试目录改名，本卡失效，必须先更新事实锚点。
