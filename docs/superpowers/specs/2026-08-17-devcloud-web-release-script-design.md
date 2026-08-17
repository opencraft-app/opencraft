# DevCloud Web 发布与本地预览脚本设计

## 背景与目标

VelaChat Web 当前可以通过 Expo 导出、Nginx 静态镜像和 DevCloud 中的
`dep/raft-web-static` 工作负载运行，但发布步骤仍依赖临时命令。目标是把本地预览、
不可变镜像构建、TCR 推送、Kubernetes 切换和真实运行验证收敛到一个可审计脚本，
并在仓库根 `AGENTS.md` 固化唯一用法。

本轮只管理 Web 静态工作负载，不发布 Backend、Computer 或 Agent，也不建立集群内
BuildKit。构建在本地 Mac 完成。

## 入口与命令

新增可执行脚本：

```text
web/deploy/devcloud/release.sh
```

它提供三个子命令：

```bash
./web/deploy/devcloud/release.sh preview [--port 63886]
./web/deploy/devcloud/release.sh preview-stop
./web/deploy/devcloud/release.sh deploy \
  --kubeconfig /absolute/path/to/dep.conf
```

`preview` 与 `deploy` 必须使用同一份 `web/deploy/devcloud/Dockerfile` 和同一次 Expo
静态导出规则。预览不是 Expo 开发服务器，而是本地 Nginx 容器中的生产静态产物。

## 本地预览

`preview` 执行：

1. 校验 `npm`、`docker` 和 `curl`；
2. 执行客户端类型检查和 `npm run build:web`；
3. 使用 DevCloud Dockerfile 构建本机平台预览镜像；
4. 只替换脚本拥有的固定预览容器 `vela-web-devcloud-preview`；
5. 将容器 `8080` 映射到 `127.0.0.1:<port>`；
6. 轮询 `/healthz-web`，成功后打印预览 URL。

`preview-stop` 只停止并删除该固定预览容器，不影响其他容器或镜像。重复执行
`preview` 是幂等的；端口被其他进程占用时必须失败，不得杀死未知进程。

## DevCloud 发布

`deploy` 执行以下门禁和状态转换：

1. 强制 Git 工作区无已修改、已暂存或未跟踪文件；
2. 读取当前分支的 upstream，执行 fetch，并要求 `HEAD` 与 upstream 完全相等；
3. 要求 `--kubeconfig` 是存在的绝对路径，所有 `kubectl` 命令显式携带该路径；
4. 执行 Web 类型检查、91 套 Jest 测试、凭据扫描和生产静态导出；
5. 以完整 Git SHA 的前 12 位作为不可变 TCR tag；若远端 tag 已存在则拒绝覆盖；
6. 在 Mac 上通过 `docker buildx build --platform linux/amd64 --push` 构建镜像；
7. 从 TCR 读取真实 `sha256` digest，后续只按 digest 发布；
8. 读取 `dep/raft-web-static` 中 `static` 容器的原镜像并确认当前副本可用；
9. 将 Deployment 精确切换到新 digest，等待 rollout；
10. 验证单副本 Ready、零重启、运行时 `imageID` 包含目标 digest；
11. 通过 Service 入口请求 `/healthz-web`，成功后输出 commit、tag 和 digest。

脚本默认值为：

- registry：`lightclaw-bj8.tencentcloudcr.com/lightclaw/vela-platform-web`
- namespace：`dep`
- deployment：`raft-web-static`
- container：`static`
- service：`raft-web-static`

这些值允许用显式参数覆盖，便于环境迁移，但脚本不读取或切换用户的默认 kube
context。

## 凭据边界

只有 Kubernetes 凭据通过 `--kubeconfig` 显式传入。TCR 使用 Mac 当前 Docker
credential store / `~/.docker/config.json` 的既有登录状态。脚本不得：

- 接收、打印、复制或提交 TCR 密码；
- 从 Kubernetes Secret 提取 registry 凭据；
- 将 kubeconfig 路径硬编码为个人目录；
- 执行 `kubectl config use-context`；
- 把凭据传输到远端构建机。

## 失败与回滚

任何发布前门禁失败都不修改集群。Deployment 切换后若 rollout、Pod digest 或健康
检查失败，退出 trap 必须恢复原镜像并等待恢复 rollout。回滚本身失败时，需要同时
报告发布错误与当前 Deployment 镜像，不能声称已经恢复。

成功后不自动删除旧镜像，也不修改仓库中的静态清单 digest；镜像保留和 GitOps
迁移属于后续工作。

## 测试与文档门禁

新增脚本合同测试并纳入客户端 Jest：

- `/bin/sh -n` 语法通过；
- `--help`、`preview`、`preview-stop`、`deploy` 入口存在；
- 发布脚本包含 clean/upstream、不可变 tag、digest、rollout、runtime imageID、健康检查
  和失败回滚合同；
- 禁止 `kubectl config use-context`、registry 密码参数和无 digest 发布；
- 根 `AGENTS.md` 必须记录完整命令、前置条件和发布后验收方式。

实现完成后至少执行客户端类型检查、全量 Jest、Web 导出、脚本凭据扫描和
`git diff --check`。真实发布还必须用 live Deployment、Pod imageID 和健康端点证明完成，
不能只以镜像构建或 `kubectl set image` 成功作为发布结论。
