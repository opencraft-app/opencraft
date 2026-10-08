# 新加坡 Gateway 云语音发布

## 目标与授权

用户已选择“升级网关并开通语音”，并要求避免生产问题。只发布 service-gateway-sgprod，补齐区域语音配置与专用凭据投影；不发布 admin-gateway、国际前端或其他 Argo 应用。

## 起点与边界

源分支基于 master 3fa43b017bdf5bd3ddf01081c93708d20da57f3e。线上旧 Gateway digest 为 1944e25cdc10c2517b319edc33010e13c8a030e06f0f96a8852d966284fa695a，两副本 Ready，公开语音入口 404。新加坡语音缺配置和 Secret；上海交付不能替代新加坡发布。

区域凭据仅由新加坡 CTL SSM 固定 v5 投影现有管理令牌，不轮转或修改凭据真源。发布前验证区域 NewAPI ep-hyasr3 的倍率和可用性，核对 GitOps 差异及已有 Secret 语义。

## 验证与发布

已通过：区域契约测试、静态校验、严格 Kustomize，以及两个 Set 的倍率与渠道/运行健康。待完成：source MR 合入、SG 镜像、单应用 GitOps 晋级与门禁、Argo Sync、2/2 实际镜像和业务入口验收。出现异常回退该应用至原部署状态；不以匿名 401 代替登录后的真实录音验收。

## Context receipt

路由：release service-gateway sgprod embedded speech Singapore gateway GitOps Argo production。已读 release-gitops、agent-gateway-runtime、site-environment-routing、service-gateway 服务文档，以及根、.ci、service-gateway AGENTS。正式设计同步 docs/engineering/domains/release-gitops.md。
