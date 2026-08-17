# VelaChat 仓库协作约束

本文件适用于整个仓库。更深目录中的 `AGENTS.md` 可以增加该领域的约束；Backend 领域、
契约和数据库规则继续以 `backend/AGENTS.md` 为准。

## Git 与凭据

- 先读取当前 Git 状态；不得覆盖、回退或顺带提交他人的未完成改动。
- 不得提交 kubeconfig、Docker registry 凭据、邀请 token、IM 密钥或其他一次性材料。
- Mac 不依赖 Docker daemon。DevCloud 发布在 Mac 原生完成 Bun/Expo 编译，再通过 SSH
  把最小静态上下文交给 `root@9.134.208.109:36000` 的 Linux Docker builder；TCR 登录
  状态由 builder 自己持有。只有 Kubernetes 凭据通过显式 `--kubeconfig` 参数传入。
- 不要使用默认 kube context，也不要执行 `kubectl config use-context`。

## DevCloud Web 本地预览

唯一入口：

```bash
web/deploy/devcloud/release.sh preview
web/deploy/devcloud/release.sh preview --port 63886
web/deploy/devcloud/release.sh preview-stop
```

`preview` 在 Mac 上构建 Expo 生产静态产物，并用仓库内 Bun 静态服务器启动 `dist`。
它验证视觉、静态资源和 SPA fallback；本地预览不代理 `/v1`，不代表 API 联调环境。
`preview` 成功后以前台方式长驻；`preview-stop` 可从另一个终端停止脚本 PID 文件指向且
命令匹配预览服务器的进程。

## DevCloud Web 发布

正式命令：

```bash
web/deploy/devcloud/release.sh deploy --kubeconfig /absolute/path/to/dep.conf
```

前置条件：

- Git 工作区干净，当前 HEAD 已推送到 upstream；
- Mac 上 Bun、SSH、scp、tar、kubectl 和 curl 可用；
- `root@9.134.208.109:36000` 可免密登录，远端 Docker daemon 与 buildx 可用，并已登录
  `lightclaw-bj8.tencentcloudcr.com`；
- kubeconfig 能读取 `dep/raft-web-static` Deployment、Service 和 Pod。

脚本必须运行 Web 类型检查、全量测试、凭据扫描、生产导出和 SPA fallback 验证，使用
Git commit 生成不可变 TCR tag，再按真实 digest 更新 `raft-web-static`。发布成功必须同时
证明 Deployment generation/副本收敛、Pod Ready、零重启、运行 imageID 命中目标 digest，
通过 Service 验证 `/healthz-web`，并在目标 Pod 内验证深链接返回 HTML。Mac 直接访问内网
LoadBalancer 深链接可能被 AIO 转发层拒绝，不能用它误判 Pod。构建或推送成功不等于发布成功。

脚本顶层临时材料使用 `umask 077`，但 Expo/Bun 构建必须在 `umask 022` 子进程中运行，
确保 Nginx 非 root 用户能够读取静态目录和文件。

Deployment 切换后任一验收失败，脚本会恢复原镜像并重新验证原 Pod digest。不要绕开脚本
手工执行 `kubectl set image`；若脚本失败，应先保留输出和当前 live 镜像再诊断。

## Computer 双平台发布

Computer release 的正式入口：

```bash
backend/scripts/deploy-computer-canary.sh \
  --kubeconfig /absolute/path/to/dep.conf \
  --agent-source /absolute/path/to/velachat/agent \
  --version vX.Y.Z \
  --signing-key-id UNIQUE_KEY_ID \
  --signing-private-key /secure/path/release.private \
  --signing-public-key /secure/path/release.public \
  --release-output /absolute/path/to/release-evidence
```

脚本在 Mac 原生构建 `darwin-arm64`，通过 `root@9.134.208.109:36000` 的独立、固定
BuildKit image Buildx builder 构建 Rust TAT + Go CGO `linux-amd64`；不依赖 Mac Docker daemon。
两个 target 缺一不可发布。脚本生成 target-local manifest/signature，独立验签，create-only 发布
COS，保存 Buildx metadata，再创建不可变 Release Set ConfigMap 并切换 3 副本 Canary。

首次从单 target catalog 升级时，必须先部署能兼容读取旧 catalog 的新版 Backend、应用新增 migration，
并在旧 ConfigMap 上证明 3/3 Ready；之后才运行上述脚本切双 target catalog。回滚顺序相反：先恢复旧
ConfigMap并确认 Ready，再回滚旧 Backend image。不得让旧 Backend 读取新 Release Set schema。
