# DSH Provider 管理 RPC 兼容修复

## 目标与边界

修复 LightVela DSH 页面在 `0.2.0-rc.2` 上查询模型供应商时的
`Invalid DeepSeek Harness providers response`，保持 `0.1` 实例兼容。
不修改用户现有密钥，不改网关授权，不关闭原生认证，不变更 GitOps。
前端正式发布使用既有国内/国际 EdgeOne artifact 发布路径。

## Context receipt

已读取 `frontend/AGENTS.md`、`.ci/AGENTS.md`、
`docs/context/project/services/frontend.md`、
`docs/context/domains/site-environment-routing.md`、
`docs/context/domains/release-gitops.md`。
运行时契约以官方 npm 发布的 `@deepseek-ai/dsh-*@0.2.0-rc.2` 为依据。

## 已确认原因与设计

- 前端内嵌 Python helper 的本机 RPC 没有原生 cookie，返回 401。
- 认证后旧点号 endpoint 返回 404；新版使用 `<namespace>/<method>`，
  `payload.args` 命名参数，供应商目录/活动列表与凭据元数据返回结构已变化。
- helper 在本机首页获取原生签名 cookie，只保存在进程内存；拒绝重定向。
- 只用供应商目录查询协商旧/新协议；写操作不因协议错误而重放。
- 新版通过目录和活动列表构造页面原有供应商状态，适配凭据元数据结构。
- 页面先检查命令退出状态并校验 Provider 数据，再渲染或显示错误。

## 验收

- 标准库 HTTP 集成测试覆盖 401/cookie、旧版、新版、保存/删除参数、
  有限重试、RPC ID 校验、重定向拒绝。
- 现有配置单测、前端 Provider 命令和生成资源契约测试通过。
- 指定实例真实供应商查询通过；仅对临时独立 credential reference 做
  set/describe/unset 验证并清理，不覆盖用户模型配置。
- 发布后核对源码 SHA、artifact 和公开静态资源，浏览器页面正确展示供应商。
