# .ci（持续集成）

Devcloud/BlueKing CI 定义与发布运行时脚本。

## 边界

- 本入口只约定何时加载 CI context；实现细节延后至 [CI 服务详情](../docs/context/project/services/ci.md)。
- 发布任务还要加载 `release-gitops`。
- 流水线与发布操作需要用户明确授权。

## 命令

```bash
bash .ci/runtime/check_ci_runtime.sh
python3 .ci/runtime/commands/build_release_image.py --service <service> --env <env> --tag <tag>
```

## Argo CD 控制面重建

正式设计以 [发布与 GitOps 领域](../docs/engineering/domains/release-gitops.md) 为准；本节只提供控制面丢失后的执行清单。

### 定义与真源

- 国内统一 Argo CD 控制面运行在受控发布机的宿主机原生 k0s systemd 服务中，不使用 k0s-in-Docker。
- k0s 数据目录为 `/data/k0s-argocd-native`；Argo 对外固定使用 HTTP NodePort `32059`、HTTPS NodePort `30547`。
- `master` 保存 bootstrap、runtime patch 和 source-facing 定义；Argo 实际跟踪 `gitops`，不能把 `master` checkout 当成 live 期望。
- 控制面本身是可重建的，不承载业务 workload。重建不得修改目标集群内已有 Deployment、数据或生产 leaf app 的同步策略。
- repo SSH 凭据、Argo 管理员密码、目标集群 kubeconfig 和 `sops-age` 私钥只存在于 `/etc/lightclaw-ci` 等受保护的 Git 外存储；日志和验收输出只能展示键名、存在性或长度。

### 重建顺序

1. 确认 `/data` 容量充足，保留旧控制面的数据目录和容器 inspect 作为取证材料；确认旧 k0s 容器已停止并移除，避免端口和 etcd 双写。
2. 从最新 `master` 执行：

   ```bash
   CONTROL_PLANE_IP=<control-plane-ip> bash scripts/bootstrap_argocd_control_plane.sh
   ```

   脚本只安装固定版本的原生 k0s、Argo CD、NodePort，并生成控制面 kubeconfig/base URL；不会读取或恢复业务凭据。
3. 从受保护存储恢复 Argo 管理员密码与 mono2 repo SSH 凭据，随后恢复 `sops-age` Secret。repo-server 挂载或 ConfigMap 变化后必须 rollout，并等待 Ready。
4. 使用受保护 kubeconfig 注册目标集群。优先使用 `argocd cluster add`；cluster Secret 中的 `server` 必须与 AppProject/Application destination 完全一致，包括 `:443` 规范化，避免同一集群被注册成两个身份。
5. 从 `gitops` 依次恢复 `argocd/projects/`、`argocd/runtime/beijing-sandbox/` 和 runtime Application，确认 runtime `Synced/Healthy` 后再创建 root Applications。
6. 只同步并等待 `root-beijing-sandbox`、`root-shprod`、`root-sgprod` 收敛。root 只负责重建 Application，不等于授权同步生产 leaf。

### 发布与止损边界

- `OutOfSync/Healthy` 只表示 live 与 GitOps 存在差异。执行任何生产 leaf sync 前必须列出具体 OutOfSync 资源并确认差异所有权。
- 控制面重建期间禁止直接同步 `ctl-shprod`、`ctl-sgprod`、`sandbox-shprod` 或 `sandbox-sgprod` 来“消除红色状态”；这可能覆盖容量路由、临时止损或尚未 promote 的 live 配置。
- 数据安全止损启用时，必须在重建后确认上海、新加坡 `sandbox-worker` 仍为事故决策要求的副本数；紧急关闭态的 live 判定为 `replicas=0`，不能仅凭 root app 健康判断止损仍然有效。
- production leaf 的同步必须遵循独立发布授权；MR 合入、镜像构建、root app 恢复都不是该授权。

### 验收

至少验证以下各层，不能只看安装命令退出码：

```bash
systemctl is-enabled k0scontroller
systemctl is-active k0scontroller
k0s kubectl get node -o wide
k0s kubectl -n argocd get pods -o wide
argocd app wait argocd-runtime-beijing-sandbox --sync --health --timeout 300
argocd app wait root-beijing-sandbox root-shprod root-sgprod --sync --health --timeout 300
```

- 从控制面宿主机外访问 HTTPS NodePort，确认返回 Argo 页面。
- 确认 repo 可读、`sops-age` 已挂载、目标集群身份没有重复。
- 记录 runtime/root 的 GitOps revision；对准备发布的 leaf 继续验证 Deployment Ready、镜像 digest 和业务入口。
- 重建结束后再次检查生产止损资源和所有未同步 leaf，明确哪些差异是刻意保留的。

### 已知故障判定

- Kubernetes API 已响应不代表节点已注册；`kubectl get nodes` 可能成功但返回空列表。bootstrap 必须等待非空 node name，再等待该节点 `Ready`。
- `wrong version number`、`packet length too long` 或 TLS handshake timeout 若同时伴随明文代理响应，应判定为 DevCloud 出口/代理路径问题，不是证书错误，也不能靠把 k0s 从容器改为原生进程解决。
- 2026-09-24 重建时，上海、新山 VelaGW 专用 TKE API 因国内 DevCloud 出口限制保持 `ComparisonError`；后续重建必须重新探测，不能假定网络状态不变。不得通过放开公网安全组、禁用 TLS 或私建转发通道绕过；应提供经过审查的可达 API 路由，或把对应 Argo 控制器部署到具备合法网络可达性的环境。该 ComparisonError 不会停止目标集群中已经运行的 VelaGW workload。

## 硬规则

- 不输出凭据值或已解密 payload。
- 未经明确的凭据任务，不得修改流水线凭据。
- 镜像构建不代表发布完成；须验证 GitOps 和 Argo 状态。
- 除非仓库明确将其作为源码跟踪，否则生成产物不得进入 Git。
