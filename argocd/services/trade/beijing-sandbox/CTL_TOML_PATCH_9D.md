# 迭代 9D — ctl-conf-common toml 注入 `[adapter.trade]` 段

## 背景

trade 服务部署完成后（迭代 9A/9B/9C），ctl 中 `bundle_handler.describeBundles`
（B4）和 `pass.CreatePassOrder` / `pass.CreatePassOrderAndPay`（B2）会通过
`tradeAdapter` 调 trade 的内部 API。

**ctl 的 trade adapter base URL 由 `server_conf.toml::[adapter.trade]` 段配置**，
而不是 K8s env。所以必须在 ctl 的 SSM `mono-beijing-sandbox-ctl-conf-common`
里把 toml 内容补上这一段。

## 当前问题

`grep -r 'TRADE_INTERNAL_BASE_URL' /root/project/mono/ctl` 返回 0 — 不要往 ctl
secret 里加 K8s env 形式的键，**没有代码读它**。

正确做法是改 toml。

## 操作步骤（运维人工动作）

### 1. 取出当前 SSM toml

```bash
# 假设你在能访问 Tencent Cloud SSM 的机器上
tccli ssm GetSecretValue \
  --SecretName mono-beijing-sandbox-ctl-conf-common \
  --VersionId SSM_Current \
  --region ap-beijing \
| jq -r '.SecretString' > /tmp/ctl-conf-common.toml
```

### 2. 在 toml 中添加（或确认已有）`[adapter.trade]` 段

参考 `[adapter.shadow]` 的写法 mirror：

```toml
[adapter.trade]
base_url = "http://trade.trade.svc.cluster.local"
token = "ENC(...)"  # 与 [adapter.shadow] 的 token 同源（均为 LIGHTCLAW_INTERNAL_SERVICE_TOKEN）
                    # 加密用 ctl util.EncryptString，与 shadow 同一密钥
timeout = 10
```

注意：
- **token 必须与 trade 服务的 `LIGHTCLAW_INTERNAL_SERVICE_TOKEN` 是同一个原始值**
  （加密后 ENC 字符串可以不同，因 ctl util.EncryptString 用 IV）
- ctl 解析 toml 后会调 `util.DecryptString(token)` 解出明文，与 trade 的
  Bearer token 比对
- 如果 ctl 的 token 加密密钥与 trade 的 secret 里 plain text 不一致，调用会 401

### 3. 写回 SSM 新版本

```bash
tccli ssm PutSecretValue \
  --SecretName mono-beijing-sandbox-ctl-conf-common \
  --SecretString "$(cat /tmp/ctl-conf-common.toml)" \
  --region ap-beijing
```

### 4. 重新生成 sops 文件

```bash
cd /root/project/mono
python3 scripts/export_ssm_to_sops.py \
  --manifest scripts/ssm_manifest.ctl.beijing-sandbox.yaml \
  --only ctl-conf-common
```

### 5. 校验

```bash
python3 scripts/scan_secrets.py \
  argocd/secrets/beijing-sandbox/ctl-conf-common.sops.yaml
```

### 6. commit + push

```bash
git add argocd/secrets/beijing-sandbox/ctl-conf-common.sops.yaml
git commit -m "[FE-AI] feat(ctl): inject [adapter.trade] in beijing-sandbox toml (9D)"
git push origin feat/billing-integration
```

## 校验是否生效

trade pod 起来后，从 ctl-api ns 里 curl trade，应能取到带 Bearer token 的 200：

```bash
KUBECONFIG=/data/lightvela-bj-cls-config kubectl -n ctl exec deploy/ctl-api -- \
  curl -sS -X POST http://trade.trade.svc.cluster.local/internal/trade/inquiry/batch \
    -H 'Authorization: Bearer <LIGHTCLAW_INTERNAL_SERVICE_TOKEN-plain>' \
    -H 'Content-Type: application/json' \
    -d '{"externalUserId":"test","bundleIds":["b1"],"period":1,"timeUnit":"m"}'
# 期望: 200 OK 且返回 quotes 数组（即便 bundle 不存在，trade 也应返结构化错误而非 401）
```

启动后从 ctl 控制台访问 `GET /v1/bundles?xxx` 时 ctl 日志应出现：
```
INFO trade adapter: InquiryBatch ok bundleIds=[...]
```
而不是：
```
ERROR trade adapter: base_url not configured
```
