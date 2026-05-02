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
- root `extends` 的 path-based 模板实例变量使用 `extends.template.variables`；不要凭样例里的 `extends.parameters` 直接套用。
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
