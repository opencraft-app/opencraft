# trade · beijing-sandbox

deploy-facing 环境特化（迭代 9B），引用 source-facing 真源 `trade/k8s/base/`，
通过 `../common` Component 的 replacements 从本目录的 `trade-platform.env`
注入 image / node_pool / mysql host/port。

## 资源清单

- `kustomization.yaml` — Kustomization 入口
- `trade-platform.env` — 平台层真值（image / node_pool / db host/port）
- `ksops-secret-generator.yaml` — 引用 SOPS 加密 secret
- `../../../secrets/beijing-sandbox/trade-runtime-secrets.sops.yaml` — 由
  `scripts/ssm_manifest.trade.beijing-sandbox.yaml` 配合
  `scripts/export_ssm_to_sops.py` 从 Tencent Cloud SSM 导出（迭代 9C）

## 联调启动条件清单（由人工或 CI 推进，AI 不能代替）

按顺序完成，每一步未完成都会导致 trade pod 起不来或链路报错。

### A. 数据库准备（北京 cynosdb 共用实例 10.15.224.4:3306）

**前置**: 取 root 密码（在 ctl 仓 `.secret/ctl/secret.env` 的 `DATABASE_URL` 里有北京 cynosdb root 凭证；或从 SSM `mono-beijing-sandbox-cynosdb-root` 取）

**SQL 操作**（在 root 连接下执行）:

```sql
-- 1. 创建 trade 业务库
CREATE DATABASE IF NOT EXISTS trade
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;

-- 2. 创建 trade 业务 user（密码记录到 SSM TRADE_DB_PASSWORD）
CREATE USER IF NOT EXISTS 'trade'@'%' IDENTIFIED BY '<NEW_TRADE_DB_PASSWORD>';

-- 3. 授权（trade 服务只访问自己的库）
GRANT ALL PRIVILEGES ON trade.* TO 'trade'@'%';
FLUSH PRIVILEGES;
```

**migration**: trade 当前用 GORM AutoMigrate（详见 trade/internal/store/db.go），
首次启动自动建表。如未来切换为显式 migration，需在此处补充 `migrate up` 步骤。

### B. SSM secret 预置（迭代 9C 人工动作）

详见 `scripts/ssm_manifest.trade.beijing-sandbox.yaml` 顶部注释。

**关键键集**（写入 Tencent Cloud SSM `mono-beijing-sandbox-trade-runtime-secrets`，JSON 格式）:

| Key | 取值来源 | 9B 期可否占位 |
|---|---|---|
| `TRADE_DB_PASSWORD` | A 步骤新建 user 的密码 | ❌ 必填真值 |
| `LIGHTCLAW_INTERNAL_SERVICE_TOKEN` | 与 ctl / payment / subscription / shadow 共用 | ❌ 必填真值（复用） |
| `TRADE_TENCENT_BILLING_SIGNATURE_KEY` | jifei 同事提供 | ✅ 9B 不连 jifei 可填 `placeholder-not-used` |

### C. 生成 sops 加密文件

```bash
cd /root/project/mono
python3 scripts/export_ssm_to_sops.py \
  --manifest scripts/ssm_manifest.trade.beijing-sandbox.yaml \
  --only trade-runtime-secrets
```

输出: `argocd/secrets/beijing-sandbox/trade-runtime-secrets.sops.yaml`

校验: `python3 scripts/scan_secrets.py argocd/secrets/beijing-sandbox/trade-runtime-secrets.sops.yaml`

### D. ctl 北京 secret 加 TRADE_INTERNAL_BASE_URL（迭代 9D）

trade 是 ctl 的 trade adapter 的 RPC target。ctl 北京 secret 可能尚未注入
`TRADE_INTERNAL_BASE_URL`。详见迭代 9D 落地。

### E. 镜像 tag bump（迭代 10 联调启动条件）

`trade-platform.env::TRADE_IMAGE` 当前是 `REPLACE_TRADE_IMAGE_PLACEHOLDER` 占位。

迭代 10 联调启动:
1. master push trade 代码（已完成至 commit 79be3921 + 9A 45551994）
2. CI 构建出 tag（如 `bj8-20260509-<sha>`）
3. 提 promote MR bump 本目录的 `trade-platform.env::TRADE_IMAGE` 为真实 tag
4. 合并 MR 到 gitops 分支
5. Argo 自动 sync

## 启动后验收清单

```bash
# 1. pod Running
KUBECONFIG=/data/lightvela-bj-cls-config kubectl -n trade get pods

# 2. logs 无 error
KUBECONFIG=/data/lightvela-bj-cls-config kubectl -n trade logs deploy/trade --tail=50

# 3. /healthz 200
KUBECONFIG=/data/lightvela-bj-cls-config kubectl -n trade port-forward svc/trade 8080:80
curl http://127.0.0.1:8080/healthz
# 期望: 200 OK

# 4. ctl ns 跨 ns 调 trade
KUBECONFIG=/data/lightvela-bj-cls-config kubectl -n ctl run --rm -i debug --image=curlimages/curl --restart=Never -- \
  curl -sS http://trade.trade.svc.cluster.local/healthz

# 5. bundle list 带 Price 真值
curl -H 'X-User-Id: <test-uin>' http://<gateway>/v1/bundles
# 期望返回 list 中每个 bundle 的 Price 字段非 0（B4 trade 询价回填生效）

# 6. /v1/passes/order-and-pay 全链路
# 9B 期 jifei 不连 → 此项报 jifei RPC 错（预期）
# 待 jifei 真接入后联调
```

## 常见排错

- pod CrashLoopBackOff 且日志为 `LIGHTCLAW_INTERNAL_SERVICE_TOKEN is required`
  → SSM secret 未预置；回 B 步骤
- pod 启动后 `dial tcp 10.15.224.4:3306: i/o timeout`
  → cynosdb 安全组 / VPC 路由问题；联系运维确认 trade ns 所在子网到 cynosdb 的网络可达性
- pod 启动后 `Error 1045: Access denied for user 'trade'@'<ip>'`
  → A 步骤的密码与 SSM 中 `TRADE_DB_PASSWORD` 不一致；重置 cynosdb user 密码并重写 SSM
