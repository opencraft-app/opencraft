# Shanghai Production Secrets

这个目录放上海正式环境的 deploy-facing secret / encrypted runtime artifact。

这些密文文件现在由新的 Argo CD 控制面直接消费，前提是：

- `shprod` cluster 已注册到新 Argo
- 北京 runtime app 已经把这套共享 Argo 控制面的 `repo-server + ksops` 能力接起来
- `sops-age` 已通过 Git 外 bootstrap 注入到 `argocd` namespace

## 规则

- 正式 deploy-facing secret 一律以 `*.sops.yaml` 形式进入 Git
- cluster-side 解密统一由 `Argo CD + ksops` 完成
- 这里的文件是 deployable snapshot，不是 secret 的长期权威真源

长期权威真源：

- Tencent Cloud `SSM`

## 当前资产

- `admin-gateway-runtime-secrets.sops.yaml`
- `ai-gateway-runtime-secrets.sops.yaml`
- `cloudagent-gateway-runtime-secrets.sops.yaml`
- `ctl-conf-common.sops.yaml`
- `ctl-conf-rewrite.sops.yaml`
- `gateway-dashboard-runtime-secrets.sops.yaml`
- `lightclaw-auth-secrets.sops.yaml`
- `nextgen-dashboard-runtime-secrets.sops.yaml`
- `payment-runtime-secrets.sops.yaml`
- `sandbox-runtime-secrets.sops.yaml`
- `service-gateway-runtime-secrets.sops.yaml`
- `subscription-runtime-secrets.sops.yaml`

补充说明：

- 上海目前复用同一套新 Argo 控制面的 `ksops` 运行时
- `sops-age` 私钥本身不在这个目录里，也不应明文提交到 Git
- bootstrap 入口仍然是：

```bash
KUBECONFIG_PATH=/path/to/argocd-control-plane.kubeconfig \
  bash scripts/bootstrap_argocd_sops_age.sh
```
