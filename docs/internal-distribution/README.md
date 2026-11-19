# Join 内部发行版

这是 `https://git.woa.com/join/opencraft` 的内部发行版。GitHub
`https://github.com/opencraft-app/opencraft` 是通用核心上游。两个远端共享
Git 对象与祖先关系；本仓库不使用 subtree、submodule 或源码快照同步。

## 代码与分支

- `apps/`、`packages/`、通用 `plugins/`：核心实现，可与产品改动一起开发。
- `products/join/`：企业身份、企业微信接入与构建装配。运行配置和凭据留在部署者的私有存储。
- `env/local`：本机环境的源码集成分支，跟踪 `origin/env/local`。发布固定该分支的完整 SHA，构建通过后沿既有部署锁、候选镜像和失败回退入口切换。
- `upstream`：只读拉取 GitHub；`origin`：内部仓库，默认推送目标。

初次克隆：

```sh
git clone --branch env/local https://git.woa.com/join/opencraft.git
cd opencraft
git remote add upstream https://github.com/opencraft-app/opencraft.git
git remote set-url --push upstream disabled://public-upstream-readonly
git config remote.pushDefault origin
npm ci
npm run join:test
npm run join:build:web
npm run join:build:gateway
```

Web 产物在 `apps/workbench-web/dist`；Gateway 产物默认在
`products/join/dist/runtime`，包含既有核心打包器需要的 worker。
Gateway 包不是完整容器发行包，不能仅凭该文件替换整套运行时。

受信任产品插件可由同一模块图生成独立代码包，经 Gateway 数据卷持久加载；
接入与迁入范围见[产品插件持久包](product-plugin-packs.md)。现有 OA 注册仍沿原装配，
此能力不会按目录扫描自动启用插件。

目前现有功能大多为第一方插件，保持随发行装配；本轮优先建立[用户插件机制](user-plugins.md)，
接通持久目录和原管理器，不以插件外置为目的迁移第一方功能。

`env/local` 是环境消费入口，不让运行服务跟着 dirty worktree 或浮动 HEAD
读取文件。远端提交、候选构建、实际发布与运行版本是四个不同状态；推送成功
本身不代表实例已更新。重启与恢复继续消费持久 Compose 配置。

## 内部集成与发布

### 身份与服务端校验

Git Author、Committer 与推送认证账户是不同信息。工蜂会校验本次推送新增的
提交历史；设置 `user.email` 不会改变认证账户，也不会自动绑定邮箱。

2026-11-10 的验证记录：当前认证账户为 `skipzhang`；`beordle@gmail.com`
被服务端拒绝，原因是未绑定到该账户。用户明确授权**本次**使用已被工蜂接受的
`skipzhang <skipzhang@tencent.com>`。这是当前环境的校验记录，不是永久用户
偏好；后续身份以实际认证账户、绑定情况和用户授权为准。不要为绕过校验伪造
Author，也不要把口令、令牌或私钥放入仓库。

提交命令使用局部配置，例如在身份适用且已获授权时：

```sh
git -c user.name=skipzhang -c user.email=skipzhang@tencent.com commit
```

### 整理拒绝的历史

正常历史优先普通合并。若本地祖先包含服务端不接受的 committer，仅 amend
最后一个提交不能解决问题；不要反复推整条本地分支或改写已经发布的历史。

1. `git fetch origin env/local`，从最新 `origin/env/local` 建立独立、干净的集成分支。
2. 核对目标功能、必要依赖及现网已有修复，逐项列出要迁入的提交；不要夹带其他会话的修改。
3. 用已授权的 committer 执行 `git cherry-pick -x <source-sha>`，保留原 Author 和来源 SHA；保留原分支供追溯。冲突须审查实际差异。
4. 验证整合后的代码与产物。普通推送明确准备好的提交：`git push origin <prepared-sha>:refs/heads/env/local`。若远端推进，重新 fetch、审查并集成，不能 force-push。
5. 用 `git ls-remote origin refs/heads/env/local` 核对远端结果。向共享本地 `env/local` 回合入时，先取得集成锁并确认工作树干净；保留其他任务的提交和未提交内容。

本机当前集成锁为 `/data/build/locks/opencraft-internal-env-local.lock`；共享
工作树可能被其他会话持有，先用 `git worktree list` 确认，不擅自切换或 reset。
构建使用独立的固定 SHA detached worktree，避免长期占用集成分支。

### 源码、产物与运行状态

发布前先将已提交源码正常集成进本地 `env/local`，再固定具体发布 SHA。
集成分支此后前进不代表要把其他任务的新改动一起发布。运行产物以当前现网为
基线，按 [快速变更 Skill](../../.agents/skills/opencraft-fast-change/SKILL.md)
或正式发布流程验证依赖、迁移及服务范围。

若历史整理得到新 SHA，但准备复用旧 SHA 构建的产物，必须检查完整树一致：

```sh
git diff --exit-code <built-source-sha> <published-source-sha>
git rev-parse '<built-source-sha>^{tree}' '<published-source-sha>^{tree}'
```

记录两个来源 SHA 和比较结果；产物仍保留真实构建源 SHA/buildId，不修改版本
标签来冒充重新构建。树有差异则不能声称产物与发布源码一致，需重新构建验证。

每次发布先创建新的产物目录，再复制、适配并运行采集脚本；不能在旧发布目录
执行 discovery，覆盖历史现网基线、manifest 或验证记录。切换前重新核对现网，
沿统一部署锁和独立 supervisor 执行，保留失败回退。当前宿主机部署锁为
`/opt/opencraft-docker/deploy.lock`，与源码集成锁用途不同。

交付记录分别写明：远端提交、构建源 SHA/buildId、候选镜像、实际运行镜像及
验证结果。推送不等于上线，构建通过不等于运行验证通过。仅更新文档不构建运行
产物、不重启服务。

## 同步上游

```sh
git fetch upstream main
git switch -c integration/upstream-YYYYMMDD origin/env/local
git merge --no-ff upstream/main
# 解决冲突、验证核心和 Join 装配后，普通合入 env/local，再推送 origin。
```

核心与插件可以在一个功能提交里协同修改。准备 GitHub PR 时，从
`upstream/main` 新建干净贡献分支，只整理通用核心差异，运行来源与敏感信息检查；
不把内部发行版分支直接合入公共上游。上游接收后，通过普通 merge 吸收，保留历史。

### 2026-11-11 上游整合

本次从内部 `c850e4f1120003a72b1412d5a26e61b9c6894464` 正常合并 GitHub
`main` 的 `7366eb2aa015b18e9204d189be7a598bb5efd208`，逐项协调执行引擎、
会话权限、客户端和存储冲突。保留 Join 身份装配、个人助理、原生群与企业微信、
Hands 文件/终端 owner。通用容器恢复上游 stock Electron 默认路径，
内网定制 Electron 作为显式构建选项保留产物校验；未用公共源码
覆盖内部产品，也未改写已发布历史。

工蜂拒绝原始合并历史中的 GitHub committer，故内部发布从相同远端基线以
`cherry-pick -m 1 -x` 迁入合并结果。原两父合并提交为
`cf1a43ae7df75a3bee8fee6a0e90de16e075ffb2`，保留在本地
`codex/merge-github-20261111`；迁入提交
`977c2fe7` 与原合并的完整源码树一致。发布不是 GitHub 原始历史的远端祖先接续，
后续同步仍须核对固定上游 SHA 和补丁差异。

存储保留 `0000` 至 `0007` 的 SQL、迁移名称与校验和，将上游会话权限/笔记和
自动化表分别追加为 `0008_thread_access_and_notes`、`0009_project_automations`。
现有 v8 安装的导入收据沿受控增量路径升级，不能把上游 v3/v4 的编号覆盖到它上面。
源码运行的 orchestration worker 改用当前 TypeScript 入口；正式打包仍构建独立 worker。

同时修复整合验收发现的模型目录分页、AppHost 身份投影适配、Mac PTY helper 权限和产品插件真实路径识别，
补齐语言目录并对齐 Expo SDK 的 Worklets 版本。按需页面和文件面板样式延迟加载，
保留原首屏资源限额。第三方 deepmerge 的原始 `readme.md` 改名为
`README.upstream.md`，原文不变，避免 macOS 默认文件系统与 `README.md` 冲突。
仅适用于 Linux `/proc` 的进程来源测试在其它系统明确跳过，不表示 Mac 已验证该能力。
完整门禁另有拆分 Core 的 Linux `/proc` 依赖，以及 Mac 上两项 Hands 终端超时；
保留未通过记录，不把本机组合服务验证描述为三容器实机验收。

## 历史接续

本机旧 `dev/local` 从源码快照 `45ad052` 起步。与历史 GitHub
`cab595b4c84f3c6683cf95992073a218cf780db6` 比较，仅有 19 个容器部署文件差异
（605 行增加、85 行删除）。本次保留该快照及所有后继提交，并以两父接续提交
明确采用这个历史上游基线；接续提交的源码树与接续前完全相同。

这不表示后续 GitHub `main` 已被吸收。下一次上游升级必须正常合并、处理差异和验证，
不能使用 `merge -s ours` 把未消费的上游功能标记为已合入。
具体输入与文件摘要见 `products/join/source-inputs.json`。

## 环境迁移

旧源码工作区仍可能有进行中的未提交任务。它们不包含在此发行版初始化中，
不得通过复制 dirty worktree 自动夹带。后续迁入使用明确提交的普通合并或
cherry-pick，验证后进入 `env/local`。本次初始化不改写旧提交、不推 GitHub main，
也不修改 `.40` 上原有 `env/join` 产品的部署和数据。

## 个人助理源码

个人助理平台权限和原生群历史属于共享 Core；`apps/personal-assistant` 是独立运行时 workspace，桌面与 headless 共用同一可信 Host 激活入口。内置“大家”提供显式申领、打开和停用；安装级 Host 托管已申领助理并接通原生私聊文本。申领后可在“我的个人助理”选择安装级模型服务中的兼容 Responses 模型；引用按助理保存，凭据仍由模型服务持有。无用户选择时保留显式安装级 Codex 配置的兼容路径；无可用配置时显示等待状态。合入不触发部署、数据库升级或自动创建用户助理。

运行时从已提交实验代码一次迁入，来源见 `apps/personal-assistant/SOURCE.json`；后续在内部 workspace 维护，不与旧实验目录双向同步。模型凭据、profile、评测数据和运行日志不入库。协议、目录与撤权边界见 [个人助理](../architecture/personal-assistant.md)。
