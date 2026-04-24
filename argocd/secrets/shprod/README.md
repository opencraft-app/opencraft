# Shanghai Production Secrets

这个目录放上海正式环境的 deploy-facing secret / encrypted runtime artifact。

## 规则

- 正式 deploy-facing secret 一律以 `*.sops.yaml` 形式进入 Git
- cluster-side 解密统一由 `Argo CD + ksops` 完成
- 这里的文件是 deployable snapshot，不是 secret 的长期权威真源

长期权威真源：

- Tencent Cloud `SSM`

## 当前资产

- `admin-gateway-runtime-secrets.sops.yaml`
- `ai-gateway-runtime-secrets.sops.yaml`
- `ctl-conf-common.sops.yaml`
- `ctl-conf-rewrite.sops.yaml`
- `gateway-dashboard-runtime-secrets.sops.yaml`
- `lightclaw-auth-secrets.sops.yaml`
- `nextgen-dashboard-runtime-secrets.sops.yaml`
- `payment-runtime-secrets.sops.yaml`
- `sandbox-runtime-secrets.sops.yaml`
- `service-gateway-runtime-secrets.sops.yaml`
- `subscription-runtime-secrets.sops.yaml`
