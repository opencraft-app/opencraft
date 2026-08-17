# 独立 k3s 发布入口

本文件保存当前独立 k3s 的易变目标事实，并把不同组件路由到各自发布手册。长期架构、身份边界和通用门禁见仓库根 `AGENTS.md`。

## 当前目标

- SSH：`root@21.91.75.85:36000`，只允许已配置公钥登录；
- k3s：单节点，命令入口为目标主机自己的 `k3s kubectl`；
- Namespace：`dep`；
- Web Deployment：`raft-web-static`，1 副本；
- Backend Deployment：`chatserver-canary`，1 副本；
- 用户入口：`http://21.91.75.85`；
- Web image repository：`lightclaw-bj8.tencentcloudcr.com/lightclaw/vela-platform-web`；
- Backend image repository：`lightclaw-bj8.tencentcloudcr.com/lightclaw/vela-platform-api`。

这些值每次发布前都必须从 live 主机重新核对；本文件不是集群状态缓存。SSH 必须使用 `BatchMode=yes`、`IdentitiesOnly=yes` 和显式 identity，不能因默认 key 未命中而退回密码。

## 组件手册

- Web：[`k3s-web-release.md`](./k3s-web-release.md)
- Backend：[`k3s-backend-release.md`](./k3s-backend-release.md)
- Computer/TUI：尚无独立 k3s 正式发布手册；现有退役共享集群 Canary 脚本不得用于 live 发布。

Web、Backend 和 Computer 是三条不同发布链：Web digest 切换不会升级 Backend；Web/TUI 源码变化也不会升级已经安装的 `vela-computer`。交付时必须分别报告它们的 commit、digest/version 与 live 证据。

## 共同预检

```bash
git fetch origin
git status --short
git rev-parse HEAD
git rev-parse origin/master

ssh -o BatchMode=yes -o IdentitiesOnly=yes \
  -i /absolute/target-key -p 36000 root@21.91.75.85 '
    set -eu
    k3s --version
    k3s kubectl get node -o wide
    k3s kubectl -n dep get deployment raft-web-static chatserver-canary
    k3s kubectl -n dep get pods -o wide
  '
```

要求工作区干净、HEAD 等于 `origin/master`、Web 与 Backend 都为 1/1 Ready。构建成功、镜像 push、Deployment spec 更新和 Pod Ready 是四种不同证据，不能互相替代。
