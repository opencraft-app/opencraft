# 本地 OpenTelemetry

继承[适配层](../AGENTS.md)。本模块装配官方 OTel SDK 的独立 tracer/logger providers、异步上下文与本地 OTLP JSON exporter，不注册全局 provider，不拥有业务状态或重试权。运行根拥有 flush/shutdown；多个 profile 不串 trace。

只记录固定操作名、白名单元信息和耗时，不记录提示、模型回答、资料、凭据、原始 RPC 参数或错误正文。写入失败只能降级观测，不能重做模型/业务动作。默认写 profile/telemetry，文件有界轮转、私有权限，不读取 OTLP 网络环境变量、不发送远端。

结构化拒绝可记录 app.schema_stage / app.schema_issue / app.schema_path；路径只能由解码器从 schema 名称生成，未知键遮蔽，不拼入模型值或原始异常消息。

验证 telemetry.test.mjs 的 OTLP JSON、trace/log 关联、并发父子关系、轮转、导出失败、敏感字段排除和真实 runner/评测路径；原生桥修改跑 Codex 专项。无数据库迁移。
