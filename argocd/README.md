# Argo CD Layout

这个目录是 mono 仓库里的**唯一正式发布入口**。

## 仓库边界

- `git.woa.com/wisp/mono` 是日常开发和长期维护的 source repo。
- `https://code.lightclaw.tech/root/mono.git` 是香港 Argo CD 当前消费的 **deploy-only mirror**。
- deploy-only 仓的 `main` 只用于发布，不作为日常开发分支。
- 长期变更必须先落到 source repo，再同步到 deploy-only；不要只在 deploy-only 上留下长期配置差异。

## 正式规则

- 正式北京 / 上海发布只认 `argocd/`
- `Argo CD` 是唯一正式 apply 入口
- 服务目录不再承担正式 `apply / release`
- deploy-only `root/mono` 只消费：
  - `argocd/` deploy-facing 资产
  - 明确声明的 release bundle imports

## 目录约定

- `projects/`
  - 环境级 `AppProject`
- `root/`
  - 环境级 root app
- `apps/<env>/`
  - 该环境下的子 `Application`
- `services/<service>/<env>/`
  - 环境级 deploy-facing 组合层
- `secrets/<env>/`
  - deploy-facing secret artifacts

## 控制面模型

- 一个中心 GitLab
- 一个中心 Argo CD（当前在香港）
- 北京 / 上海都作为该控制面的环境目录来管理
- 不改香港单控制面架构

## 环境同构原则

- `beijing-sandbox`
- `shprod`

两个环境必须遵守同一套目录和 promotion 规则。  
不允许为 `shprod` 再发明第二套发布模型。

## 关联文档

- [GitOps Platform Standard](../docs/runbooks/gitops-platform-standard.md)
- [Root Mono Governance](../docs/runbooks/gitops-root-mono-governance.md)
- [GitOps Release Contract](../docs/runbooks/gitops-release-contract.md)
- [GitLab Group Naming Contract](GROUP-NAMING.md)
