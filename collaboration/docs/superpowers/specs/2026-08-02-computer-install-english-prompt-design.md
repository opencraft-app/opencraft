# Computer 安装缺码提示英文化设计

## 目标

将公开 `/install` Bootstrap 在未收到安装码时输出的用户提示从中文改为英文：

```text
Missing the 16-character Computer setup code.
```

## 边界

- 只修改 Bootstrap 的缺码提示。
- 保持退出码 `2`、stderr、POSIX shell、HTTP 路由和安全约束不变。
- 不修改 API 错误码、JSON 错误消息、后台日志、Computer CLI 或安装后的 daemon 文案。
- 不新增国际化框架或语言协商。

## 验收

- Handler 测试必须断言脚本只包含完全一致的英文缺码提示，且旧中文提示不存在。
- 真实执行未传安装码的 Bootstrap：退出码必须为 `2`，stdout 必须为空，stderr 必须精确为
  `Missing the 16-character Computer setup code.\n`，不得包含其他提示。
- Bootstrap 继续通过 `/bin/sh -n`，覆盖整体 POSIX 语法。
- 全量 Go 测试、静态检查与凭证扫描通过。
- 发布后从 Canary `/install` 拉取脚本，确认英文提示、脚本语法、健康检查与 3 Pod 状态。
