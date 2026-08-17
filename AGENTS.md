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
证明 rollout 完成、Pod Ready、零重启、运行 imageID 命中目标 digest，并且
`/healthz-web` 和深链接返回正常。构建或推送成功不等于发布成功。

Deployment 切换后任一验收失败，脚本会恢复原镜像并重新验证原 Pod digest。不要绕开脚本
手工执行 `kubectl set image`；若脚本失败，应先保留输出和当前 live 镜像再诊断。
