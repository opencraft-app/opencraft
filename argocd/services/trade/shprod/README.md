# trade · shprod

上海正式 trade deploy-facing 入口。

关键约束：

- `LIGHTVELA_TRADE_REGION=ap-shanghai`，jifei 出向地域为上海。
- `TRADE_SHADOW_MOCK_ENABLED` 必须留空，正式环境只连真实 shadow binding。
- 点石通道已按北京预发布实际配置启用启航 01 活动；activity secret 只写 DB，不落 Git。
- DB migration 不在 Argo sync 内自动跑，由生产 DB migration 阶段人工准入后执行。

上线前操作：

1. 在 SSM `mono-shprod-trade-runtime-secrets` 写入 trade runtime secret 键集。
2. 运行 `python3 scripts/export_ssm_to_sops.py --manifest scripts/ssm_manifest.trade.shprod.yaml --only trade-runtime-secrets`。
3. 运行 `python3 scripts/scan_secrets.py argocd/secrets/shprod/trade-runtime-secrets.sops.yaml`。
4. 确认 shprod trade DB 已建库建用户，迁移执行到 `000008`。
5. 执行 `scripts/seed_trade_shprod_bundle_definition.sql`，只 seed trade 侧 bundle 下单元数据。
6. 设置点石 activity secret 后执行 `scripts/seed_trade_shprod_dianshi_activity.sql`，启用 shprod 点石活动映射。
