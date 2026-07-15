# LightVela MR Pulse - 2026-07-03

- 生成时间：2026-07-03 10:15:21 UTC+08:00
- 数据源：工蜂 `wisp/mono2` opened merge requests（`mcporter-internal` / `gongfeng.search_merge_request`）
- 口径：发布类按 `target_branch=gitops`、`promote-*` 源分支、标题包含“发布到/进入...待同步状态/GitOps”识别；草稿按 Draft/WIP/work_in_progress 识别；待合入为非发布、非草稿且 CI success、可合并、未被 CI block。

## 总览

- 全仓库：Open 96；待合入 7；待评审/修复 23；待发布 65；草稿 1
- 团队视图（剔除 skipzhang）：Open 17；待合入 3；待评审/修复 13；待发布 0；草稿 1
- skipzhang 发布类清理议题：Open 65；待合入 0；待评审/修复 0；待发布 65；草稿 0

| 视图 | >24h | >3d | >7d | >14d |
|---|---:|---:|---:|---:|
| 全仓库 | 91 | 86 | 83 | 69 |
| 团队视图（剔除 skipzhang） | 12 | 9 | 9 | 6 |
| skipzhang 发布类 | 65 | 64 | 62 | 58 |

## 团队视图（剔除 skipzhang）

### 待合入

| MR | 标题 | 作者 | CI | 合并状态 | 停留 | 分支 |
|---:|---|---|---|---|---:|---|
| !823 | [[FE-iztzhou] docs(search): accurate breadcrumbs + heading-priority ranking + stable hit locate](https://git.woa.com/wisp/mono2/merge_requests/823) | hadezwang | success | can_be_merged | 38.9d | `Feature/iztzhou-docs-search-locate -> Feature/iztzhou` |
| !1459 | [[FE-AI] feat(scripts): 运营周报新增近7天开通套餐数 + 环比](https://git.woa.com/wisp/mono2/merge_requests/1459) | sarahzzhang | success | can_be_merged | 21.8d | `feature/ops-metrics-subscription-growth -> master` |
| !1906 | [固化产品技能同步约定 / docs: document product skills subtree policy](https://git.woa.com/wisp/mono2/merge_requests/1906) | pablozhong | success | can_be_merged | 2.7d | `codex/document-product-skills-subtree-policy -> master` |

### 待评审 / 修复

| MR | 标题 | 作者 | CI | 合并状态 | 停留 | 分支 |
|---:|---|---|---|---|---:|---|
| !1078 | [[FE-AI] feat: 接入企业微信通道预览](https://git.woa.com/wisp/mono2/merge_requests/1078) | walkercao | success | cannot_be_merged | 29.7d | `frontsandbox/wecom-qr-channel-sdk-20260602 -> master` |
| !1174 | [[FE-AI] feat(landing): 替换首页为 feature/iztzhou-lightvela Figma 导出实现](https://git.woa.com/wisp/mono2/merge_requests/1174) | iztzhou | failure | cannot_be_merged | 29.0d | `feature/iztzhou-lightvela-main -> master` |
| !1463 | [[FE-AI] feat: move reset model entry to model page](https://git.woa.com/wisp/mono2/merge_requests/1463) | walkercao | success | cannot_be_merged | 21.7d | `frontsandbox/reset-model-entry-model-page -> master` |
| !1476 | [[FE-AI] feat: 自定义模型格式校验](https://git.woa.com/wisp/mono2/merge_requests/1476) | walkercao | success | cannot_be_merged | 21.5d | `frontsandbox/custom-model-config-validation -> master` |
| !1745 | [新增国际站更新日志 / feat: add global changelog](https://git.woa.com/wisp/mono2/merge_requests/1745) | cassidyshi | failure | cannot_be_merged | 10.9d | `feature/changelog -> master` |
| !1826 | [fix(trade): DIANSHI_PRICE_BASE_URL 补全应用层 path /activity_price/activity/get_price](https://git.woa.com/wisp/mono2/merge_requests/1826) | xinqishang | success | unchecked | 8.7d | `chore/trade-dianshi-price-path-fix -> master` |
| !1841 | [feat(trade/createresource): use para.billingActivityId as dianshi judge (Q-DIANSHI-CB v0.5.1)](https://git.woa.com/wisp/mono2/merge_requests/1841) | xinqishang | failure | can_be_merged | 8.4d | `feat/trade-createresource-dianshi-billing-activity-id -> master` |
| !1912 | [同步 product-ai 产品技能 / chore: sync product skill subtree](https://git.woa.com/wisp/mono2/merge_requests/1912) | pablozhong | success | cannot_be_merged | 2.6d | `codex/sync-product-skills-latest -> master` |
| !1931 | [ prd-init  / chore(agents): sync prd-init from product-ai](https://git.woa.com/wisp/mono2/merge_requests/1931) | pablozhong | success | cannot_be_merged | 1.7d | `codex/sync-prd-init-from-product-ai -> master` |
| !1948 | [chore(openspec): 归档诊断 Agent 备份变更集 + 立项 support-ticket v1](https://git.woa.com/wisp/mono2/merge_requests/1948) | keriaxu | failure | cannot_be_merged | 22.3h | `chore/openspec-archive-diagnostic-agent-backup -> master` |
| !1954 | [修复 Next 迁移后 RUM 上报失效：AEGIS 配置迁到 Next env 平面 / fix(observability): resolve Aegis config from Next public env](https://git.woa.com/wisp/mono2/merge_requests/1954) | sarahzzhang | failure | can_be_merged | 18.9h | `fix/next-rum-aegis-env -> master` |
| !1956 | [支持云存储重命名 / feat(files): add cloud storage rename](https://git.woa.com/wisp/mono2/merge_requests/1956) | pablozhong | failure | can_be_merged | 17.2h | `frontsandbox/cloud-storage-rename -> master` |
| !1957 | [frontsandbox/model-list-rainbow](https://git.woa.com/wisp/mono2/merge_requests/1957) | viorhuang | failure | can_be_merged | 17.0h | `frontsandbox/model-list-rainbow -> master` |

### 待发布

_无_

### 草稿

| MR | 标题 | 作者 | CI | 合并状态 | 停留 | 分支 |
|---:|---|---|---|---|---:|---|
| !1950 | [Draft: feat(ticket): scaffold support ticket backend service](https://git.woa.com/wisp/mono2/merge_requests/1950) | keriaxu | success | can_be_merged | 19.5h | `feat/support-ticket-backend -> master` |

### 非发布超时 MR（>24h）

| MR | 标题 | 作者 | CI | 合并状态 | 停留 | 分支 |
|---:|---|---|---|---|---:|---|
| !823 | [[FE-iztzhou] docs(search): accurate breadcrumbs + heading-priority ranking + stable hit locate](https://git.woa.com/wisp/mono2/merge_requests/823) | hadezwang | success | can_be_merged | 38.9d | `Feature/iztzhou-docs-search-locate -> Feature/iztzhou` |
| !1078 | [[FE-AI] feat: 接入企业微信通道预览](https://git.woa.com/wisp/mono2/merge_requests/1078) | walkercao | success | cannot_be_merged | 29.7d | `frontsandbox/wecom-qr-channel-sdk-20260602 -> master` |
| !1174 | [[FE-AI] feat(landing): 替换首页为 feature/iztzhou-lightvela Figma 导出实现](https://git.woa.com/wisp/mono2/merge_requests/1174) | iztzhou | failure | cannot_be_merged | 29.0d | `feature/iztzhou-lightvela-main -> master` |
| !1459 | [[FE-AI] feat(scripts): 运营周报新增近7天开通套餐数 + 环比](https://git.woa.com/wisp/mono2/merge_requests/1459) | sarahzzhang | success | can_be_merged | 21.8d | `feature/ops-metrics-subscription-growth -> master` |
| !1463 | [[FE-AI] feat: move reset model entry to model page](https://git.woa.com/wisp/mono2/merge_requests/1463) | walkercao | success | cannot_be_merged | 21.7d | `frontsandbox/reset-model-entry-model-page -> master` |
| !1476 | [[FE-AI] feat: 自定义模型格式校验](https://git.woa.com/wisp/mono2/merge_requests/1476) | walkercao | success | cannot_be_merged | 21.5d | `frontsandbox/custom-model-config-validation -> master` |
| !1745 | [新增国际站更新日志 / feat: add global changelog](https://git.woa.com/wisp/mono2/merge_requests/1745) | cassidyshi | failure | cannot_be_merged | 10.9d | `feature/changelog -> master` |
| !1826 | [fix(trade): DIANSHI_PRICE_BASE_URL 补全应用层 path /activity_price/activity/get_price](https://git.woa.com/wisp/mono2/merge_requests/1826) | xinqishang | success | unchecked | 8.7d | `chore/trade-dianshi-price-path-fix -> master` |
| !1841 | [feat(trade/createresource): use para.billingActivityId as dianshi judge (Q-DIANSHI-CB v0.5.1)](https://git.woa.com/wisp/mono2/merge_requests/1841) | xinqishang | failure | can_be_merged | 8.4d | `feat/trade-createresource-dianshi-billing-activity-id -> master` |
| !1906 | [固化产品技能同步约定 / docs: document product skills subtree policy](https://git.woa.com/wisp/mono2/merge_requests/1906) | pablozhong | success | can_be_merged | 2.7d | `codex/document-product-skills-subtree-policy -> master` |
| !1912 | [同步 product-ai 产品技能 / chore: sync product skill subtree](https://git.woa.com/wisp/mono2/merge_requests/1912) | pablozhong | success | cannot_be_merged | 2.6d | `codex/sync-product-skills-latest -> master` |
| !1931 | [ prd-init  / chore(agents): sync prd-init from product-ai](https://git.woa.com/wisp/mono2/merge_requests/1931) | pablozhong | success | cannot_be_merged | 1.7d | `codex/sync-prd-init-from-product-ai -> master` |

## skipzhang 发布类清理议题

| MR | 标题 | 作者 | CI | 合并状态 | 停留 | 分支 |
|---:|---|---|---|---|---:|---|
| !1028 | [进入上海正式待同步状态：cloudagent-gateway](https://git.woa.com/wisp/mono2/merge_requests/1028) | skipzhang | success | cannot_be_merged | 30.8d | `promote-shprod-cloudagent-gateway-cloudagent-gateway-1d9153d66ef9 -> gitops` |
| !1076 | [发布到北京测试：vibebase](https://git.woa.com/wisp/mono2/merge_requests/1076) | skipzhang | success | cannot_be_merged | 29.8d | `promote-beijing-sandbox-vibebase-vibebase-db7f50a83037 -> gitops` |
| !1123 | [发布到devcloud-dep：channelgateway](https://git.woa.com/wisp/mono2/merge_requests/1123) | skipzhang | success | cannot_be_merged | 29.5d | `promote-devcloud-dep-channelgateway-channelgateway-7c1125403977 -> gitops` |
| !1126 | [发布到devcloud-dep：cloudagent-gateway](https://git.woa.com/wisp/mono2/merge_requests/1126) | skipzhang | success | cannot_be_merged | 29.5d | `promote-devcloud-dep-cloudagent-gateway-cloudagent-gateway-083076ef8532 -> gitops` |
| !1132 | [发布到devcloud-dep：channelgateway](https://git.woa.com/wisp/mono2/merge_requests/1132) | skipzhang | success | cannot_be_merged | 29.5d | `promote-devcloud-dep-channelgateway-channelgateway-daa383b7e3cd -> gitops` |
| !1134 | [发布到devcloud-dep：cloudagent-gateway](https://git.woa.com/wisp/mono2/merge_requests/1134) | skipzhang | success | cannot_be_merged | 29.5d | `promote-devcloud-dep-cloudagent-gateway-cloudagent-gateway-daa383b7e3cd -> gitops` |
| !1146 | [发布到devcloud-dep：channelgateway](https://git.woa.com/wisp/mono2/merge_requests/1146) | skipzhang | success | cannot_be_merged | 29.4d | `promote-devcloud-dep-channelgateway-channelgateway-e8c47c2dea83 -> gitops` |
| !1149 | [发布到devcloud-dep：cloudagent-gateway](https://git.woa.com/wisp/mono2/merge_requests/1149) | skipzhang | success | cannot_be_merged | 29.4d | `promote-devcloud-dep-cloudagent-gateway-cloudagent-gateway-459f6cb18aed -> gitops` |
| !1162 | [发布到devcloud-dep：cloudagent-gateway](https://git.woa.com/wisp/mono2/merge_requests/1162) | skipzhang | success | cannot_be_merged | 29.3d | `promote-devcloud-dep-cloudagent-gateway-cloudagent-gateway-cf461d273380 -> gitops` |
| !1175 | [发布到devcloud-dep：channelgateway](https://git.woa.com/wisp/mono2/merge_requests/1175) | skipzhang | success | cannot_be_merged | 29.0d | `promote-devcloud-dep-channelgateway-channelgateway-df11c00e58e6 -> gitops` |
| !1178 | [发布到devcloud-dep：cloudagent-gateway](https://git.woa.com/wisp/mono2/merge_requests/1178) | skipzhang | success | cannot_be_merged | 28.8d | `promote-devcloud-dep-cloudagent-gateway-cloudagent-gateway-899ea1afdba9 -> gitops` |
| !1181 | [发布到devcloud-dep：cloudagent-gateway](https://git.woa.com/wisp/mono2/merge_requests/1181) | skipzhang | success | cannot_be_merged | 28.7d | `promote-devcloud-dep-cloudagent-gateway-cloudagent-gateway-cdcfbcf12f67 -> gitops` |
| !1183 | [发布到devcloud-dep：channelgateway](https://git.woa.com/wisp/mono2/merge_requests/1183) | skipzhang | success | cannot_be_merged | 28.7d | `promote-devcloud-dep-channelgateway-channelgateway-e843bdf989a8 -> gitops` |
| !1196 | [发布到devcloud-dep：cloudagent-gateway](https://git.woa.com/wisp/mono2/merge_requests/1196) | skipzhang | success | cannot_be_merged | 28.6d | `promote-devcloud-dep-cloudagent-gateway-cloudagent-gateway-a5012bc594da -> gitops` |
| !1211 | [发布到DevCloud dep：channelgateway](https://git.woa.com/wisp/mono2/merge_requests/1211) | skipzhang | success | cannot_be_merged | 28.4d | `promote-devcloud-dep-channelgateway-channelgateway-1ff333b767cf -> gitops` |
| !1214 | [发布到TKEx 广州内网：cloudladdergateway](https://git.woa.com/wisp/mono2/merge_requests/1214) | skipzhang | success | cannot_be_merged | 28.4d | `promote-tkexgz-cloudladdergateway-cloudladdergateway-dd7d903f385c -> gitops` |
| !1268 | [发布到DevCloud dep：cloudagent-gateway](https://git.woa.com/wisp/mono2/merge_requests/1268) | skipzhang | success | unchecked | 27.4d | `promote-devcloud-dep-cloudagent-gateway-cloudagent-gateway-cf11749e967e -> gitops` |
| !1296 | [发布到DevCloud dep：cloudagent-gateway](https://git.woa.com/wisp/mono2/merge_requests/1296) | skipzhang | success | cannot_be_merged | 26.6d | `promote-devcloud-dep-cloudagent-gateway-cloudagent-gateway-36506c96d6e4 -> gitops` |
| !1328 | [发布到DevCloud dep：cloudagent-gateway](https://git.woa.com/wisp/mono2/merge_requests/1328) | skipzhang | success | cannot_be_merged | 24.7d | `promote-devcloud-dep-cloudagent-gateway-cloudagent-gateway-0dfcfd4422d0 -> gitops` |
| !1332 | [发布到DevCloud dep：cloudagent-gateway](https://git.woa.com/wisp/mono2/merge_requests/1332) | skipzhang | success | cannot_be_merged | 24.7d | `promote-devcloud-dep-cloudagent-gateway-cloudagent-gateway-3d2a16c3ebfb -> gitops` |
| !1351 | [发布到上海 Worker：workers](https://git.woa.com/wisp/mono2/merge_requests/1351) | skipzhang | success | cannot_be_merged | 23.8d | `promote-shanghai-workers-workers-workers-0a320ffaf41b -> gitops` |
| !1355 | [发布到TKEx 新加坡内网：cloudladdergateway](https://git.woa.com/wisp/mono2/merge_requests/1355) | skipzhang | success | cannot_be_merged | 23.8d | `promote-tkexsg-cloudladdergateway-cloudladdergateway-355b93f3ad8d -> gitops` |
| !1393 | [发布到北京测试：vibebase](https://git.woa.com/wisp/mono2/merge_requests/1393) | skipzhang | success | cannot_be_merged | 22.9d | `promote-beijing-sandbox-vibebase-vibebase-fffccc54b7ab -> gitops` |
| !1396 | [发布到北京测试：vibebase](https://git.woa.com/wisp/mono2/merge_requests/1396) | skipzhang | success | cannot_be_merged | 22.8d | `promote-beijing-sandbox-vibebase-vibebase-0509798b0fdc -> gitops` |
| !1401 | [发布到北京测试：service-gateway](https://git.woa.com/wisp/mono2/merge_requests/1401) | skipzhang | success | cannot_be_merged | 22.8d | `promote-beijing-sandbox-service-gateway-service-gateway-323f59417727 -> gitops` |
| !1403 | [发布到北京 Playground sandbox-bj-7：lightclaw-auth](https://git.woa.com/wisp/mono2/merge_requests/1403) | skipzhang | success | cannot_be_merged | 22.8d | `promote-sandbox-bj-7-lightclaw-auth-user-auth-b03b39b868f6 -> gitops` |
| !1429 | [发布到北京测试：vibebase](https://git.woa.com/wisp/mono2/merge_requests/1429) | skipzhang | success | cannot_be_merged | 22.0d | `promote-beijing-sandbox-vibebase-vibebase-1a28414f618a -> gitops` |
| !1438 | [发布到北京 Playground sandbox-bj-7：lightclaw-auth](https://git.woa.com/wisp/mono2/merge_requests/1438) | skipzhang | success | cannot_be_merged | 21.9d | `promote-sandbox-bj-7-lightclaw-auth-user-auth-77da3cd95f8e -> gitops` |
| !1440 | [发布到北京 Playground sandbox-bj-7：lightclaw-auth](https://git.woa.com/wisp/mono2/merge_requests/1440) | skipzhang | success | cannot_be_merged | 21.9d | `promote-sandbox-bj-7-lightclaw-auth-user-auth-a3aa994107d0 -> gitops` |
| !1491 | [发布到北京测试：sandbox](https://git.woa.com/wisp/mono2/merge_requests/1491) | skipzhang | success | cannot_be_merged | 21.4d | `promote-beijing-sandbox-sandbox-sandbox-419255040e93- -> gitops` |
| !1496 | [发布到shanghai-workers：workers-rescue-exporter](https://git.woa.com/wisp/mono2/merge_requests/1496) | skipzhang | success | cannot_be_merged | 21.1d | `promote-shanghai-workers-workers-rescue-exporter-workers-2b6e39b713c2 -> gitops` |
| !1498 | [发布到北京测试：admin-gateway](https://git.woa.com/wisp/mono2/merge_requests/1498) | skipzhang | success | cannot_be_merged | 21.1d | `promote-beijing-sandbox-admin-gateway-admin-gateway-2b6e39b713c2 -> gitops` |
| !1508 | [发布到北京 Playground sandbox-bj-7：trade](https://git.woa.com/wisp/mono2/merge_requests/1508) | skipzhang | success | cannot_be_merged | 20.9d | `promote-sandbox-bj-7-trade-trade-7f8144e8789f -> gitops` |
| !1524 | [发布到TKEx 广州内网：cloudladdergateway](https://git.woa.com/wisp/mono2/merge_requests/1524) | skipzhang | success | cannot_be_merged | 20.8d | `promote-tkexgz-cloudladdergateway-cloudladdergateway-d0f978c6cd52 -> gitops` |
| !1525 | [发布到TKEx 新加坡内网：cloudladdergateway](https://git.woa.com/wisp/mono2/merge_requests/1525) | skipzhang | success | cannot_be_merged | 20.8d | `promote-tkexsg-cloudladdergateway-cloudladdergateway-d0f978c6cd52 -> gitops` |
| !1532 | [发布到TKEx 广州内网：cloudladdergateway](https://git.woa.com/wisp/mono2/merge_requests/1532) | skipzhang | success | cannot_be_merged | 20.8d | `promote-tkexgz-cloudladdergateway-cloudladdergateway-2c76770810a2 -> gitops` |
| !1533 | [发布到TKEx 新加坡内网：cloudladdergateway](https://git.woa.com/wisp/mono2/merge_requests/1533) | skipzhang | success | cannot_be_merged | 20.8d | `promote-tkexsg-cloudladdergateway-cloudladdergateway-2c76770810a2 -> gitops` |
| !1545 | [发布到TKEx 广州内网：cloudladdergateway](https://git.woa.com/wisp/mono2/merge_requests/1545) | skipzhang | success | cannot_be_merged | 20.7d | `promote-tkexgz-cloudladdergateway-cloudladdergateway-3d07fd690a8f -> gitops` |
| !1546 | [发布到TKEx 新加坡内网：cloudladdergateway](https://git.woa.com/wisp/mono2/merge_requests/1546) | skipzhang | success | cannot_be_merged | 20.7d | `promote-tkexsg-cloudladdergateway-cloudladdergateway-3d07fd690a8f -> gitops` |
| !1558 | [发布到shanghai-workers：workers-rescue-exporter](https://git.woa.com/wisp/mono2/merge_requests/1558) | skipzhang | success | cannot_be_merged | 20.5d | `promote-shanghai-workers-workers-rescue-exporter-workers-4abec11fad78 -> gitops` |
| !1561 | [发布到shanghai-workers：workers-rescue-exporter](https://git.woa.com/wisp/mono2/merge_requests/1561) | skipzhang | success | cannot_be_merged | 20.4d | `promote-shanghai-workers-workers-rescue-exporter-workers-0494bd8d5a41 -> gitops` |
| !1572 | [发布到shanghai-workers：workers-rescue-exporter](https://git.woa.com/wisp/mono2/merge_requests/1572) | skipzhang | success | cannot_be_merged | 19.9d | `promote-shanghai-workers-workers-rescue-exporter-workers-3eda220ff772 -> gitops` |
| !1577 | [发布到DevCloud dep：cloudagent-gateway](https://git.woa.com/wisp/mono2/merge_requests/1577) | skipzhang | success | cannot_be_merged | 19.7d | `promote-devcloud-dep-cloudagent-gateway-cloudagent-gateway-3b2badbd77f4 -> gitops` |
| !1584 | [Preserve DevCloud CloudAgent internal load balancer](https://git.woa.com/wisp/mono2/merge_requests/1584) | skipzhang | success | cannot_be_merged | 17.9d | `codex/devcloud-cloudagent-internal-lb -> gitops` |
| !1593 | [发布到北京测试：service-gateway](https://git.woa.com/wisp/mono2/merge_requests/1593) | skipzhang | success | cannot_be_merged | 17.7d | `promote-beijing-sandbox-service-gateway-service-gateway-4365404cf28a -> gitops` |
| !1594 | [发布到TKEx 广州内网：cloudladdergateway](https://git.woa.com/wisp/mono2/merge_requests/1594) | skipzhang | success | cannot_be_merged | 17.7d | `promote-tkexgz-cloudladdergateway-cloudladdergateway-4365404cf28a -> gitops` |
| !1595 | [发布到TKEx 新加坡内网：cloudladdergateway](https://git.woa.com/wisp/mono2/merge_requests/1595) | skipzhang | success | cannot_be_merged | 17.7d | `promote-tkexsg-cloudladdergateway-cloudladdergateway-4365404cf28a -> gitops` |
| !1599 | [发布到DevCloud dep：cloudagent-gateway](https://git.woa.com/wisp/mono2/merge_requests/1599) | skipzhang | success | cannot_be_merged | 17.7d | `promote-devcloud-dep-cloudagent-gateway-cloudagent-gateway-70e9dfe0cbcf -> gitops` |
| !1642 | [发布到TKEx 新加坡内网：cloudladdergateway](https://git.woa.com/wisp/mono2/merge_requests/1642) | skipzhang | success | cannot_be_merged | 16.3d | `promote-tkexsg-cloudladdergateway-cloudladdergateway-72d3eb0f5df3 -> gitops` |
| !1649 | [发布到shanghai-workers：workers-rescue-exporter](https://git.woa.com/wisp/mono2/merge_requests/1649) | skipzhang | success | cannot_be_merged | 15.8d | `promote-shanghai-workers-workers-rescue-exporter-workers-9c7eb85e25dd -> gitops` |
| !1650 | [发布到北京测试：admin-gateway](https://git.woa.com/wisp/mono2/merge_requests/1650) | skipzhang | success | cannot_be_merged | 15.8d | `promote-beijing-sandbox-admin-gateway-admin-gateway-9c7eb85e25dd -> gitops` |
| !1658 | [发布到TKEx 广州内网：cloudladdergateway](https://git.woa.com/wisp/mono2/merge_requests/1658) | skipzhang | success | cannot_be_merged | 15.7d | `promote-tkexgz-cloudladdergateway-cloudladdergateway-c349dd7ac165 -> gitops` |
| !1660 | [发布到TKEx 新加坡内网：cloudladdergateway](https://git.woa.com/wisp/mono2/merge_requests/1660) | skipzhang | success | cannot_be_merged | 15.7d | `promote-tkexsg-cloudladdergateway-cloudladdergateway-c349dd7ac165 -> gitops` |
| !1665 | [发布到TKEx 广州内网：cloudladdergateway](https://git.woa.com/wisp/mono2/merge_requests/1665) | skipzhang | success | cannot_be_merged | 15.7d | `promote-tkexgz-cloudladdergateway-cloudladdergateway-e94b99449c13 -> gitops` |
| !1666 | [发布到TKEx 新加坡内网：cloudladdergateway](https://git.woa.com/wisp/mono2/merge_requests/1666) | skipzhang | success | cannot_be_merged | 15.7d | `promote-tkexsg-cloudladdergateway-cloudladdergateway-e94b99449c13 -> gitops` |
| !1669 | [发布到北京测试：vibebase](https://git.woa.com/wisp/mono2/merge_requests/1669) | skipzhang | success | cannot_be_merged | 15.6d | `promote-beijing-sandbox-vibebase-vibebase-1a1611bb976b -> gitops` |
| !1693 | [发布到shanghai-workers：workers-rescue-exporter,workers-hermes-importer](https://git.woa.com/wisp/mono2/merge_requests/1693) | skipzhang | success | cannot_be_merged | 14.6d | `promote-shanghai-workers-workers-rescue-exporter-workers-hermes-importer-workers-cc89da63a5ab -> gitops` |
| !1694 | [发布到北京测试：admin-gateway](https://git.woa.com/wisp/mono2/merge_requests/1694) | skipzhang | success | cannot_be_merged | 14.6d | `promote-beijing-sandbox-admin-gateway-admin-gateway-cc89da63a5ab -> gitops` |
| !1718 | [发布到shanghai-workers：workers-rescue-exporter,workers-hermes-importer](https://git.woa.com/wisp/mono2/merge_requests/1718) | skipzhang | success | cannot_be_merged | 12.7d | `promote-shanghai-workers-workers-rescue-exporter-workers-hermes-importer-workers-4f5fe230fc40 -> gitops` |
| !1721 | [发布到shanghai-workers：workers-rescue-exporter,workers-hermes-importer](https://git.woa.com/wisp/mono2/merge_requests/1721) | skipzhang | success | cannot_be_merged | 12.7d | `promote-shanghai-workers-workers-rescue-exporter-workers-hermes-importer-workers-1cb49c3809f2 -> gitops` |
| !1807 | [发布到北京 Playground sandbox-bj-7：trade](https://git.woa.com/wisp/mono2/merge_requests/1807) | skipzhang | success | cannot_be_merged | 9.0d | `promote-sandbox-bj-7-trade-trade-86aecd23134e -> gitops` |
| !1809 | [发布到北京 Playground sandbox-bj-7：trade](https://git.woa.com/wisp/mono2/merge_requests/1809) | skipzhang | success | cannot_be_merged | 8.9d | `promote-sandbox-bj-7-trade-trade-d5e5309ddc1f -> gitops` |
| !1881 | [发布到北京测试：vibebase](https://git.woa.com/wisp/mono2/merge_requests/1881) | skipzhang | success | cannot_be_merged | 3.8d | `promote-beijing-sandbox-vibebase-vibebase-296ea82c4b8e -> gitops` |
| !1893 | [发布到北京测试：admin-gateway](https://git.woa.com/wisp/mono2/merge_requests/1893) | skipzhang | success | cannot_be_merged | 3.6d | `promote-beijing-sandbox-admin-gateway-admin-gateway-438ed76981ea -> gitops` |
| !1917 | [发布到shanghai-workers：workers-rescue-exporter,workers-hermes-importer](https://git.woa.com/wisp/mono2/merge_requests/1917) | skipzhang | success | can_be_merged | 2.5d | `promote-shanghai-workers-workers-rescue-exporter-workers-hermes-importer-workers-bbe4a1dd00d9 -> gitops` |

## 今日建议日会议题

1. 待合入：团队视图有 3 个 MR 已满足 CI success + can_be_merged，建议确认 owner 后尽快合入。
2. 待评审/修复：团队视图有 13 个未满足合入条件；其中 CI failure 7、cannot_be_merged 8、unchecked 0。
3. 超时 MR：团队非发布 >24h 共 12 个，优先看 !823 38.9d, !1078 29.7d, !1174 29.0d。
4. 发布 MR 清理：skipzhang 发布类 MR 共 65 个，建议集中判断已过期 promote 分支是否关闭，避免污染团队主视图。
