# 独立 k3s Web 发布运行手册

本手册保存当前易变的发布运行事实。长期架构、组件边界和通用门禁见仓库根 `AGENTS.md`。

## 当前目标

- SSH：`root@21.91.75.85:36000`，只允许已配置公钥登录；
- k3s：`v1.34.10+k3s1`，单节点、内置 containerd；
- Namespace：`dep`；
- Web Deployment：`raft-web-static`，1 副本；
- Backend Deployment：`chatserver-canary`，1 副本；
- Web Service：ClusterIP，Pod 通过 hostPort 80 对外；
- Backend Service：ClusterIP；
- Nginx 配置：ConfigMap `raft-web-static-nginx`；
- 用户入口：`http://21.91.75.85`；
- Web image repository：`lightclaw-bj8.tencentcloudcr.com/lightclaw/vela-platform-web`。

这些值每次发布前都必须从 live 主机重新核对；本文件不是集群状态缓存。

## 发布范围

本手册只发布 Expo Web 静态镜像，不发布 Backend、Computer 或 TUI：

- Web：新 OCI digest 切换到 `raft-web-static`；
- TUI：必须另行生成 bundle，并随新的 `vela-computer` 发布；
- Backend：使用独立 Backend 发布/迁移流程；
- Computer catalog：使用独立双 target 签名发布流程。

不要因为 Web 页面包含新 TUI 源码就声称已安装的 Computer TUI 已升级。

## 1. Git 与主机预检

在干净 worktree 中：

```bash
git fetch origin
git status --short
git rev-parse HEAD
git rev-parse origin/master
```

要求：工作区干净，HEAD 等于 `origin/master`，该 commit 已推送且不可再修改历史。

检查主机和 live workload：

```bash
ssh -o BatchMode=yes -p 36000 root@21.91.75.85 '
  set -eu
  k3s --version
  k3s kubectl get node -o wide
  k3s kubectl -n dep get deployment raft-web-static chatserver-canary
  k3s kubectl -n dep get pods -o wide
'
```

发布前 Web 与 Backend 都必须 1/1 Ready；不要在 Backend 已失效时用 Web 发布掩盖故障。

## 2. Mac 原生门禁与 Expo 导出

```bash
cd web
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run security:scan
bun run --cwd apps/client check:tui
bun run --cwd apps/client test:tui
bun run --cwd apps/client test:tui-build
bun run --cwd apps/client build:web
bun run --cwd apps/client verify:web-fallback
```

确认 `web/apps/client/dist/` 可读且只来自当前 commit。顶层临时/凭据材料使用 `umask 077`；Expo/Bun 构建
子进程和静态文件使用 `umask 022`，否则 Nginx 非 root 用户可能无法读取。

## 3. 构建并推送不可变 Web 镜像

Mac 不运行 Docker。使用授权 Linux builder，只发送最小静态上下文：静态 Nginx Dockerfile/config 与
`web/apps/client/dist/`。可用下面命令定位仓库内静态镜像入口，但不要从目录名推断发布目标：

```bash
rg --files web/deploy -g Dockerfile -g nginx.conf
```

镜像 tag 使用完整 Git commit 的短前缀，仅用于定位；live 部署必须使用 push 返回的真实 digest：

```text
lightclaw-bj8.tencentcloudcr.com/lightclaw/vela-platform-web@sha256:<64 hex>
```

发布记录至少保存 commit、tag、local image ID、registry digest、构建时间和构建日志位置。Registry 登录状态由
builder 自己持有，不能把 Registry 密码从 builder 导出到 Mac 或仓库。

当前仓库尚未提供 k3s 一键 build/push 工具。下一次正式发布前，优先实现并审查
`web/deploy/k3s/release.sh`；它必须覆盖本手册的 preflight、测试、build、push、digest、rollback 和验收。

## 4. Digest 切换

在 SSH 主机上先保存当前不可变 image，再切换目标 digest：

```bash
release_image='lightclaw-bj8.tencentcloudcr.com/lightclaw/vela-platform-web@sha256:<64 hex>'
printf '%s\n' "$release_image" | grep -Eq \
  '^lightclaw-bj8\.tencentcloudcr\.com/lightclaw/vela-platform-web@sha256:[0-9a-f]{64}$' || {
  echo 'invalid immutable image' >&2
  exit 2
}

previous_image=$(k3s kubectl -n dep get deployment raft-web-static \
  -o jsonpath='{.spec.template.spec.containers[?(@.name=="static")].image}')
printf '%s\n' "$previous_image" | grep -Eq '@sha256:[0-9a-f]{64}$' || {
  echo 'live image is not immutable' >&2
  exit 2
}

k3s kubectl -n dep set image deployment/raft-web-static "static=$release_image"
```

不要修改副本数、hostPort、Service 类型、toleration 或 Nginx ConfigMap 来帮助 rollout“通过”。

## 5. Rollout 与 Pod 验收

避免仅依赖可能丢 bookmark 的 watch。轮询 Deployment JSON，并要求：

```text
metadata.generation == status.observedGeneration
spec.replicas == 1
status.updatedReplicas == 1
status.readyReplicas == 1
status.availableReplicas == 1
status.unavailableReplicas == 0
```

随后验证唯一 Pod：

```bash
k3s kubectl -n dep get pods -l app.kubernetes.io/name=raft-web-static -o wide
k3s kubectl -n dep get pods -l app.kubernetes.io/name=raft-web-static \
  -o jsonpath='{range .items[*]}{.status.phase}{" "}{.status.containerStatuses[0].ready}{" "}{.status.containerStatuses[0].restartCount}{" "}{.status.containerStatuses[0].imageID}{"\n"}{end}'
```

要求 Running、Ready、restartCount=0，且 imageID 精确命中目标 digest。

## 6. 外部 HTTP 与浏览器验收

从 Mac 验证：

```bash
curl -fsS http://21.91.75.85/ >/dev/null
curl -fsS http://21.91.75.85/healthz-web >/dev/null
curl -fsS http://21.91.75.85/healthz >/dev/null
curl -fsS http://21.91.75.85/readyz >/dev/null
curl -fsS http://21.91.75.85/install >/dev/null
test "$(curl -sS -o /dev/null -w '%{http_code}' http://21.91.75.85/v1/me)" = 401
```

确认 `/` 是 `text/html`，深链接走 SPA fallback，静态 hash 资源可读取。涉及 UI 结构、密度或材质时，运行
Style Lab 浏览器门禁；Floating Header 变更示例：

```bash
bun web/apps/client/tools/verify-floating-primary-header-layout.ts \
  --url http://21.91.75.85 \
  --evidence /secure/absolute/evidence/pointer \
  --expected-header-height 52

bun web/apps/client/tools/verify-floating-primary-header-layout.ts \
  --touch \
  --url http://21.91.75.85 \
  --evidence /secure/absolute/evidence/touch \
  --expected-header-height 80
```

## 7. 失败回滚

任何 rollout、digest、HTTP 或浏览器验收失败，立即恢复第 4 步保存的 `previous_image`：

```bash
k3s kubectl -n dep set image deployment/raft-web-static "static=$previous_image"
```

对原 digest 重复第 5、6 步，证明原版本重新 1/1 Ready、零重启且外部入口恢复。构建/推送产生的不可变镜像
可以保留用于诊断；不要覆盖 tag、删除 evidence 或把失败镜像描述为 live。

## 8. 发布证据

交付结论至少包含：

- Git commit；
- TCR image digest；
- Deployment generation 与副本收敛；
- Pod name、imageID、Ready、restartCount；
- HTTP 状态矩阵；
- 关键页面/viewport 浏览器截图或 DOM box；
- 是否发生 rollback，以及 rollback 后原 digest 的验收结果。

缺少任一 live 证据时，只能说“已构建”或“已推送”，不能说“已发布”。
