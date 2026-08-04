# Clean-room 边界

## 当前规则

- Go 构建不得导入或执行 `../restored/`、`../first-party/`。
- 不复制恢复出的函数实现、私有注释、控制流或依赖源码。
- 不嵌入真实凭据、账号 ID、Computer ID 或迁移 token。
- 客户端必须使用真实自身版本，不冒充官方 Vela Computer 1.0.13。

`internal/cleanroom` 自动检查凭据形态、恢复源码路径、长行相似性、历史 Node/SEA 产物和
Runtime 架构边界。Go 业务代码继续统一使用项目 JSON wrapper。

## 冻结证据

旧协议、兼容矩阵、Agent CLI 证据和实现审计位于
`docs/legacy/vela-1.0.13/`。它们只用于证明独立实现过程和历史行为来源，不属于当前
Vela API，也不参与构建。新增产品行为不得以这些文件作为当前接口授权依据。
