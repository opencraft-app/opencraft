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

upstream 指向 GitHub 公共核心，在私有 checkout 中保持 push URL 禁用。公开贡献
使用独立的干净 checkout；项目 owner 可以直接推送 GitHub 上游的贡献分支并提 PR，
不必再创建一个 GitHub fork。禁止公开私有集成分支或完整私有历史。

## 双向演进：上游优先，内部高频回流

```mermaid
flowchart LR
  Public["GitHub opencraft-app/opencraft · main"] -->|"fetch / merge"| Internal["私有 fork · master"]
  Topic["公开贡献目录 · contrib/功能"] -->|"PR"| Public
  Public -->|"从最新 main 建分支"| Topic
  Internal -.->|"审查后提取通用改动；不合并私有历史"| Topic
  Internal -->|"origin push"| Gateway["本机 SSH 身份网关"]
  Gateway -->|"committer 适配投影"| Backend["工蜂 gateway-fork/opencraft/*"]
end
```

- 通用核心功能、修复优先从 GitHub 最新 main 建分支开发，经公开 PR 合入后，
  正常 merge 回内部 fork。项目 owner 身份不意味着可以上传内部历史。
- IOA、企业微信、内部身份、品牌和部署装配保留内部；尽量通过插件、配置及
  产品装配隔离，减少直接改写上游核心文件。不要以“自有项目”为由公开这些内容。
- 当前历史积累需要一次性收敛。按相关功能和依赖分批合并并验证，不要求每个
  上游 commit 单独合一次，也不以合完全部积压作为公开贡献的前置条件。
- 此后在开始通用功能前、公开 PR 合入后及时同步，活跃开发期至少每日检查差异。
  同步到团队约定的固定上游 SHA，记录未合并范围，不用“fetch 成功”冒充已经合入。
- 紧急通用修复若先落内部，应尽快提取公开 PR；PR 合入后正常回流。不要为消除
  冲突覆盖内部业务、安全修复，也不要用 ours 合并伪造“已追平”。

### 两个 checkout 的 remote 与分支

| checkout | origin | 其他 remote | 分支约定 |
| --- | --- | --- | --- |
| 内部开发 | 本机 SSH 网关 `opencraft.git` | upstream：GitHub，只读 | master、internal/*、integrate/* |
| 公开贡献 | GitHub `opencraft-app/opencraft` | 不需要写工蜂 | main、contrib/具体功能 |

本机仓库继续叫 opencraft.git，与 GitHub 同名不冲突；Git 地址区分仓库，分支名
只在各自仓库内区分工作。SSH 网关是真实 Git 服务，不是 GitHub 登记的 fork。
contrib/* 是每项 PR 的临时分支，合入后可删除，不必永久占一个“内部贡献分支”。

### 通用功能的正常路径

下面在新的独立目录执行，不修改内部 checkout 的 origin/upstream 设置。
GitHub SSH 身份须已有上游仓库写权限；凭据使用现有安全配置，不写入 URL 或文档。

```bash
git clone git@github.com:opencraft-app/opencraft.git opencraft-public
cd opencraft-public
git fetch origin
git switch -c contrib/example origin/main
# 开发、提交、运行相关检查，并审查所有待公开提交与文件。
git log --oneline origin/main..HEAD
git diff --check origin/main...HEAD
git diff --stat origin/main...HEAD
# 确认完整 diff、提交信息及历史可公开后，只推这一条贡献分支。
git push -u origin HEAD:refs/heads/contrib/example
```

在 GitHub 将 contrib/example 向 main 提 PR，遵守仓库的审查和 CI 门禁。
内部 checkout 随后 fetch upstream，在隔离集成分支合并已接受的公开提交，验证
通过后依照前述集成锁流程更新私有 master。公开 checkout 不经过工蜂身份投影。

### 内部已有改动如何贡献

1. 从公开最新 main 创建干净的 contrib/* 分支，不从私有 master 建公开分支。
2. 审阅选定提交的完整 diff、提交信息和来源；纯通用、独立提交可审查后 cherry-pick，
   混有内部业务的提交必须拆分或手工移植。cherry-pick 是贡献提取手段，不是内部同步上游的常规方式。
3. 确认最终分支只包含公开基线与待审查的通用提交；检查全部新增可达提交，而非
   只检查最后一次 diff。合并提交可能带入看不见于最终 diff 的内部历史，禁止 merge 私有 master。
4. 检查凭据、内部域名、个人数据、IOA/企业微信代码和私有配置，完成相关测试后
   只推指定 contrib/*。若基线变化导致冲突，在公开分支解决；内部工作不因此丢弃。
5. 记录内部来源 SHA、公开 PR 及最终合入 SHA 的对应关系；上游若 squash/rebase，
   SHA 不同是正常情况，后续回流核对内容，不再次重复搬运。

公开推送禁止 --mirror、--all、--tags；禁止将网关原始 vault、工蜂投影图或私有
master 推到 GitHub。可公开性审核不能被“我是 owner”或一次 secret 扫描替代。

## SSH 身份网关的价值与边界

工蜂 committer 邮箱限制由网关的后端投影适配。开发侧保留原始 SHA、作者身份与
上游继承关系，文件内容在对应原始提交与投影提交间一致；正常开发只读写原始图。
直接批量改写原始 committer 会改变 SHA 和后续父链，因此不在开发图上做此适配。

网关不消除代码冲突、不自动产生公开 PR，也不保证任何内部提交都可公开。
减少摩擦依靠上游优先、频繁回流和内部差异隔离；网关只负责保持这种标准 Git
流程与工蜂身份要求兼容。以后不再需要工蜂约束时，可以评估移除适配层。

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
