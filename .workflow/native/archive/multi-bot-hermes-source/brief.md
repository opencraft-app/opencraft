# Multi-Bot Hermes Profile Source

## 需求

LightVela 国内站多 Bot 功能不新增数据库表，也不迁移已有数据库。Hermes Profile 作为 Bot 的唯一事实来源，页面刷新后仍能从实例中恢复完整 Bot 列表，并支持创建、复制、切换、删除和通道配置。

成功标准：

- `/v1/instances/:id/bots` 直接枚举 Hermes Profiles，不依赖 LightVela Bot 表。
- 主 Bot 稳定映射 Hermes `default` Profile；普通 Bot 的公开 ID 与 Profile ID 一致。
- 创建、复制、删除 Bot 直接调用 Hermes Profile 能力，保持现有前端 API 契约。
- 微信仍只允许同时归属一个 Bot，其占用元数据保存在实例 Hermes 目录，不新增数据库字段或表。
- 页面刷新后 Bot 切换入口和列表仍然存在。

## 方案

- 撤掉 `instance_bots`、`instance_channel_bindings` 及相关 migration/DAO。
- CTL 保留现有 Bot HTTP 路由，内部通过结构化 Python 脚本调用 `hermes_cli.profiles` 枚举 Profile，并通过 Hermes CLI 创建、重命名和删除 Profile。
- Profile 的 `display_name`、`description`、目录时间和 gateway 状态映射为 Bot 响应；Hermes `default` 映射为 LightVela `main`。
- 微信单 Bot 绑定使用 `$HERMES_HOME/.lightvela/channel-bindings/weixin.json`，通过实例内 Python 脚本原子读写。
- 微信登录会话继续使用现有 `channel_login_sessions` 表，但不新增 Bot/Profile 列；当前目标 Profile 由运行时参数和实例绑定文件承载。

范围：CTL Bot/Profile、微信登录与通道配置、service-gateway 路由、现有国内站多 Bot 前端契约及测试。

非目标：AgentChat Profile 路由、生产发布、Git commit/push/MR、国际站开放多 Bot。

## 关键上下文发现

- Hermes 官方实现中 Bot 即 Profile；`hermes_cli.profiles.list_profiles()` 可提供结构化 Profile 信息。
- Hermes Profile 元数据位于 Profile 目录和 `profile.yaml`，无需 LightVela 再维护一份 Bot 索引。
- 线上 `route_not_allowed` 是部署网关尚未放行新嵌套路由，与是否建表无关。
- 现有微信登录表是实例级会话记录，保持原结构即可；通道归属应跟随 Profile 文件状态。
- 普通复制会复制模型、人设、Memory、User Profile 和 Skills，但不复制会话、运行状态和通道凭证。

## 验证口径

- CTL：运行 Bot/Profile、微信登录和实例包相关 Go 单测。
- Gateway：运行路由 allowlist 测试。
- Frontend：运行多 Bot repository/context/sidebar 测试、类型检查和国内站构建。
- 静态检查：确认最终 diff 不包含新 migration、`instancebot` 或 `instancechannelbinding` 模型。
- 手工检查：在 5174 国内站确认创建弹窗、Bot 切换入口和 Profile 查询参数不发生回归；真实刷新恢复需要配套 CTL/gateway 部署后验证。
