# DevCloud Web 发布与本地预览脚本设计

## 背景与目标

VelaChat Web 当前可以通过 Expo 导出、Nginx 静态镜像和 DevCloud 中的
`dep/raft-web-static` 工作负载运行。2026-08-17 的 live 核验确认 Deployment 与
LoadBalancer Service 均名为 `raft-web-static`，容器名为 `static`，当前为单副本 Ready、
零重启。发布步骤仍依赖临时命令。目标是把本地预览、
不可变镜像构建、TCR 推送、Kubernetes 切换和真实运行验证收敛到一个可审计脚本，
并新增仓库根 `AGENTS.md` 固化唯一用法。现有 `backend/AGENTS.md` 继续约束 Backend；
根文件负责跨目录发布入口和凭据边界，不复制 Backend 的领域规则。

本轮只管理 Web 静态工作负载，不发布 Backend、Computer 或 Agent，也不建立集群内
BuildKit。Bun/Expo 编译在本地 Mac 原生完成；Mac 不依赖 Docker daemon。Linux 镜像包装
与 TCR 推送由既有内网主机 `root@9.134.208.109:36000` 完成。

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

`preview` 与 `deploy` 必须使用同一次 Expo 静态导出规则。预览不是 Expo 开发服务器，
而是 Bun 直接托管生产 `dist`；发布镜像再使用 `web/deploy/devcloud/Dockerfile` 包装同一
份 `dist`。

## 本地预览

`preview` 执行：

1. 校验 `bun` 和 `curl`；
2. 执行客户端类型检查和 `bun run --cwd web build:web`；
3. 使用仓库内 Bun 静态预览服务器托管 `apps/client/dist`；
4. 只替换脚本 PID 文件指向且命令匹配的预览进程；
5. 监听 `127.0.0.1:<port>`；
6. 轮询 `/healthz-web`，成功后打印预览 URL。

`preview` 健康检查成功后以前台方式长驻。`preview-stop` 只停止 PID 文件指向且命令匹配的
预览进程。重复执行 `preview` 是幂等的；端口被其他进程占用时必须失败，不得杀死未知进程。

预览保证静态产物和 SPA fallback 与发布输入一致，不冒充 Nginx 运行时验收；Nginx 本身在
远端构建后的镜像与 live Service 中验证。当前 DevCloud `/v1/` upstream 只在集群内可用，
因此本地预览明确返回不可用，不冒充完整本地联调环境。

## DevCloud 发布

`deploy` 执行以下门禁和状态转换：

1. 强制 Git 工作区无已修改、已暂存或未跟踪文件；
2. 读取当前分支的 upstream，执行 fetch，并要求 `HEAD` 与 upstream 完全相等；
3. 要求 `--kubeconfig` 是存在的绝对路径，所有 `kubectl` 命令显式携带该路径；
4. 依次执行 `bun run --cwd web typecheck`、`bun run --cwd web test`、
   `bun run --cwd web security:scan`、`bun run --cwd web build:web` 和
   `bun run --cwd web/apps/client verify:web-fallback`，不把当前测试套件数量写成稳定合同；
   发布脚本本身保持 `umask 077`，但这些构建命令必须在 `umask 022` 子进程中执行，保证
   Nginx 非 root 用户可读取 `dist`；
5. 以完整 Git SHA 的前 12 位作为不可变 TCR tag；若远端 tag 已存在则拒绝覆盖；
6. Mac 只把 Dockerfile、Nginx 配置和已生成的 `dist` 组成最小 tar，通过 SSH/scp 发送给
   内网 Linux builder；builder 在临时目录中以 `deploy/devcloud/Dockerfile` 为 Dockerfile，
   通过 `docker buildx build --platform linux/amd64 --push` 构建镜像并在结束时删除上下文；
7. 从 TCR 读取真实 `sha256` digest，后续只按 digest 发布；
8. 读取 `dep/raft-web-static` 中 `static` 容器的原镜像并确认当前副本可用；
9. 将 Deployment 精确切换到新 digest，通过轮询 generation、updated/ready/available
   replicas 和目标容器镜像等待收敛；不使用在当前 DevCloud API 上会卡住的 watch；
10. 验证单副本 Ready、零重启、运行时 `imageID` 包含目标 digest；
11. 通过 Service 入口请求 `/healthz-web`，再在目标 Ready Pod 内请求一个深链接确认 Nginx
    返回 SPA HTML；Mac 直连内网 LoadBalancer 深链接可能被 AIO 转发层返回 403，不能将该
    代理行为误判为 Pod 失败。成功后输出 commit、tag 和 digest。

脚本默认值为：

- registry：`lightclaw-bj8.tencentcloudcr.com/lightclaw/vela-platform-web`
- namespace：`dep`
- deployment：`raft-web-static`
- container：`static`
- service：`raft-web-static`

这些值允许用显式参数覆盖，便于环境迁移，但脚本不读取或切换用户的默认 kube
context。

仓库 `web/deploy/devcloud/static.yaml` 已与 2026-08-17 live `raft-web-static` 的
Deployment、Service、selector 和 label 对齐。每次发布仍必须重新读取显式 kubeconfig
下的 live 对象；若对象不存在或容器/selector 不符合合同，发布前失败，不自动创建或
猜测名称。

## 凭据边界

只有 Kubernetes 凭据通过 `--kubeconfig` 显式传入。TCR 使用内网 Linux builder 自己的
Docker credential store，Mac 不读取或传输 registry 凭据。脚本不得：

- 接收、打印、复制或提交 TCR 密码；
- 从 Kubernetes Secret 提取 registry 凭据；
- 将 kubeconfig 路径硬编码为个人目录；
- 执行 `kubectl config use-context`；
- 从 Mac 把凭据传输到远端构建机。

## 失败与回滚

任何发布前门禁失败都不修改集群。Deployment 切换后若 rollout、Pod digest 或健康
检查失败，退出 trap 必须恢复原镜像、轮询恢复收敛，并再次验证恢复 Pod Ready、
零重启且 `imageID` 对应原 digest。回滚本身失败时，需要同时报告发布错误与当前
Deployment 镜像，不能声称已经恢复。

成功后不自动删除旧镜像，也不修改仓库中的静态清单 digest；镜像保留和 GitOps
迁移属于后续工作。

## 测试与文档门禁

新增脚本合同测试并纳入客户端 Jest：

- `/bin/sh -n` 语法通过；
- `--help`、`preview`、`preview-stop`、`deploy` 入口存在；
- 发布脚本包含 clean/upstream、不可变 tag、digest、rollout、runtime imageID、健康检查
  和失败回滚合同；
- 禁止 `kubectl config use-context`、registry 密码参数和无 digest 发布；
- 根 `AGENTS.md` 必须记录完整命令、前置条件和发布后验收方式；
- 测试必须锁定从 `web/` context 使用 `deploy/devcloud/Dockerfile`，并要求执行
  `verify:web-fallback` 或等价 SPA 深链接验证。

实现完成后至少执行客户端类型检查、全量 Jest、Web 导出、SPA fallback、脚本凭据扫描和
`git diff --check`。真实发布还必须用 live Deployment、Pod imageID 和健康端点证明完成，
不能只以镜像构建或 `kubectl set image` 成功作为发布结论。
