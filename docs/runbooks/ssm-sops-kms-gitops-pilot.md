# SSM + sops + KMS GitOps Pilot

这份 runbook 定义一条最小试点链路：

- 腾讯云 `SSM` 作为 secret 真源
- 腾讯云 `KMS` 作为 `SSM` 的托管加密能力
- `sops + age` 作为 Git 中的密文格式
- Argo CD 只消费加密后的 Kubernetes 资源 YAML

## 目标

避免让应用在运行时动态拉取 `SSM`，把不稳定面收敛到“发布/同步时”，同时保留：

- Git 审计
- GitOps 回滚
- 云上 secret 真源

## 当前边界

- `sops` 这层不直接接腾讯云 `KMS`
- `sops` 使用 `age`
- `SSM` 只在导出阶段被调用
- Argo CD 运行时不访问腾讯云 `SSM`

## 文件

- 导出脚本：`scripts/export_ssm_to_sops.py`
- 清单模板：`scripts/ssm_manifest.example.yaml`
- `sops` 规则模板：`scripts/sops-config.example.yaml`

## 1. 创建 age 密钥

在本地生成一对 `age` 密钥：

```bash
age-keygen -o .secret/argocd-sample.agekey
```

查看公钥：

```bash
grep '^# public key:' .secret/argocd-sample.agekey
```

把公钥填进：

- `scripts/ssm_manifest.example.yaml`
- `scripts/sops-config.example.yaml`

## 2. 在腾讯云创建试点 SSM secret

示例：

```bash
tccli ssm CreateSecret \
  --region ap-hongkong \
  --SecretName mono-hk-devops-argocd-sample-demo-secret \
  --Description 'Argo CD sample demo secret' \
  --SecretString '{"API_KEY":"demo-key","TOKEN":"demo-token"}'
```

如果 secret 已存在，可以用：

```bash
tccli ssm PutSecretValue \
  --region ap-hongkong \
  --SecretName mono-hk-devops-argocd-sample-demo-secret \
  --VersionId v2 \
  --SecretString '{"API_KEY":"demo-key-v2","TOKEN":"demo-token-v2"}'
```

## 3. 导出为 sops 加密的 Kubernetes 资源 YAML

先复制模板：

```bash
cp scripts/ssm_manifest.example.yaml /tmp/ssm_manifest.yaml
```

按实际值修改：

- `age_recipients`
- `secret_name`
- `namespace`
- `kubernetes_resource_name`
- `kubernetes_resource_kind`
- `output_path`

执行导出：

```bash
python3 scripts/export_ssm_to_sops.py \
  --manifest /tmp/ssm_manifest.yaml \
  --output-dir /tmp/ssm-sops-out
```

如果只想看明文结果用于调试：

```bash
python3 scripts/export_ssm_to_sops.py \
  --manifest /tmp/ssm_manifest.yaml \
  --output-dir /tmp/ssm-sops-out \
  --plaintext
```

## 4. 验证加密文件

查看生成物：

```bash
ls -l /tmp/ssm-sops-out
```

解密检查：

```bash
SOPS_AGE_KEY_FILE=.secret/argocd-sample.agekey \
  sops -d /tmp/ssm-sops-out/argocd-sample-demo.sops.yaml
```

## 5. 交给 Argo CD

把 `age` 私钥以 Secret 形式放进 `argocd` namespace，后续由 `ksops` 或等效集成解密：

```bash
kubectl -n argocd create secret generic sops-age \
  --from-file=keys.txt=.secret/argocd-sample.agekey
```

再把生成的 `*.sops.yaml` 放入 GitOps 仓库。

## Manifest 约定

`scripts/ssm_manifest.example.yaml` 中每个 item 定义一个输出文件：

- `id`：逻辑 ID
- `secret_name`：腾讯云 `SSM` secret 名
- 命名标准：统一使用 hyphen-style，例如 `mono-hk-devops-argocd-sample-demo-secret`
- `region`：区域，可继承默认值
- `version_id`：版本号，可继承默认值。用户自定义 secret 建议默认用 `SSM_Current`
- `namespace`：目标 Kubernetes namespace
- `kubernetes_resource_name`：目标 Kubernetes 资源名
- `kubernetes_resource_kind`：目标资源类型，当前支持 `Secret` / `ConfigMap`
- `output_path`：输出文件路径，正式标准必须落在 `argocd/` 这样的 deploy-facing 路径下
- `secret_type`：默认 `Opaque`
- `labels` / `annotations`：附加 metadata
- `string_key`：当 `SecretString` 不是 JSON 时必填

## CI 标准约束

正式标准下，CI 的 `SSM -> sops` 导出任务必须满足：

- 只允许修改 deploy-facing 路径
- 当前基线默认要求输出落在 `argocd/` 下
- 不允许 secret 导出流程顺手修改 source-facing 文件
- bot 分支按环境区分，避免多环境 secret 变更互相覆盖

## 数据格式约定

脚本默认支持两种 `SecretString`：

1. JSON object

例如：

```json
{"API_KEY":"<api-key>","TOKEN":"<token>"}
```

会生成：

```yaml
stringData:
  API_KEY: <api-key>
  TOKEN: <token>
```

2. 普通字符串

例如：

```text
super-secret-value
```

这时需要在 manifest item 里指定一个目标字段名：

```yaml
string_key: DEMO_SECRET
```

## 不要这样做

- 不要让应用运行时直接拉 `SSM`
- 不要把明文 `secret.yaml` 提交到 Git
- 不要把 `age` 私钥提交到仓库
- 不要假设 `sops` 直接支持腾讯云 `KMS`

## 试点建议

第一批只覆盖：

- `argocd-sample`
- 单个 demo resource

跑通之后再决定是否推广到：

- GitLab
- service-gateway
- user/auth
- 其他需要以 `ConfigMap` 或 `Secret` 形式进入 Argo 的 deploy-facing 资源
