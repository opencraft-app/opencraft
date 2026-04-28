# Beijing Sandbox 2 Secrets

这个目录放北京第二测试环境的 deploy-facing secret / encrypted runtime artifact。

这些密文文件当前由北京新 Argo CD 直接消费，前提是：

- `beijing-sandbox-2` cluster 已注册到 Argo CD
- `argocd-runtime-beijing-sandbox` 已经把 repo-server 的 `ksops` 能力接起来
- `sops-age` 已通过 Git 外 bootstrap 注入到 `argocd` namespace

## 规则

- 正式 deploy-facing secret 一律以 `*.sops.yaml` 形式进入 Git
- cluster-side 解密统一由 `Argo CD + ksops` 完成
- 这里的文件是 deployable snapshot，不是 secret 的长期权威真源

长期权威真源：

- Tencent Cloud `SSM`

当前状态补充：

- 这批 `*.sops.yaml` 已可被 Argo 直接消费
- 但它们当前是基于现有北京 sandbox secret 形状和 `beijing-sandbox-2` infra 输出引导生成的 bootstrap snapshot
- 后续仍应把对应 `mono-beijing-sandbox-2-*` secret 真源补回 `SSM`，再按 `SSM -> export_ssm_to_sops.py -> Git` 回到标准主线

## 当前资产

- `admin-gateway-runtime-secrets.sops.yaml`
- `ai-gateway-runtime-secrets.sops.yaml`
- `ctl-conf-common.sops.yaml`
- `ctl-conf-rewrite.sops.yaml`
- `ctl-runtime-secrets.sops.yaml`
- `gateway-dashboard-runtime-secrets.sops.yaml`
- `lightclaw-auth-secrets.sops.yaml`
- `nextgen-dashboard-runtime-secrets.sops.yaml`
- `payment-runtime-secrets.sops.yaml`
- `sandbox-runtime-secrets.sops.yaml`
- `service-gateway-runtime-secrets.sops.yaml`
- `session-runtime-secrets.sops.yaml`
- `subscription-runtime-secrets.sops.yaml`

## 接入方式

每个服务自己的 deploy-facing 目录通过一个 `ksops` generator 引用本目录中的对应文件，例如：

- `argocd/services/ai-gateway/beijing-sandbox-2/ksops-secret-generator.yaml`
- `argocd/services/ctl/beijing-sandbox-2/ksops-assets-generator.yaml`
- `argocd/services/sandbox/beijing-sandbox-2/ksops-secret-generator.yaml`

对应的 SSM exporter manifest：

- `scripts/ssm_manifest.ctl.beijing-sandbox-2.yaml`
- `scripts/ssm_manifest.sandbox.beijing-sandbox-2.yaml`

## 约束

- 不要把本地 `.secret/*` 直接纳入 `argocd/`
- 不要把 cluster 当前 Secret 直接当作长期 source of truth
- 新增/轮转 secret 后，应回到 `SSM -> sops snapshot -> Git merge -> Argo sync` 这条主线
- `sops-age` 私钥本身不在这个目录里，也不应明文提交到 Git

Bootstrap 入口：

```bash
KUBECONFIG_PATH=/path/to/argocd-control-plane.kubeconfig \
  bash scripts/bootstrap_argocd_sops_age.sh
```
