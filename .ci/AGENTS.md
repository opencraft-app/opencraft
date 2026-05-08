# CI/CD Agent Guide

本目录维护 Devcloud / 蓝盾 CI 配置和运行时脚本。修改 `.ci/*.yml`、`.ci/runtime/**` 或相关发布凭据逻辑时，优先遵守本文件。

## 蓝盾 CI 语法来源

本仓库使用 Devcloud / 蓝盾 Stream YAML。遇到不确定的 YAML 语法、stage 审批、插件 step、变量表达式或运行模型时，优先查证
BK-CI 开源实现：

- https://github.com/TencentBlueKing/bk-ci.git

建议查证路径：

- `src/backend/ci/core/common/common-pipeline-yaml/`：Stream YAML schema、parser、transfer 逻辑。
- `src/backend/ci/core/common/common-pipeline-yaml/src/main/resources/schema/V3_0/ci.json`：v2.0 YAML 顶层字段、`on`、`extends`、`stages/jobs/steps`、`check-in` 的 JSON schema。
- `src/backend/ci/core/common/common-pipeline-yaml/src/test/resources/samples/`：官方样例，优先看 `extends/`、`jobs/`、`steps/`、`all/`。
- `src/backend/ci/core/common/common-pipeline-yaml/src/test/resources/templates/`：模板样例，优先确认 `parameters`、`variables.template`、stage/job/step template 行为。
- `src/backend/ci/core/common/common-pipeline-yaml/src/test/resources/compared/`：样例展开后的期望结果，用来确认服务端 parser/transfer 实际会怎么实例化。
- `src/backend/ci/core/common/common-pipeline-yaml/src/main/kotlin/com/tencent/devops/process/yaml/v3/`：v3 parser / model / transfer 源码；schema 不足时以这里为准。
- `src/backend/ci/core/common/common-pipeline/`：Pipeline model、stage check-in、人工审核元素。
- `support-files/sql/5001_init_dml/5001_ci_store-init_dml_mysql.sql`：内置插件 atom code 与输入参数。

查证建议：

```bash
git clone --depth 1 --filter=blob:none --sparse https://github.com/TencentBlueKing/bk-ci.git /tmp/bk-ci-src
cd /tmp/bk-ci-src
git sparse-checkout set src/backend/ci/core/common/common-pipeline-yaml src/backend/ci/core/common/common-pipeline support-files/sql/5001_init_dml
rg -n "extends|check-in|template|parameters|<keyword>" src/backend/ci/core/common/common-pipeline-yaml
```

不要凭记忆猜蓝盾 YAML 语法；仓库里没有现成示例时，先用 BK-CI 源码或公开文档确认后再改 `.ci/*.yml`。
本仓库已经踩过的规则：

- `on.push` 在当前 schema 下可以是对象或数组；不要写 GitHub Actions 风格的 `push.enable`。
- `mr.action` 只接受 schema enum 中的值；遇到 `CI_YAML_INVALID` 先查 `ci.json`。
- root `extends` 不能同时带 `stages/jobs/steps/variables/finally`；服务实例 YAML 只保留 `name/on/extends`。
- 当前仓库仍按 Stream `version: v2.0` 编写：root `extends.template` 必须是字符串，实例参数放 `extends.parameters`。
- 不要把 `.ci/templates/*.yml` 局部模板入口切到 `version: v3.0`；蓝盾 PAC v3 暂未支持局部模板，除非模板已迁到平台/远程模板机制。
- 不要在 `.ci/**` 放非流水线 `.yaml` 文件；蓝盾会把它们误识别成流水线。私有配置用 `.manifest` / `.bundle` 后缀。
- 生产审批优先确认当前平台是否支持 `check-in`；如果 schema/UI 不稳定，不要把 shprod 发布链路绑定到未验证的 approval YAML。

## 实际运行机

当前自有构建池 `env` 的 CI/CD 实际执行位置：

- Devcloud CI/CD 构建机：`root@9.208.245.238`
- SSH 端口：`36000`
- 用途：蓝盾 Stream YAML 中 `runs-on.self-hosted.pool-name: env` 的实际执行节点之一

约束：

- 不要把 SSH 密码、API token、kubeconfig、TCR 密码写入 Git。
- 远端机器上的 `/etc/lightclaw-ci/` 是 CI 本地 secret 优先读取目录；文件权限应为 `0600`。
- 如果本地 shell 能连 Git / TCR / EdgeOne，不代表 CI runner 也能连；发布问题优先到这台构建机核对运行时文件和网络。
- 远端修改 secret 后，只在日志里输出长度、trim 状态、hash fingerprint，不输出 secret 原文或前后缀。

## 本地 Secret 约定

CI runtime 会优先读取构建机本地文件，再回退到 Stream settings。

常用文件：

- `/etc/lightclaw-ci/git_woa_private_token`
- `/etc/lightclaw-ci/tcr_beijing_password`
- `/etc/lightclaw-ci/tcr_shprod_password`
- `/etc/lightclaw-ci/cloudflare_api_token`
- `/etc/lightclaw-ci/cloudflare_account_id`
- `/etc/lightclaw-ci/edgeone_lightvela_prod_token`
- `/etc/lightclaw-ci/edgeone_lightvela_intl_prod_token`
- `/etc/lightclaw-ci/kubeconfig_beijing_sandbox`
- `/etc/lightclaw-ci/kubeconfig_beijing_sandbox_2`
- `/etc/lightclaw-ci/kubeconfig_shprod`
- `/etc/lightclaw-ci/kubeconfig_singapore_sandbox`

`edgeone_lightvela_prod_token` 用于 `发布 frontend eo:cn-lightvela-prod`，应是 `lightvela` 正式项目可用的 EdgeOne Pages API token，不要复用 `lightvela-preview` 的预览 token。
`edgeone_lightvela_intl_prod_token` 用于 `发布 frontend eo:global-lightvela-intl-prod`，应是 `lightvela-intl` 正式项目可用的 EdgeOne Pages API token，发布产物来自国际版 `build:global` / `dist-global`。
`kubeconfig_*` 文件用于 DB-aware release gate 创建一次性 DB readiness / migration Job，文件权限必须是 `0600`，不要提交到 Git。

## Playground 环境创建提示词（P0）

当用户要求创建、修复或扩容 `sandbox-bj-N` / `beijing-playground` 环境时，先按本节执行，不要靠现场试错推进。

### 目标域名和 TLS 模型

默认域名模型：

- 固定 API 入口：`api-sandbox-bj-N.lightclaw.tech`
- 固定 Admin 入口：`admin-sandbox-bj-N.lightclaw.tech`
- 固定 frontend 入口：`frontend.sandbox-bj-N.lightclaw.tech`
- 可选环境首页：`sandbox-bj-N.lightclaw.tech`
- 实例 wildcard 入口：`*.sandbox-bj-N.lightclaw.tech`

TLS 约束：

- 固定入口使用单域名证书；不要假设免费 wildcard 证书可用。
- 实例 wildcard 入口默认 HTTP-only，除非已经有真实覆盖 `*.sandbox-bj-N.lightclaw.tech` 的付费或导入证书。
- 不允许复用不覆盖目标 host 的证书，例如 `*.sandbox.lightclaw.tech` 不能覆盖 `api-sandbox-bj-N.lightclaw.tech`、`frontend.sandbox-bj-N.lightclaw.tech` 或 `*.sandbox-bj-N.lightclaw.tech`。
- 写入或引用 TLS secret 前，必须确认候选证书 SAN 覆盖目标 host；不覆盖就不要绑定 TLS。

### GitOps-only 规则

- 长期配置必须通过 `gitops` MR 追踪；live patch、curl 或控制台操作只能用于诊断和临时解锁。
- 如果 live 诊断证明某个改动有效，必须立即把等价期望态反投影到 GitOps 文件。
- 创建新环境时优先使用 `.ci/runtime/commands/create_playground_environment.py` 生成 GitOps 渲染闭包，再人工/Agent 补齐不能稳定自动化的 DNS、证书和 SSM/SOPS 步骤。
- 克隆 SOPS secret 后必须解密校验 payload 的 env、DB name、Redis prefix、域名和 namespace，不要只看 metadata 或文件路径。

### Ingress / TKE 约束

- playground public ingress 默认应使用直连转发：`ingress.cloud.tencent.com/direct-access: "true"`。
- 适用对象包括 frontend、service-gateway、admin-gateway、sandbox ingressproxy 等公网入口。
- 如果 pod、Service endpoints 正常但公网 CLB 返回 504，优先对比 `direct-access`、TkeServiceConfig health check、NodePort/endpoints，而不是反复改证书。
- `400 invalid host` 对 wildcard HTTP 入口通常表示请求已经到达 ingressproxy，但实例 host 没有资源映射；这不是 DNS/CLB 不通。

### 建设顺序

1. 生成或克隆 GitOps closure：catalog、services、secrets、AppProject、必要 k8s overlay。
2. 运行 strict Kustomize 和 GitOps static validation。
3. 配置固定入口 DNS 和 wildcard HTTP DNS。
4. 为固定入口申请或选择单域名证书，并生成/引用正确 qcloud cert secret。
5. 合入 GitOps MR 后刷新 Argo，确认 apps 在最新 `gitops` revision 上 `Synced / Healthy`。
6. 确认 SOPS secret payload 已指向目标环境后，再执行 DB bootstrap / readiness / migration。
7. 检查 namespace pod Ready/Completed、Ingress Ready、Service endpoints。
8. 用公网 curl 验证固定 HTTPS 入口和 wildcard HTTP 入口。

### Agent 输出约定

创建 playground 环境时，Agent 必须明确打印：

- 本次环境名、namespace、固定入口域名、wildcard 域名。
- 哪些步骤已经进入 GitOps MR，哪些只是 live 诊断或人工外部动作。
- 证书是否覆盖目标 host；如果不覆盖，直接标记为不能使用。
- SOPS secret 是否复用源环境；如果复用，提示后续如需强隔离必须重新生成 SSM/SOPS。
- 最终验收证据：Argo revision、sync/health、pod 状态、Ingress 状态、公网 curl 结果。

## 远端写入模板

只在用户明确提供 secret 并要求写入构建机时执行：

```bash
printf '%s' "$SECRET_VALUE" | ssh -p 36000 root@9.208.245.238 '
  set -euo pipefail
  umask 077
  mkdir -p /etc/lightclaw-ci
  cat > /etc/lightclaw-ci/<secret-file>
  chmod 600 /etc/lightclaw-ci/<secret-file>
'
```

写入后用只读校验确认：

```bash
ssh -p 36000 root@9.208.245.238 'python3 - <<'"'"'PY'"'"'
import hashlib
from pathlib import Path
p = Path("/etc/lightclaw-ci/<secret-file>")
raw = p.read_text()
tok = raw.strip()
trimmed = "no" if raw == tok else "yes"
print(f"{p}: len={len(tok)} raw_len={len(raw)} trimmed={trimmed} fingerprint={hashlib.sha256(tok.encode()).hexdigest()[:12]} mode={oct(p.stat().st_mode & 0o777)}")
PY'
```
