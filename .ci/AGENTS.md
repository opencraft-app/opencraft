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

### 蓝盾 stage `if` 实测规则

当前 Devcloud / 蓝盾 Stream 平台上，stage 级 `if` 不要按 GitHub Actions 的“完整表达式求值”模型理解。
本仓库通过 `.ci/stage-if-probe.yml` 在 live 蓝盾中实测过：

- 能命中：`if: "${{ variables.PIPELINE_MODE }} == build"`
- 能命中：`if: "${{ ci.branch }} == master"`
- 能命中：`if: "${{ variables.PIPELINE_MODE }} == build && ${{ ci.branch }} == master"`
- 会被跳过：`if: "variables.PIPELINE_MODE == 'build'"`
- 会被跳过：`if: "ci.branch == 'master'"`
- 会被跳过：`if: "${{ variables.PIPELINE_MODE == 'build' }}"`
- 会被跳过：`if: "${{ variables.PIPELINE_MODE == 'build' && ci.branch == 'master' }}"`

也就是说，stage `if` 的可靠写法是“先用 `${{ ... }}` 插值出值，再做字符串比较”：

```yaml
if: "${{ parameters.ENABLE_MASTER_PROD_PROMOTE }} == true && ${{ variables.PIPELINE_MODE }} == build && ${{ ci.branch }} == master"
```

不要写成下面两类形式：

```yaml
# 不可靠：裸表达式不会按预期解析
if: "variables.PIPELINE_MODE == 'build' && ci.branch == 'master'"

# 不可靠：整块布尔表达式不会按预期变成 true/false gate
if: "${{ variables.PIPELINE_MODE == 'build' && ci.branch == 'master' }}"
```

工程约束：

- stage `if` 只用于 UI 可见性和减少无意义阶段；不能作为发布安全边界。
- 关键发布步骤必须继续在 shell 脚本里做 guard，例如检查 `PIPELINE_MODE`、`ci.branch`、目标环境白名单。
- 审核说明里的 `${{ ... }}` 也会参与模板/运行时替换；不要在说明文本里放未验证的表达式样例。需要展示样例时，用静态文字或拆开写成 `$ {{ ... }}`。
- 如果要改 stage `if` 语法，先更新并运行 `.ci/stage-if-probe.yml`，用 live 蓝盾结果验证后再改正式流水线模板。
- 不要用 stage `if` 直接判断逗号/冒号组成的矩阵字符串是否等于或不等于某个值。`FRONTEND_EDGEONE_RELEASE_MATRIX != none`
  这类条件在探针里无法给出干净的反向验证；正式流水线应使用简单布尔开关控制 stage 可见性，再在 shell 里校验矩阵白名单。
- 不要把 `manualReviewUserTask@1.*` 当作 job step 级人工审核来嵌入 Stream YAML DAG：
  - 放在 `runs-on.self-hosted.pool-name: env` 下，live run 会报“插件不能在该环境下运行”。
  - 放在 `runs-on: agentless` 下，live run 仍会按市场插件执行，并在 `MarketAtomTask.getAtomExecuteFile` 触发 NPE。
  - `can-pause-before-run` / `pause-notice-receivers` 是 v3 step 字段；当前 `version: v2.0` Stream YAML 会报 schema invalid，不要写进 v2 正式流水线。
  - 当前已验证可用的 YAML 审核面仍是 stage 级 `check-in`。如果需要国内/国际正式站独立审批，不要在编排流水线里加共享 `check-in`；编排流水线只做 job DAG fan-out，两个正式站自己的独立审批保留在各自发布流水线里。
  - `check-in.reviews.flows[*].reviewers` 不能写空数组。live 保存会失败并提示“审核组没有未配置可执行人”。当前 `version: v2.0` 转换路径也不支持可靠的 `groups` 字段；需要配置明确 reviewer 后再用 live 探针验证。
  - 调整 frontend EdgeOne 编排流水线前，优先用 `.ci/frontend-edgeone-orchestrator-probe.yml` 验证 job fan-out。该探针默认 `PROBE_APPLY=false`，只 dry-run 目标发布调用。

### GitOps promote runtime 模型

生产 promote 不是普通“脚本读仓库然后退出”的模型。`.ci/runtime/pin_image_to_gitops.sh` 会在当前 CI checkout 里执行：

```bash
git -C "$REPO_ROOT" checkout -B "$PROMOTE_BRANCH" "$REMOTE_NAME/$GITOPS_BRANCH"
```

也就是说，调用它之后，当前工作树会从 `master` 变成 `gitops` / `promote-*` 分支内容。这个副作用是有意的：后续要在同一个工作树里投影 deploy-facing 文件、更新 image pin、提交并 push promote 分支。

踩坑结论：

- 不要假设调用 `pin_image_to_gitops.sh` 之后，`$PWD/.ci/runtime` 或 `$REPO_ROOT/.ci/runtime` 仍然存在。
- 不要在同一个 shell loop 里第一次 promote 后，再用相对路径调用 `.ci/runtime/...`；生产 shprod/sgprod fan-out 会直接失败。
- 不要把 runtime 脚本的“代码位置”和“目标仓库位置”混成一个概念。
- runtime 代码位置应该来自脚本自身目录，例如 `SCRIPT_DIR` / `RUNTIME_COMMAND_DIR`。
- 真实 Git 仓库位置应该来自外部继承的 `REPO_ROOT`，用于 `git -C "$REPO_ROOT"`、读取 source-facing / deploy-facing 数据、执行 checkout。
- 从临时 runtime snapshot 运行脚本时，子脚本必须尊重外部 `REPO_ROOT`，不能重新按自身路径推导仓库根目录。
- `CI_RUNTIME_REF` / `CI_RUNTIME_COMMIT` 必须在第一次 checkout 到 GitOps/promote 分支之前冻结并 export；否则 shprod/sgprod fan-out 第二轮会把上一轮 promote 分支提交写进 `Release-runtime-*`，导致后续 `.ci/init.sh` 不存在。
- `promote-*` CI 的第一段 bootstrap 来自 `gitops` 分支 seed 文件，不是 master。修改 `.ci/gitops-promotion.yml` 或 `.ci/runtime/gitops_promotion_bootstrap.sh` 后，除了合入 master，还必须把这两个 seed 文件同步到 `gitops`，否则 retry 旧 promote CI 仍然使用旧 bootstrap。

当前推荐模式：

```bash
source .ci/init.sh
ci_init_repo_root

RUNTIME_SNAPSHOT="$(mktemp -d)"
trap 'rm -rf "$RUNTIME_SNAPSHOT"' EXIT
mkdir -p "$RUNTIME_SNAPSHOT/.ci"
cp "$REPO_ROOT/.ci/init.sh" "$RUNTIME_SNAPSHOT/.ci/init.sh"
cp -R "$REPO_ROOT/.ci/runtime" "$RUNTIME_SNAPSHOT/.ci/runtime"

PROMOTE_BUNDLE_SCRIPT="$RUNTIME_SNAPSHOT/.ci/runtime/promote_bundle_image_to_gitops.sh"
bash "$PROMOTE_BUNDLE_SCRIPT" "$SERVICE" "$BUNDLE" "$TARGET_ENV" "$SOURCE_SHA"
```

等价公共函数写法：

```bash
RUNTIME_SNAPSHOT="$(ci_create_runtime_snapshot "$REPO_ROOT/.ci")"
trap 'rm -rf "$RUNTIME_SNAPSHOT"' EXIT
```

连续 fan-out 前还要固定 runtime 元数据：

```bash
CI_RUNTIME_REF="${CI_RUNTIME_REF:-$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)}"
CI_RUNTIME_COMMIT="${CI_RUNTIME_COMMIT:-$(git -C "$REPO_ROOT" rev-parse HEAD)}"
export CI_RUNTIME_REF CI_RUNTIME_COMMIT
```

脚本内部应遵守：

```bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="${REPO_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
CI_INIT_SCRIPT="${CI_INIT_SCRIPT:-$SCRIPT_DIR/../init.sh}"
source "$CI_INIT_SCRIPT"
RUNTIME_COMMAND_DIR="${RUNTIME_COMMAND_DIR:-$SCRIPT_DIR/commands}"
```

边界解释：

- `SCRIPT_DIR` / `RUNTIME_COMMAND_DIR`：找当前 runtime 代码，必须允许来自临时 snapshot。
- `CI_INIT_SCRIPT`：找当前 runtime 配套的 `.ci/init.sh`，必须来自 snapshot；不要在 fan-out 的第二次 promote 里回到已被 checkout 成 `promote-*` 的 `$REPO_ROOT/.ci/init.sh`。
- `REPO_ROOT`：指向蓝盾 checkout 的真实仓库，哪怕它稍后被切到 `promote-*` 分支。
- `PIN_SCRIPT` 默认应优先使用 runtime snapshot 旁边的 `pin_image_to_gitops.sh`，不要回到 mutable worktree 找脚本。
- `pin_image_to_gitops.sh` 内部再次 materialize runtime 时，也必须从自身 `SCRIPT_DIR` 复制 runtime，不能从 `$REPO_ROOT/.ci/runtime` 复制。
- 需要连续创建 shprod、sgprod promote 分支时，必须在第一次 checkout 之前准备好 runtime snapshot。
- `build_and_promote_to_gitops.sh` 的 auto-pin 常常只处理一个自动环境，所以不容易暴露这个问题；但如果以后配置多个 auto-pin 环境，也必须复用同一套 runtime snapshot 模型。

测试约束：

- 修改 `pin_image_to_gitops.sh`、`promote_bundle_image_to_gitops.sh`、`.ci/templates/service-release.yml` 后，至少运行：

```bash
python3 -m unittest discover -s .ci/runtime/tests/gitops_tests -p test_gitops_promotion_workflow.py
python3 -m unittest discover -s .ci/runtime/tests/contract_tests -p test_release_bundle_contracts.py
bash .ci/runtime/check_ci_runtime.sh
```

触发约束：

- 业务流水线不会因为 `.ci/**` 变更自动触发；这是 contract 保护。
- 如果修复的是通用 runtime/template，但需要验证某个业务流水线，必须额外改该业务监听路径内的 no-op 文件，例如 `gateway-dashboard/README.md`。
- 不要把 `.ci/**` 加回业务流水线 `on.push.paths`，否则 CI runtime 变更会触发所有业务构建。

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
- `/etc/lightclaw-ci/tcr_sgprod_password`
- `/etc/lightclaw-ci/cloudflare_api_token`
- `/etc/lightclaw-ci/cloudflare_account_id`
- `/etc/lightclaw-ci/edgeone_lightvela_prod_token`
- `/etc/lightclaw-ci/edgeone_lightvela_intl_prod_token`
- `/etc/lightclaw-ci/kubeconfig_beijing_sandbox`
- `/etc/lightclaw-ci/kubeconfig_beijing_sandbox_2`
- `/etc/lightclaw-ci/kubeconfig_shprod`
- `/etc/lightclaw-ci/kubeconfig_sgprod`
- `/etc/lightclaw-ci/kubeconfig_singapore_sandbox`
- `/etc/lightclaw-ci/tencentcloud_secret_id`
- `/etc/lightclaw-ci/tencentcloud_secret_key`

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
- 创建新环境时优先使用 `.ci/runtime/create_playground_from_gitops.sh --to-env sandbox-bj-N` 生成 GitOps 渲染闭包；不要在 `master` 源码 checkout 里直接跑默认命令，因为 playground 模板只在 `origin/gitops`。
- 默认模板源是 `sandbox-bj-5`，因为它包含 frontend closure；除非明确需要排查历史差异，否则不要用 `sandbox-bj-3` 作为新环境模板源。
- 已经在持久 GitOps worktree 内操作时，才直接使用 `.ci/runtime/commands/create_playground_environment.py --repo-root <gitops-worktree>`；再人工/Agent 补齐不能稳定自动化的 DNS、证书和 SSM/SOPS 步骤。
- 克隆 SOPS secret 后必须解密校验 payload 的 env、DB name、Redis prefix、域名和 namespace，不要只看 metadata 或文件路径。
- playground 的 MySQL/Redis 必须优先使用 namespace-local `StatefulSet + PVC`，由 `env-bootstrap` app 纳入 GitOps；业务配置应指向 `mysql.<namespace>.svc.cluster.local` 和 `redis.<namespace>.svc.cluster.local:6379`。
- 新建 `sandbox-bj-N` 时必须生成目标环境独立的 `argocd/secrets/<env>/playground-runtime-secrets.sops.yaml`，只包含 `MYSQL_ROOT_PASSWORD` / `REDIS_PASSWORD`；缺少 `sops` 或 age key 时直接失败，不允许明文 fallback。
- MySQL/Redis StatefulSet 和 DB bootstrap/root 路径只能引用 `playground-runtime-secrets`；业务 grant password 仍可来自各服务自己的 SOPS secret，但不能把 `lightclaw-auth-secrets` / `sandbox-runtime-secrets` 继续作为运行时 root secret。
- playground 销毁默认以删除 catalog/closure 为主，让 Argo prune namespace 内 MySQL/Redis/PVC；不要再把 playground 运行时状态放到共享外部 MySQL/Redis，除非明确需要跨环境保留数据。

### Frontend 镜像规则

- `argocd/services/frontend/<env>/frontend-platform.env` 里的 `FRONTEND_IMAGE` 必须先在 TCR 中真实存在，再让 Argo 收敛；否则会表现为 `frontend-web ImagePullBackOff`。
- 正常路径是为目标环境构建并推送目标 tag，例如 `frontend-sandbox-bj-N-<source-sha>`，不要把缺失镜像留给 Argo 暴露。
- 只在满足全部条件时允许 retag 解锁 live：目标 tag 缺失、同 registry 中存在同 source sha 的等价 tag、只是环境名 tag 缺失、没有 frontend 代码或构建参数差异。
- retag 是现场解锁动作，不是发布真相源；执行后必须记录来源 tag、目标 tag、digest，并补齐后续 CI/脚手架缺口。
- 不允许用 retag 掩盖构建失败。如果源码、`VITE_*` 构建参数、Dockerfile、lockfile 或静态资源入口存在差异，必须重新构建目标 env 镜像。

### Ingress / TKE 约束

- playground public ingress 默认应使用直连转发：`ingress.cloud.tencent.com/direct-access: "true"`。
- 适用对象包括 frontend、service-gateway、admin-gateway、sandbox ingressproxy 等公网入口。
- 如果 pod、Service endpoints 正常但公网 CLB 返回 504，优先对比 `direct-access`、TkeServiceConfig health check、NodePort/endpoints，而不是反复改证书。
- `400 invalid host` 对 wildcard HTTP 入口通常表示请求已经到达 ingressproxy，但实例 host 没有资源映射；这不是 DNS/CLB 不通。

### 建设顺序

1. 生成或克隆 GitOps closure：catalog、services、secrets、AppProject、必要 k8s overlay，以及 env-bootstrap 内的 MySQL/Redis StatefulSet/PVC。
2. 运行 strict Kustomize 和 GitOps static validation。
3. 配置固定入口 DNS 和 wildcard HTTP DNS。
4. 为固定入口申请或选择单域名证书，并生成/引用正确 qcloud cert secret。
5. 合入 GitOps MR 后刷新 Argo，确认 apps 在最新 `gitops` revision 上 `Synced / Healthy`。
6. 确认 frontend 目标镜像 tag 已存在；缺 tag 时优先补构建，只有同 source sha 等价 tag 已存在时才允许 retag 解锁。
7. 确认 namespace-local MySQL/Redis Ready，且 `playground-runtime-secrets` 已生成并由 env-bootstrap ksops generator 引入后，再执行 DB bootstrap / readiness / migration。
8. 检查 namespace pod Ready/Completed、Ingress Ready、Service endpoints。
9. 用公网 curl 验证固定 HTTPS 入口和 wildcard HTTP 入口。

### Agent 输出约定

创建 playground 环境时，Agent 必须明确打印：

- 本次环境名、namespace、固定入口域名、wildcard 域名。
- 哪些步骤已经进入 GitOps MR，哪些只是 live 诊断或人工外部动作。
- 证书是否覆盖目标 host；如果不覆盖，直接标记为不能使用。
- SOPS secret 是否复用源环境；如果复用，提示后续如需强隔离必须重新生成 SSM/SOPS。
- 是否生成了新的最小 `playground-runtime-secrets`；如果缺 SOPS/age key，必须停止而不是提交半成品。
- MySQL/Redis 是否由目标 namespace 内 StatefulSet/PVC 承载；如果仍指向外部共享地址，必须标记为不符合 playground 模型。
- frontend 目标镜像 tag 是否存在；如果执行过 retag，必须说明为什么不构建、来源 tag、目标 tag 和 digest。
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
