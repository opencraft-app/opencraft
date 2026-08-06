# 静态建站二期交接文档（COS + 自建反代）

- 日期：2026-08-06
- 分支：`codex/site-cos-gateway`（已推远端，**不要合 master**）
- 设计方案：`docs/proposals/2026-08-06-cos-site-gateway.md`
- 产品试用说明：`docs/handover/2026-08-06-cos-site-gateway-test-guide.md`
- 一期存档分支：`codex/tcb-cloudbase-site-legacy`（已推远端）

## 一、这是什么

把用户静态站点从 CloudBase（TCB）托管迁到**自建 COS 桶 + 自研反代**，每个站点一个子域名。

换栈的原始动因是「TCB 做不了用户级别的数据隔离，所以自己做文件存储模拟 db」，但**产品后来决定不做数据面**（见第四节），所以最终形态是纯静态托管。换栈的收益变成：流量可控、子域名归我们、去掉 TCB 环境容量管理（删了 577 行）、到期下线和违规封禁都在自己手里。

## 二、当前状态

**已提交并推送**（4 个提交，HEAD `c4a650cac`）

```
c4a650cac  建站 Skill 与方案文档同步纯静态形态
31154e2f1  建站功能改名为「我的作品」
4c3d7a36c  站点网关收敛为纯静态托管
d3ee23a09  站点生命周期改为保留文件，新增死信操作恢复
```

**北京测试环境线上镜像**

| 服务 | namespace | tag |
|---|---|---|
| `site-gateway` | `ctl` | `cos-gateway-20260806-static-only` |
| `ctl-api-cloudbase` | `ctl` | `cos-site-lifecycle-20260806-2012` |
| `website-deployer` | `temporal-workers` | `cos-site-lifecycle-20260806-2012` |
| 前端 | Cloudflare Pages | 部署 ID 见 CF 控制台，含「我的作品」改名 |

**云资源**

- COS 桶 `test-vela-user-sites-1388575217`（ap-beijing，私有读，匿名访问 403）
- 泛域名 `*.sites.lightclaw.tech` → CLB `lb-kbl26vb5`，Ingress `lightclaw-sites-public`（`ctl` ns，class `qcloud`）
- CAM 子账号（密钥 ID 前 8 位 `AKIDBF7l`），策略 `vela-site-cos-bucket-scoped` 限定到本桶 `sites/*` 与 `_artifacts/*`

## 三、架构

```
浏览器 → http://{siteID}.sites.lightclaw.tech/
       → CLB（泛域名，direct-access 直连 Pod）
       → site-gateway（ctl ns，2 副本，无状态）
            ├─ Host 推出 siteID（隔离基石，前端无法伪造）
            ├─ 查站点状态（ctl 内部接口 + 30s TTL 缓存）
            └─ COS 回源 sites/{siteID}/current/**

管控面：ctl（配额/生命周期）──Redis 队列──> website-deployer（COS 操作）
```

COS 目录布局：

```
sites/{siteID}/current/**                对外服务的稳定目录
sites/{siteID}/releases/{releaseID}/**   发布暂存，成功后同步到 current/ 并被清理（已实测）
_artifacts/{siteID}/{releaseID}.zip      上传的制品
```

## 四、关键决策与理由（改动前请先读这一节）

**数据面已移除。** 曾完整实现 `/__vela/data/*` 五个接口并通过 62 项真实 COS 验证，因产品决定「只做静态托管、不要 db」而移除。备份在 `~/vela-dataplane-snapshot-20260806/`（仓库外，带 README）。恢复前必须先解决**无鉴权的公开读写**——那是它被移除的核心技术遗留。

**到期与销毁都不删文件。** 产品决定不真实删除用户数据。到期→`suspended`、销毁→也是 `suspended`，反代按状态返 403 且不回源，COS 一个字节不动；续费→`active`，立刻恢复且无延迟。一期在 TCB 上必须删 `current/` 才能下线，是因为托管层不是我们的；现在反代自研，下线只是一次状态变更。

**唯一真删入口是用户主动删除**，清 `sites/{siteID}/` + `_artifacts/{siteID}/`。站点行**软删不硬删**——文件永久保留之后，`website_sites` 表是唯一能把桶里对象对应回归属的依据。

**阻塞语义是分裂的，这是刻意的。** 隔离侧站点钩子是 pass 隔离任务的**阻塞步骤**（失败重试，永不放弃）；销毁侧仍是 **best-effort**（产品决定，避免阻塞计费状态收敛）。销毁侧失败的后果已从「漏删 COS 持续产生成本」降级为「站点状态没跟上、可能仍对外服务」。

**站点地址是过渡形态。** `*.sites.lightclaw.tech` 只是 PoC，正式根域待申请，代码里根域全部走配置不硬编码。

## 五、待办

**需要产品/业务确认**

1. 发布日的放量节奏——迁移会给全部 7 个套餐写入建站配额，等于同时对这些套餐用户开放。
2. 销毁后的站点若用户重新买套餐，续费联动会把它转回 `active` 并恢复对外服务（因为销毁和到期共用 `suspended`）。在「文件永久保留」模型下这应是期望行为，但属默认行为需明示。
3. 建站入口：界面上没有「新建作品」按钮，只能在对话里说「帮我建个网站」。是设计还是缺口？
4. 发布后首次访问有 6–10 秒延迟（发布任务在产物上传完成前被唤醒，靠重试兜住）。可接受则维持，否则改成上传完成后显式触发（API 多一个端点、Skill 流程多一步）。
5. 站点地址是随机 hex，要不要支持用户自定义子域名（涉及命名冲突、敏感词、抢注）。
6. 新根域申请进度与泛域名证书方案。

**工程待办**

1. **HTTPS 未收口。** Let's Encrypt 通配符证书已签发（`*.sites.lightclaw.tech`，**90 天，2026-11-04 到期**），文件在 `/tmp/sites-wildcard-cert/`（`/tmp` 会被清理，需尽快转移）。腾讯云 CLB **只认带 `qcloud_cert_id` 的 Opaque secret**，`kubernetes.io/tls` 会报 `E4011`——正确做法是 `tccli ssl UploadCertificate` 导入拿 certId、secret 里只放 certId。参照 `frontend-preview` ns 里已工作 94 天的 `preview-lightclaw-tech-wildcard-tls` 照抄形式。目前 Ingress 无 TLS 段、`WEBSITE_SITE_URL_SCHEME=http`。
2. **证书续期无自动化。** 90 天到期，需要集群内 CronJob 跑 acme.sh + DNSPod API 自动更新 secret。
3. **销毁侧可观测性未做**：`dead` operation 数、`deleting` 超期站点数的指标告警。这是销毁侧 best-effort 的唯一兜底。
4. **北京测试库 schema 记账损坏**，`schema_migrations` 停在 27 但 000029+ 的表列基本都在（历史上手工跑过 SQL，还有一张 `schema_migrations_backup_20260805_ci_fix` 作证）。现在 `migrate up` 会在 000028 撞重复列失败。**上海生产是干净的**（单行 `version=27, dirty=0`，无任何 website 表）。上生产前应在测试环境完整演练一遍这批迁移，否则演练结果不可信。另有孤儿列 `attempt_count` 等漂移，建议一并清理，且**要在演练之前做**。
5. **`ctl-service` 由 ArgoCD 自愈托管**，`set image` 一分钟内被拉回 master 镜像。所以 pass 隔离/销毁钩子的改动**在测试环境要等分支通过 GitOps 才生效**，目前生效的只有 `ctl-api-cloudbase` 和 `website-deployer`。验证时需临时起不受管的 sibling worker。
6. **平台缺口：Vela token 从未注入过实例。** 全库 `VELA_AUTH_TOKEN` / `VELA_API_BASE` / `~/.vela/auth-token` 只出现在 SKILL.md 自己里，没有任何代码注入。前端拿到的 `GatewayToken` 是入站凭据，不是实例反向调 Vela API 的出站凭据。**生产用户机器同样没有**，意味着真实用户在对话里建站按现状走不通。6 台测试机器已手工补齐各自账号的 `~/.vela/auth-token` + `~/.vela/api-base`（600 权限、ext4 跨重启）。正确修法：在 `configureOnboard` 旁按实例所属环境注入 API base，并签发**实例作用域凭据**而不是复用浏览器 session。
7. **LLM key 后端缺陷**：平台注入的 `custom` provider（`http://10.15.226.135/v1`）在 test1/test2/test3 全部 401，走控制台「重置配置」重铸新 key 依然 401。判断是 ctl 铸的 key 不被那个数据面认，属网关/计费侧。**test1、test2 无法对话**，试用请用 test3~test6。
8. **腾讯云账号欠费 73.5 万**（可用余额 -73.7 万，`IsAllowArrears=false`），所有新购操作被拒。付费证书就是因此下不了单（API 报的是笼统的 `InvalidParam`）。
9. **`pnpm check` 是空转门禁**：根 `tsconfig.json` 是 `files: []` + project references，`tsc --noEmit` 不带 `--build` 什么都不检。手动 `tsc -p tsconfig.app.json` 有约 324 条既存报错。不要把它通过当成类型没问题。
10. 前端两个小问题待修：面板副标题从未渲染（prop 名 `subtitle` vs 组件的 `description`，就是上面那 324 条之一）；英文作品列表右上角显示 `Total 1 agent(s)`（「共/个」key 与 Agent 列表共用，译文写死 agent）。
11. `frontend/src/pages/app/website-page.tsx` 是死代码（`/websites` 重定向到 `/agents/websites`），要么删要么明确定位。
12. Skill 目录名 `cloudbase-site-builder` 已不准确，但**机器侧改名有风险**（要在 6 台上各建新目录再删旧目录，任一台删除失败就会两份 SKILL.md 并存、给 agent 灌矛盾指令）。免费的改名时机是接入正式分发通道那一刻，清单见方案第 13.1 节。

## 六、进行中（未提交）

**第三轮：流量与存储计量 + 超额拦截 + 制品保留 + `creating` 缺口修复**

代码在工作区，横跨 `site-gateway/`、`ctl/`、`workers/`，含三个迁移（`000040` 改空操作、`000048` 加 `storage_bytes`、`000049` 抬流量额度）和 8 个测试文件。**未部署、未端到端验收。**

已定的设计：反代内存聚合、每 1 分钟批量上报给 ctl、不引入 Redis（多副本各自上报、ctl 累加）；字节数以实际写给客户端的响应体为准（HEAD/304 无 body）；拦在反代层返 403 且不回源；一期额度抬到实际不可达的值（有闸但不误伤）；制品**只留最新一份**（可配置，默认 1）——留 zip 原本唯一目的是「续费恢复」，该用途随生命周期改造消失。

精度必须承认：上报间隔 1 分钟 + 缓存 TTL 30 秒，超额到拦住约 90 秒延迟，多副本各自计数。**它是滥用防护的闸，不是计费凭据。**

接手第一步：跑三个模块门禁 → 推镜像（用 crane，见第七节）→ 部署验证 → 提交。

**未做的前端部分**：`used_traffic_bytes` / `used_storage_bytes` 两个数字的展示，以及上面第 10 条那两个小修。建议和后端一起验完再发一次版。

## 七、踩过的坑（省时间用）

**镜像推送不要用 DevCloud 的 `docker push`。** 上行只有 54 KB/s，ctl 镜像 126MB 要 40 分钟以上，今天为此浪费了一个多小时。正确做法是**本机交叉编译 + `crane append`**，实测 **5 秒级**：

```bash
cd ctl && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /tmp/l/usr/local/lightglobal/bin/api ./main/api
cd /tmp/l && tar cf /tmp/layer.tar usr/local/lightglobal/bin/api   # plain tar，不要 gzip
mkdir -p /tmp/crane-docker-config
AUTH=$(echo -n "100045199955:${TCR_TOKEN}" | base64)
printf '{"auths":{"lightclaw-bj8.tencentcloudcr.com":{"auth":"%s"}}}' "$AUTH" > /tmp/crane-docker-config/config.json
DOCKER_CONFIG=/tmp/crane-docker-config crane append --base <当前线上tag> --new_layer /tmp/layer.tar --new_tag <新tag>
```

本机有 `crane 0.21.7`，**没有 docker**。`crane auth login` 会去找 docker-credential-desktop 然后失败，必须手写 `DOCKER_CONFIG`。TCR 令牌从 K8s secret `tcr.ipsqcloudregistrykey` 取，用户名固定 `100045199955`。推完用 `crane manifest` 确认真的进了 TCR。

**腾讯云 CLB Ingress 不开 `direct-access` 就只接受 NodePort/LoadBalancer 后端**，而本集群节点端口转发不通，表现是稳定 504 且网关无任何请求日志。必须带 `direct-access: "true"` + `pass-to-target: "true"`，Service 保持 ClusterIP。改 Ingress 时**务必保留** `direct-access` / `pass-to-target` / `modification-protection` 三个注解。

**泛域名证书只覆盖一级标签。** `*.lightclaw.tech` 覆盖不了 `*.sites.lightclaw.tech`。腾讯云**免费 DV 证书不支持通配符**（官方文档明确，报错却是误导性的「当前CA机构访问繁忙」，别以为是排队）。

**`cos:prefix` 条件键的值必须 urlencode**，写 `sites/*` 会一直 403，要写 `sites%2F*`。

**内联 `env` 会覆盖 `envFrom`。** 往 secret 里加了键还不够，如果 deployment 上原本有同名内联明文，必须改成 `secretKeyRef` 才生效。今天有一对 `WEBSITE_COS_SECRET_ID/KEY` 就是挂着但代码不读、改成读之后才发现值是 CloudBase 时代抄来的、对新桶只有 `AccessDenied`。

**`wrangler pages deploy` 必须带 `--branch=main`**，不带会拿当前 git 分支名当 Pages branch，部署落到预览别名而 `lightclaw.pages.dev` 完全不变，且 wrangler 照样返回成功。部署后一定对比资产 hash。

**COS 的 PUT Object 不支持 `If-Match`**（官方文档只有 `x-cos-forbid-overwrite`；SDK 里的 `If-Match` 全是 `x-cos-copy-source-If-Match`，那是 Copy 的源条件）。网上说支持的是把 HEAD Object 的读侧条件请求张冠李戴了。

**测试账号：`~/.codex/skills/lightclaw-credentials/SKILL.md` 第九节里 User 5 的 token 是错的**（系统里查无此记录，当初抄错），正确的在 `docs/handover/2026-08-06-cos-site-gateway-test-guide.md`。test1/test2 因 LLM key 问题不能对话。

**编排教训**：不要把七件事塞进一个 subagent 任务——外部看不到中间进度，而且中途修正需要打断，打断会让当前回合作废。今天两次打断分别浪费了 40 分钟的镜像推送和一轮代码编写。非紧急修正应攒到回合自然结束时再给。
