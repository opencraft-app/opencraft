# 内部标准 fork 开发

日常在标准 Git 仓库的 `master` 上集成，不再生成或逐个重放旧补丁。
当前本机工作目录为 `/home/opencraft-demo/.opencraft/hands/projects/opencraft-fork`。
客户端 origin 为 `ssh://opencraft-runtime@127.0.0.1:2225/opencraft.git`，需使用该部署
提供的专用 SSH 配置；loopback 地址只在当前工作环境可用。
部署目录的 git-local helper 可独立 clone，现有工作目录已设置仓库级 core.sshCommand，
不依赖全局 SSH 配置。另一个容器或 CI runner 不能把自己的 127.0.0.1 当作此入口；
应部署受控隧道/服务网络或在本机执行获取步骤。

## 日常集成

1. `git fetch origin`，从 `origin/master` 建工作分支并正常提交。
2. `git fetch upstream`，在私有集成分支正常 merge upstream；逐项解决冲突。
3. 执行变更相关测试。需要集成 master 时持有公共 Git 目录的集成锁，重新 fetch，
   检查基线未改变，再正常快进/merge，推送 origin。网关保留原始 SHA 和作者身份。
4. CI 固定原始 SHA 和 tree，使用根目录的 ci:test:delivery、ci:verify、ci:build 等入口；
   不运行旧 consumer 的 source:prepare、submodule update 或补丁生成器。

upstream 指向 GitHub 公共核心，push URL 禁用。公共 PR 从公共基线单独整理可公开
提交，审核全部历史后才显式推送指定公共 fork，禁止公开私有集成分支。

## 工蜂和旧历史

后端仅使用 `refs/heads/gateway-fork/opencraft/*`。工蜂物理 `master` 保留原 consumer，
默认分支或网页展示不决定客户端集成分支。不能在工蜂直接 merge 投影前缀，更不能
把投影 commit 当成原始 fork 的祖先。网关发现前缀漂移时拒绝写入，需人工审计。

旧工作目录 `opencraft-internal` 保留现有 feature 分支、未提交改动和历史补丁。
本机该目录的 pre-push hook 拒绝再写工蜂物理 master；此限制是本机防误操作，
不能替代工蜂服务端分支保护，也不影响其他机器。不要从旧入口继续集成 master。
未迁移 feature 的改动先审阅真实差异，再移入新的原始 fork，不能直接合并旧 consumer 图。

## 运行和恢复

服务根目录为 `/home/opencraft-demo/.opencraft/hands/services/git-identity-gateway-fork`。
以 opencraft-runtime 账号执行 `instance/gatewayctl` 和 `instance/maintenancectl`；
root 应使用 runuser 降权。maintenance 定时检查 listener、映射、SSH 读取，并按计划
备份。人工 gatewayctl stop 会保存停服意图，维护不会把它重新启动。

当前容器没有宿主开机管理器，容器重建/重启后需要执行服务根的 `start`；本次只切换
本机源码入口，没有切换运行中的产品服务。独立故障域备份、服务端 ACL 和跨 runner
可达性仍须按正式部署配置，不能从本机成功 clone 推断这些条件已经完成。

源状态、映射和原始 vault 必须一起保全，外部密钥单独保存。恢复前停止维护并隔离
全部旧 writer；不能用旧快照覆盖更新的后端，不能清 journal 或强推来消除漂移。
已有新 fork 提交后，回退旧 consumer 前先冻结入口并逐提交核对，避免丢失新变更。
