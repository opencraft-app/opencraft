# 独立 k3s Web 发布运行手册

本手册发布 Expo Web 静态镜像，不发布 Backend、Computer 或 TUI。当前目标事实见 [`k3s-release.md`](./k3s-release.md)。

## 正式入口

```bash
web/deploy/k3s/release.sh deploy \
  --builder USER@AUTHORIZED_BUILDER \
  --builder-port 36000 \
  --builder-identity /absolute/builder-key \
  --target root@21.91.75.85 \
  --target-port 36000 \
  --target-identity /absolute/target-key \
  --base-url http://21.91.75.85 \
  --evidence /secure/absolute/evidence/web-$(git rev-parse --short=12 HEAD)
```

identity 和 evidence 必须是绝对路径；evidence 目录必须不存在。脚本不读取本机 kubeconfig，不导出 Registry 登录材料，也不接受密码参数。

## 发布模型

```text
clean pushed commit
→ Mac Web/TUI gates + Expo dist
→ minimal static context
→ authorized Buildx builder push
→ immutable registry digest
→ target-owned k3s kubectl rollout
→ Pod imageID + HTTP/SPA/auth verification
```

Mac 不运行 Docker。Builder 和 k3s target 是两个独立 SSH 信任边界：Builder 只持有 Docker daemon、Buildx 与 Registry 登录状态；target 只持有自己的 k3s 管理面。两边均强制公钥、`BatchMode=yes` 和 `IdentitiesOnly=yes`。

## 脚本执行的门禁

1. `git fetch`，工作区干净，HEAD 等于 upstream；
2. Web 类型检查、全量测试和凭据扫描；
3. TUI bundle `check:tui`、TUI tests 和确定性构建测试；
4. Expo Web 导出和本地 SPA fallback；
5. Builder 的 Docker daemon、指定 Buildx builder、`linux/amd64` 与 Registry 读权限；
6. 目标 tag 不存在，拒绝覆盖不可变发布；
7. Web 与 Backend 的 live Deployment 都是 1/1 Ready；
8. 当前 Web image 与目标 image 都使用真实 `sha256` digest。

脚本只发送以下最小上下文，并保留 Dockerfile 的 Web-root 相对路径：

```text
apps/client/dist/
deploy/devcloud/Dockerfile
deploy/devcloud/nginx.conf
```

## Rollout 与验收

脚本不依赖 `kubectl rollout status` 的 watch；它轮询 Deployment JSON 并要求：

```text
metadata.generation == status.observedGeneration
spec.replicas == 1
updatedReplicas == readyReplicas == availableReplicas == 1
unavailableReplicas == 0
```

随后要求唯一 Web Pod 为 Running、Ready、`restartCount=0`，且 `imageID` 命中目标 Registry digest。外部验收覆盖：

- `/`、`/healthz-web`；
- Backend `/healthz`、`/readyz`；
- `/install`；
- `/join`、`/agents` 的 SPA fallback；
- `/v1/me` 未认证时返回 401。

涉及 UI 几何、密度或材质时，发布后还必须运行相应浏览器门禁和截图；脚本不会用普通 HTTP smoke 代替视觉验收。

## 自动回滚

脚本在切换前保存原 image。切换后任何 Deployment、Pod、imageID 或 HTTP 验收失败，都会恢复原 digest，并重新验证原 Pod 与 HTTP 矩阵。失败的新镜像可以保留用于诊断，但不能描述为 live。

自动回滚失败时必须停止并人工处理，不能继续修改副本数、hostPort、Service、toleration 或 Nginx ConfigMap 来帮助 rollout 通过。

## 发布证据

evidence 目录包含：

- commit、immutable tag、Registry digest；
- Buildx metadata；
- rollout 前后的 Deployment 与 Pod 快照；
- HTTP 状态矩阵；
- `release-evidence.json` 中的 published/rolled_back/failed 状态。

证据不得包含 Registry 密码、SSH 私钥、cookie、token、签名或 presigned URL query。
