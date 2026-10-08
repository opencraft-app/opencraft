# 新加坡语音发布检查点

当前源码准备：新加坡独立 speech origin、专用 SOPS 投影和区域晋级清单。

验证通过：两个 Set 的 ModelRatio=0 / CompletionRatio=1、ep-hyasr3 渠道启用、admission/admin/HA 健康；区域 SSM v5 令牌与 CTL 快照相同；双区域 Secret 投影契约测试、SG 静态校验和单应用严格 Kustomize。

生产尚未修改。待 source MR 合入、正式镜像构建、独立晋级门禁、核对 live Secret 语义和精确发布 diff，随后只同步 service-gateway-sgprod。

补充：CORS 生产配置测试需要与语音启用配置一致的测试令牌，已通过 t.Setenv 补齐夹具。Gateway 全量 Go 测试和 canonical bundle guard 105 项均通过；生产缺令牌启动失败校验保持。
