# trade · beijing-sandbox（北京 2 预发布，现网计费形态）

deploy-facing 环境特化。引用 source-facing 真源 `trade/k8s/base/`，通过
`../common` Component 的 11 个 replacements 从本目录的 `trade-platform.env`
注入 image / node_pool / mysql host/port / 4 个 jifei env / mock 开关 /
站点身份 / region。

**设计目标**：完全按"现网形态"接入，与上海正式（shprod）链路等价；与北京 7
测试环境（sandbox-bj-7）严格区分（去掉所有联调期测试特化，详见 `kustomization.yaml`
注释段）。北京 2 预发布既是 trade 现网链路的"前置验证场"，也是未来 shprod
trade 上线之前的最后一道闸门。

## 资源清单

- `kustomization.yaml` — Kustomization 入口（`patches: [patch-account-binding.yaml]`）
- `trade-platform.env` — 平台层真值 + 4 个 jifei env + 站点 / region 字段
- `patch-account-binding.yaml` — 注入 `ACCOUNT_BINDING_INTERNAL_BASE_URL` 到
  `trade-config`（base 未声明该键）
- `ksops-secret-generator.yaml` — 引用 SOPS 加密 secret
- `../../../secrets/beijing-sandbox/trade-runtime-secrets.sops.yaml` — 由
  `scripts/ssm_manifest.trade.beijing-sandbox.yaml` 配合
  `scripts/export_ssm_to_sops.py` 从 Tencent Cloud SSM 导出（运维动作，AI 不
  生成加密文件）

## 现网链路拓扑

```
trade Pod (beijing-sandbox / ns=trade / region=ap-beijing)
   │  JIFEI_CGW_GATEWAY_URL    = http://81.71.196.13/v1/proxy/jifei-prod/...
   │  JIFEI_BILLING_APIGW_URL  = http://81.71.196.13/v1/proxy/jifei-billing-apigw-prod/...
   │  JIFEI_CGW_X_QCLOUD_USER_ID = ""        # 现网形态不注入测试 uin header
   │  TRADE_SHADOW_MOCK_ENABLED  = ""        # 连真实 lightclaw-auth shadow_bindings
   │  LIGHTVELA_TRADE_REGION     = ap-beijing # 出向 envelope.resInfo.region=8/800001
   │  TRADE_SITE_KIND            = cn        # 国内站身份
   ↓
lightvela-proxy prod (tkexgz, CLB 81.71.196.13)
   │  routes 新增（v1.7.31 cloudladdergateway/config.example.yaml）：
   │    - jifei-prod                → backend=jifei-prod
   │    - jifei-billing-apigw-prod  → backend=jifei-billing-apigw-prod
   ↓
jifei 现网（PDF §国内现网环境）
   - trade.tencentyun.com                    # CGW 询价 / 下单 / 支付
   - apigateway.billing.tencentyun.com       # 计费网关 销毁链路 ModifyResourceStatus
```

公网 DNS 实测（2026-06-12，本机 nslookup）：
- `trade.tencentyun.com` → 11.187.170.119 / 11.187.188.7
- `apigateway.billing.tencentyun.com` → 11.167.5.234

clgateway 在 tkexgz 集群有公网出口，能解析公网域名 → 走 PDF §国内现网环境
推荐的"域名直连 + Host header 透传"，**不像 jifei-test 测试环境域名 `trade.itd.com`
（内网域名）必须用 IP 9.139.137.40 直连**。

## 接入启动 SOP（运维 / 有 SSM + cynosdb root 权限的人执行；AI 不能代替）

按顺序完成，每一步未完成都会导致 trade pod 起不来或链路报错。

### A. 数据库准备（北京 cynosdb 共用实例 10.15.224.4:3306）

beijing-sandbox 沿用 payment 的"显式不接 migration job"纪律，trade 的库 / user
/ 密码必须**人工预先建好**（trade 启动后 GORM AutoMigrate 自动建表，但不会
建库 + user）。

**前置**：取 cynosdb root 凭证（与 payment 同库共用）。

**SQL 操作**（在 root 连接下执行一次性）：

```sql
-- 1. 创建 trade 业务库（与 shprod 未来同名，预发布作为现网命名预演）
CREATE DATABASE IF NOT EXISTS trade
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;

-- 2. 创建 trade 业务 user（密码 = SSM TRADE_DB_PASSWORD 真值）
CREATE USER IF NOT EXISTS 'trade'@'%' IDENTIFIED BY '<NEW_TRADE_DB_PASSWORD>';

-- 3. 授权（trade 服务只访问自己的库）
GRANT ALL PRIVILEGES ON trade.* TO 'trade'@'%';
FLUSH PRIVILEGES;
```

**migration**：trade 当前用 GORM AutoMigrate（详见 `trade/internal/store/db.go`）；
trade pod 首次启动会自动建表。如未来切换为显式 migration，需在此处补充
`trade-migrate up` 步骤（参考 sandbox-bj-7 的 trade-migration-job.yaml 模板）。

### B. SSM secret 预置（5 个键集；用户 2026-06-12 明确"jifei 现网计费签名密钥与
测试环境共用"，可直接复用 sandbox-bj-7 已落地的 JIFEI_BILLING_APP_ID / SECRET
真值）

详见 `scripts/ssm_manifest.trade.beijing-sandbox.yaml` 顶部注释。

**关键键集**（写入 Tencent Cloud SSM `mono-beijing-sandbox-trade-runtime-secrets`，
JSON 格式）：

| Key | 取值来源 | 必填 |
|---|---|---|
| `TRADE_DB_PASSWORD` | A 步骤新建 user 的密码 | ✅ |
| `LIGHTCLAW_INTERNAL_SERVICE_TOKEN` | 与 ctl / payment / subscription / shadow 共用（复用 beijing-sandbox 内 payment-runtime-secrets / ctl-runtime-secrets 中的同名键真值） | ✅ |
| `TRADE_TENCENT_BILLING_SIGNATURE_KEY` | jifei 同事提供（与 sandbox-bj-7 测试环境共用同一组真值） | ✅ |
| `JIFEI_BILLING_APP_ID` | 与 sandbox-bj-7 测试环境共用同一组真值（`argocd/secrets/sandbox-bj-7/trade-runtime-secrets.sops.yaml` 中 sops decrypt 后的明文） | ✅ |
| `JIFEI_BILLING_APP_SECRET` | 同上 | ✅ |

### C. 生成 sops 加密文件

```bash
cd /root/project/mono
python3 scripts/export_ssm_to_sops.py \
  --manifest scripts/ssm_manifest.trade.beijing-sandbox.yaml \
  --only trade-runtime-secrets
```

输出：`argocd/secrets/beijing-sandbox/trade-runtime-secrets.sops.yaml`

校验：`python3 scripts/scan_secrets.py argocd/secrets/beijing-sandbox/trade-runtime-secrets.sops.yaml`

### D. ctl 北京 2 预发布 secret 加 `[adapter.trade]` 段（迭代 9D）

ctl 在 beijing-sandbox 通过 `server_conf.toml::[adapter.trade]` 段配置 trade
RPC base url + token；详见同目录 `CTL_TOML_PATCH_9D.md`。

### E. cloudladdergateway 同步部署（**关键前置**）

trade-platform.env 里两个 jifei URL 走的是 `jifei-prod` / `jifei-billing-apigw-prod`
两条路由，定义在源码 `cloudladdergateway/config.example.yaml`（v1.7.31 新增）。
必须确保：

1. master / playground/sandbox-bj-7 已合入 v1.7.31 commit
2. `.ci/cloudladdergateway.yml` 已重新构建并 promote 到 gitops（tkexgz +
   tkexsg 两地 prod 镜像 tag 同步刷新）
3. tkexgz prod 实例 lightvela-proxy（CLB 81.71.196.13）pod 已 rolling 完成

验证：
```bash
sshpass -p '<jumpbox-pwd>' ssh -p 36000 root@9.208.245.238 \
  'KUBECONFIG=/etc/lightclaw-ci/kubeconfig_tkexgz \
   kubectl -n ns-prjqt8dd-867795-production rollout status sts/lightvela-proxy'
```

### F. 镜像 tag bump（master CI 首次 promote 后由 promote MR 自动完成）

`trade-platform.env::TRADE_IMAGE` 当前是 `REPLACE_TRADE_IMAGE_PLACEHOLDER` 占位。

启动条件：
1. master 最近一次 trade/* 改动 push（已完成至 commit 7b011f764 sync 自 sandbox-bj-7）
2. master CI `.ci/runtime/bundles/trade.bundle` 构建出 sha256 digest
3. promote MR 自动 bump 本目录 `TRADE_IMAGE` 为真实 sha
4. ArgoCD 同步刷新 trade pod

## 启动后验收清单

```bash
KCFG=/data/lightvela-bj-cls-config

# 1. trade ns 创建 + pod Running
kubectl --kubeconfig=$KCFG -n trade get pods

# 2. trade pod logs 无 error
kubectl --kubeconfig=$KCFG -n trade logs deploy/trade --tail=80

# 3. /healthz 200
kubectl --kubeconfig=$KCFG -n trade port-forward svc/trade 8080:80
curl http://127.0.0.1:8080/healthz   # 期望 200 OK

# 4. ctl ns → trade ns 跨 ns 调用
kubectl --kubeconfig=$KCFG -n ctl run --rm -i debug --image=curlimages/curl \
  --restart=Never -- \
  curl -sS http://trade.trade.svc.cluster.local/healthz

# 5. trade → lightclaw-auth shadow binding 反查（user-auth ns）
kubectl --kubeconfig=$KCFG -n trade exec deploy/trade -- \
  curl -sS "http://lightclaw-auth.user-auth.svc.cluster.local/internal/shadow/binding?external_user_id=<TEST_USER_ID>"
# 期望返回 JSON {uin, owner_uin, app_id, ...}（连真实 lightclaw-auth）

# 6. trade → clgateway prod → jifei 现网 ping（询价空请求测路由命中）
kubectl --kubeconfig=$KCFG -n trade exec deploy/trade -- \
  curl -sS -X POST "http://81.71.196.13/v1/proxy/jifei-prod/interfaces/interface.php" \
  -d '{}'
# 期望：clgateway 路由命中 + jifei 真实回 envelope（即使 returnCode 非 0 也说明
# 路径打通；返 404/无后端则路由没生效）

# 7. /v1/passes/order-and-pay 全链路 e2e（用真实微信登录用户走 lightclaw-auth
#    shadow binding）
# 期望：trade.PlaceOrderAndPay → jifei 现网 generateDealsAndPay → jifei 反向调
#       trade lightvela.pass.checkCreate → ctl pass 落地 → trade.trade_flow / pass 表
```

## 与 sandbox-bj-7 / shprod 三方对照

| 维度 | sandbox-bj-7（测试） | beijing-sandbox（本目录，预发布） | shprod（未来正式） |
|---|---|---|---|
| ns | lightvela-playground-sandbox-bj-7 | trade | trade |
| DB host | mysql.lightvela-playground-...svc | 10.15.224.4（cynosdb 北京） | 10.15.192.13（cynosdb 上海） |
| DB 库名 | trade_sandbox_bj_7 | trade | trade |
| jifei CGW | jifei-test 路由 | **jifei-prod 路由** | jifei-prod 路由 |
| jifei 计费网关 | jifei-billing-apigw-test | **jifei-billing-apigw-prod** | jifei-billing-apigw-prod |
| lightvela-proxy 实例 | testing（1.12.212.56） | **prod（81.71.196.13）** | prod（81.71.196.13） |
| X_QCLOUD_USER_ID | 330500000003（mock 测试 uin） | **""**（envelope 真实影子账号 uin） | ""（同左） |
| TRADE_SHADOW_MOCK_ENABLED | true（注入固定 700000164995） | **""**（连真实 shadow） | ""（同左） |
| TRADE_SITE_KIND | cn | cn | cn |
| LIGHTVELA_TRADE_REGION | "" | **ap-beijing** | ap-guangzhou |

## 常见排错

- pod CrashLoopBackOff 且日志为 `LIGHTCLAW_INTERNAL_SERVICE_TOKEN is required`
  → SSM secret 未预置或 sops 文件未生成；回 B/C 步骤
- pod 启动后 `dial tcp 10.15.224.4:3306: i/o timeout`
  → cynosdb 安全组 / VPC 路由问题；联系运维确认 trade ns 所在子网到 cynosdb
  的网络可达性
- pod 启动后 `Error 1045: Access denied for user 'trade'@'<ip>'`
  → A 步骤的密码与 SSM `TRADE_DB_PASSWORD` 不一致；重置 cynosdb user 密码并重写 SSM
- trade → clgateway → jifei 链路返 404 / 无后端
  → jifei-prod 路由未生效（E 步骤未做完）；检查 cloudladdergateway pod 镜像 tag
- trade pod 日志 `LIGHTVELA_TRADE_REGION=... is not a registered region`
  → trade-platform.env 的 region 字面量拼错；当前合法值仅 `ap-guangzhou` /
  `ap-beijing` / `ap-singapore` / 空字符串
