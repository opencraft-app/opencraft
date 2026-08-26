# 国内站 URL 结构迁移：去掉 `/zh-cn/` 前缀

> 状态：**代码侧已完成并测试验证；301 规则已随构建产物落地，生效性待生产验收（见 2.3）**
> ｜创建日期：2026-08-19｜更新：2026-08-20
>
> 目标：`lightvela.com` 只保留裸路径作为唯一正式 URL，站内不再产生任何 `/zh-cn/` 链接。

---

## 0. 为什么要做

`lightvela.com` 只有一种语言（zh-CN），裸路径本身就是中文站 URL。但历史实现同时生成了
`/zh-cn/` 前缀路由并返回 200，导致三个问题：

1. **重复内容**：`/about/` 与 `/zh-cn/about/` 内容完全相同，权重被分散；
2. **信号自相矛盾**：页面 self-canonical 指向裸路径，而 hreflang / sitemap 指向 `/zh-cn/`；
3. **索引不可控**：Google 需自行判定主版本，可能选错。

对 GEO 的影响：AI 检索引擎抓到两套同内容 URL 时，会降低对站点结构的置信度。

---

## 1. 代码侧改动（已完成）

### 1.1 停止生成 `/zh-cn/*` 静态路由

| 文件 | 改动 |
|---|---|
| `frontend/next-site/seo.tsx` | 新增 `SEO_PREFIXED_PUBLIC_URL_LANGS` / `SEO_PREFIXED_DOCS_ROUTE_LOCALES`，国内站为 `[]` |
| `frontend/src/app/(site)/[lang]/*/page.next.tsx`（9 个） | `generateStaticParams` 改用 `SEO_PREFIXED_PUBLIC_URL_LANGS` |
| `frontend/src/app/(site)/[lang]/docs/[[...slug]]/page.next.tsx` | `REGION_DOCS_ROUTE_LOCALES` 国内站改为 `[]` |

涉及的 9 个公共页面：首页、about、changelog、cookie-policy、privacy-policy、
open-source-licenses、subscribe、support、terms-of-service。

**注意**：`SEO_PUBLIC_URL_LANGS`（表示「本站支持哪些语言」）保持不变，
它仍用于 hreflang 集合与 locale 解析；新常量只控制「是否生成前缀路由」。

### 1.2 修正 hreflang 中的 zh-CN 目标

`frontend/next-site/seo.tsx` 的 `buildPublicAlternates()` / `buildDocsAlternates()`：

改动前 —— 只有 `en-us` 用裸路径，`zh-cn` 走 `localizedPublicPath()`：

```
hreflang="zh-CN" href="https://lightvela.com/zh-cn/docs/overview/"   ❌
```

改动后 —— 新增 `usesBarePathForUrlLang()`，`en-us` 与 `zh-cn` 均用裸路径：

```
hreflang="zh-CN" href="https://lightvela.com/docs/overview/"          ✅
```

这是本次最关键的修复：原实现让**国际站输出的 148 处 zh-CN hreflang 全部指向需 301 的 URL**，
Google 会因「hreflang 目标无效」丢弃整组语言关系。

### 1.3 Sitemap 清理

`frontend/src/app/sitemap.xml/route.next.ts`：

| 项 | 改动 |
|---|---|
| `/zh-cn/*` 条目 | 国内站不再输出带前缀的 `loc`（`localizedPublicLangs` / `localizedDocsEntries` 在国内站为空） |
| `/docs/` 空 slug | 两站统一排除（该 URL 会跳转到 `/docs/overview/`，sitemap 只收录 200 终点） |

原实现中 `.filter((slug) => !globalBuild || slug.length > 0)` 的条件写反了 ——
`!globalBuild` 在国内站恒为 true，导致国内站**从未**排除空 slug。

### 1.4 回归测试（2026-08-20 补）

`frontend/src/app/sitemap.xml/__tests__/sitemap-route.test.ts`（6 断言）
mock 掉构建期生成的 `docs-route-manifest`，对 cn / global 两个 region 分别执行 `GET()`
并解析 XML，锁定：

| 断言 | 覆盖的历史缺陷 |
|---|---|
| cn 的 `<loc>` 全为 `lightvela.com` 裸路径，无 `/zh-cn/` | 1.1 / 1.3 |
| cn 的 `<loc>` 精确等于 7 公共页 + 2 文档页，不含 `/docs/` | filter 条件写反 |
| cn 的 `hreflang="zh-CN"` 不含 `/zh-cn/` | 1.2 |
| global 输出 `/zh-sg/`、`/zh-hant/`、`/id-id/`，但无 `/en-us/`、无 `/zh-cn/` | 默认语言重复 URL |
| global 同样排除 `/docs/` 空 slug | — |
| global 的 `hreflang="zh-CN"` 跨域指向 `lightvela.com` 裸路径 | 1.2（148 处） |

`frontend/next-site/seo.test.ts` 新增 cn 用例，锁定 canonical / `og:url` / hreflang
三者一致指向裸路径（含公共页与文档页）。

**变异测试**（确认断言真的有效，非空跑）：

| 注入的缺陷 | 结果 |
|---|---|
| `localizedPublicLangs` 恢复为不区分 region | 2 failed ✅ |
| `.filter` 恢复为 `!globalBuild \|\| slug.length > 0` | 1 failed ✅ |

**国际站实测**（dev server `:5174`）：sitemap 共 256 条 `loc`，
其中 `/zh-cn/` 前缀 0 条、`/en-us/` 前缀 0 条、`/docs/` 空 slug 0 条；
`/docs/plans/` 页面 head 的 canonical、`og:url` 均为 `https://lightvela.ai/docs/plans/`，
`hreflang="zh-CN"` 为 `https://lightvela.com/docs/plans/`。

---

## 2. 301 怎么做（2026-08-20 落地）

`frontend/next.config.mjs` 中 `output: 'export'`（静态导出），
**Next.js 的 `redirects()` 在静态导出下不生效**。301 必须在 CDN / 网关层配置。

### 2.0 风险复评：GSC 已收录约几十条 `/zh-cn/`（结论已推翻）

**2026-08-20 更新**：产品侧查 GSC，`/zh-cn/` 已收录**约几十条**。
这条事实推翻了本节上一版的结论（当时按「基本没有投放 → 可以不管」处理）。

| | 上一版判断 | 现在 |
|---|---|---|
| GSC 收录量 | 假设 0 或个位数 | **约几十条** |
| 不配 301 的后果 | 几乎无损失 | 几十条已收录 URL 变 404，**索引与权重直接丢弃** |
| 301 优先级 | 有窗口时顺手配 | **必做项，随本次发版一起上** |

需要说清「基本没有投放」在这里到底影响了什么、没影响什么：

- ✅ **仍然成立**：没有付费投放链接指向 `/zh-cn/`，所以**没有用户体验事故**
  （不会有人从广告点进来撞 404），因此它不是「上线阻塞」级别的故障；
- ❌ **不再成立**：「损失很小」。投放为零不代表索引为零 ——
  这几十条是 Google 自己爬到的（历史上 `/zh-cn/*` 返回 200，
  而且旧 sitemap 主动提交过这批 URL）。
  404 掉的是**已经积累的索引信号**，这部分和投放无关。

Google 对两种处理的区别：

| 处理 | Google 行为 |
|---|---|
| 404 / 410 | 从索引移除，历史信号**不传递**给裸路径，等于白扔 |
| 301 | 索引合并到裸路径，信号传递，通常数周内完成切换 |

几十条不算大量，但 301 的成本本来就接近零，没有理由选择白扔。

### 2.1 怎么做：不是手工配 nginx，而是 `edgeone.json` 随产物发布

先纠正一个容易走错的方向：**这里没有 nginx**。实际链路是：

```
pnpm build:cn                        → out/.edgeone/（EdgeOne Build Output 形态）
scripts/deploy-edgeone-pages.mjs     → edgeone makers deploy out/.edgeone
.ci/frontend-edgeone-lightvela.yml   → COMBO=eo:cn-lightvela-prod-next
```

EdgeOne Pages 的重定向来自 **`edgeone.json` 的 `redirects`**（或控制台项目设置）。
因为国内站 / 国际站是同一份源码两次构建、规则又不同，
所以规则由构建期生成，而不是在仓库里放一份静态文件：

| 文件 | 作用 |
|---|---|
| `frontend/scripts/write-edgeone-config.mjs` | 按 region 生成 `edgeone.json`（唯一事实来源） |
| `frontend/scripts/write-edgeone-config.test.ts` | 10 断言，锁定规则内容 + 落位 + region 兜底 |
| `package.json` 的 `build` / `build:cn` / `build:global` / `build:next` | 构建链中调用 |
| `scripts/build-release-artifacts.mjs` | artifact 构建链中调用（**在 `cpSync` 之前**，否则进不了 artifact） |

#### ⚠️ 最容易静默失效的一点：写错目录

上传的是 `out/.edgeone`，**不是** `out`（见 `deploy-edgeone-pages.mjs` 的 `resolveDeployDir()`：
存在 `.edgeone` 就用它）。如果把 `edgeone.json` 写到 `out/` 根，
它根本不会进入上传目录 —— 配置失效，且**没有任何报错**。

所以生成脚本直接复用 `resolveDeployDir()` 来决定落位，两处判定不可能漂移。
测试里有两条断言专门盯这个陷阱。

#### 实际生成的规则

国内站（5 条）：

```json
{
  "redirects": [
    { "source": "/zh-cn",   "destination": "/",                 "statusCode": 301 },
    { "source": "/zh-cn/",  "destination": "/",                 "statusCode": 301 },
    { "source": "/zh-cn/*", "destination": "/:splat",           "statusCode": 301 },
    { "source": "/docs",    "destination": "/docs/overview/",   "statusCode": 301 },
    { "source": "/docs/",   "destination": "/docs/overview/",   "statusCode": 301 }
  ]
}
```

国际站（2 条）：只有 `/docs` → `/docs/overview/`。
国际站从未有过 `/zh-cn/` 路由，加了只是死配置；`/en-us/*` 是否收敛属产品决策，未擅自 301。

设计要点：

- `/zh-cn/*` → `/:splat` 一条覆盖全部子路径，**保留完整路径**，
  绝不是「全部跳首页」：`/zh-cn/docs/plans/` → `/docs/plans/`；
- 前缀本身（`/zh-cn`、`/zh-cn/`）才允许落到 `/`，单独两条精确规则兜住
  （`*` 是否匹配空串没有文档保证）；
- `trailingSlash: true`，线上 URL 带尾斜杠，而 EdgeOne 是否归一化尾斜杠没有文档保证，
  故 `/docs` 与 `/docs/` 两种写法都登记 —— 多一条规则的成本可忽略。

#### `/docs/` 与 `/docs/overview/` 重复（纠正之前的说法）

之前本文档写「`/docs/` 会跳转到 `/docs/overview/`」，**这是错的**。实测（两站一致）：

```
GET /docs/            → 200，内容与 /docs/overview/ 相同，canonical = /docs/overview/
GET /docs/overview/   → 200，canonical = /docs/overview/
```

即它是一个**真实存在的重复 URL**，现在线上就有。完整处置见第 5 节。

⚠️ **这条 301 有个 `/zh-cn/` 没有的风险**：`out/docs/index.html` 是**真实存在的静态文件**，
而 `/zh-cn/*` 对应的文件已经不生成了。EdgeOne 在「redirects 规则」与「命中静态资源」
之间的优先级没有文档保证 —— 若静态文件优先，这条 301 会被静默遮蔽，`/docs/` 继续返回 200。
所以 `/docs/` 的**基础保障必须是 canonical（已就位），301 只是加分项**；
而 `/zh-cn/` 没有文件遮蔽问题，301 是它唯一的救命手段。

### 2.2 语法约束（EdgeOne Makers，踩前必读）

- **不支持正则**。只有精确路径、`:param`（单级）、`*`（通配，destination 用 `:splat`）；
- `source` 中**最多一个 `*`**；
- 用 `statusCode: 301`，**没有** Vercel / Next 的 `permanent` 字段（写了不生效）；
- `redirects` 上限 **100 条**，`source` / `destination` 各 ≤ 500 字符；
- 生成脚本内置了上述全部校验，违规直接构建失败，不会静默发出去。

### 2.3 验收（⚠️ 生效性尚未在生产验证）

**诚实标注**：`edgeone.json` 在「直传 Build Output（`.edgeone` 目录）」模式下是否被读取，
官方文档没有明确说明（Build Output 规范文档页当前 404）。
文档只保证「项目根目录的 `edgeone.json` 可覆盖控制台设置」，
而我们不是让 EdgeOne 拉源码构建。

因此上线时按这个顺序走：

1. 发一次国内站，然后逐条验：

```bash
curl -sI https://lightvela.com/zh-cn/docs/plans/ | grep -iE "^HTTP|^location"
# 期望：HTTP/2 301 + location: https://lightvela.com/docs/plans/
curl -sI https://lightvela.com/zh-cn/ | grep -iE "^HTTP|^location"   # → /
curl -sI https://lightvela.com/docs/  | grep -iE "^HTTP|^location"   # → /docs/overview/
```

2. **若返回 404 / 200 而不是 301**，说明该模式不读 `edgeone.json` ——
   直接去 EdgeOne 控制台的项目设置里把 2.1 的同样规则手工配一遍（控制台一定生效），
   并回来把本节结论改掉；生成的 `edgeone.json` 仍作为规则的单一事实来源保留。
3. 确认**无跳转链**：`/zh-cn/docs/plans/` 应一步到位，不要经过 `/zh-cn/docs/`；
4. 确认状态码是 301 不是 302；
5. GSC 提交新 sitemap，观察索引切换（通常数周）。

另外 `edgeone.json` 落在上传目录根，理论上可被 `https://lightvela.com/edgeone.json`
访问到（若 EdgeOne 不把它当配置消费）。内容只有重定向规则，无敏感信息，可接受；
验收时若发现它作为静态文件暴露，说明配置**未被消费**，等价于第 2 步的失败信号 ——
这反而是个很方便的探针。

### 2.4 兜底：控制台也配不出通配时怎么办

假如既不读 `edgeone.json`、控制台又只支持逐条精确规则（配不了 `/zh-cn/*`），
还有一个**不依赖任何 CDN 能力**的方案：在构建产物里生成 `/zh-cn/**/index.html`
跳转壳页 —— 内容只有 `<meta http-equiv="refresh" content="0;url=...">`
\+ `<link rel="canonical">` + `location.replace()`，无正文。

Google 明确说明「0 秒 meta refresh 会被当作永久重定向处理」，
信号强度略弱于真 301，但足以完成索引合并。

- 与「不再生成 `/zh-cn/` 路由」**不矛盾**：之前生成的是完整重复正文（200 + 全文），
  这里生成的是无内容跳转壳，canonical 指向裸路径，语义完全不同；
- 规模约 64 个文件（7 公共页 + 57 文档页），可由脚本镜像 `out/` 目录结构自动生成，
  无需维护清单；
- sitemap 不收录、站内无内链，不会产生新的重复内容。

**当前未实现** —— 因为控制台手配（2.3 第 2 步）几分钟就能解决，属更简单的路径。
只有在 2.3 与控制台**都走不通**时才需要它。

### 2.5 GSC 侧动作（针对已收录的那几十条）

发版并确认 301 生效后：

| 动作 | 做 / 不做 | 原因 |
|---|---|---|
| 提交新 sitemap | ✅ 做 | 新 sitemap 已不含 `/zh-cn/`，帮助 Google 重新发现裸路径 |
| 旧 sitemap 若单独提交过 | ✅ 删掉 | 否则持续给 Google 喂已废弃的 URL |
| 用「网址检查」抽验 3–5 条 `/zh-cn/` | ✅ 做 | 确认 Google 看到的是 301 而不是 404 |
| 「移除网址」工具 | ❌ **不要用** | 那只是临时隐藏（约 6 个月），会**阻断**信号传递，与 301 的目的相反 |
| 手工请求编入索引 | 🔸 可选 | 对裸路径做几条即可，几十条的量不必逐条点 |
| 301 保留多久 | **至少 12 个月** | Google 完成合并通常数周，但旧链接与外部引用会拖更久；规则在 `edgeone.json` 里，留着零成本 |

观察指标：GSC「页面」报告里 `/zh-cn/` 应逐步从「已编入索引」转为
「网页会自动重定向」，同时裸路径的展示 / 点击量接手。**通常数周，不要几天就下结论。**

---

## 3. 同步更新清单（图5）

| 项 | 状态 | 说明 |
|---|---|---|
| 全站导航与正文内部链接 | ✅ 本来就没问题 | `localizedPath()` 在 `!isGlobal` 时直接返回原路径，国内站站内链接从不带前缀 |
| `llms.txt` | ✅ 无需改 | 使用 `absoluteUrl()`，国内站输出裸路径 |
| JSON-LD 的 `url` | ✅ 已核 | 全部走 `siteUrl()` / `absoluteUrl()`，与 region 绑定，不含语言前缀 |
| Organization / WebSite / Breadcrumb Schema | ✅ 已核 | 同上；国际站 `/docs/plans/` 实测三类 Schema 均正常输出且 URL 为裸路径 |
| Open Graph URL | ✅ 已核 | `og:url` 复用 canonical 同一变量（`seo.tsx` 第 337/360 行），二者不可能不一致 |
| canonical | ✅ 已验证 | 国际站实测；国内站由 `seo.test.ts` 新增 cn 用例锁定为 `/about`、`/docs/plans` |
| hreflang | ✅ 已修 + 已测 | 见 1.2 / 1.4 |
| sitemap | ✅ 已修 + 已测 | 见 1.3 / 1.4，6 断言 + 2 组变异测试 |
| 腾讯云文章等重要外链 | ⬜ 需人工 | 站外资源；无投放，但已有几十条自然收录，值得顺手更新 |
| 登录 / 分享 / 二维码落地链接 | ⬜ 需人工核对 | 301 可兜住，仍建议直接改源 |

---

## 4. `/docs/` 与 `/docs/overview/` 重复怎么办

### 4.1 现状

```
GET /docs/          → 200，正文 = overview，canonical = /docs/overview/   ← 重复 URL
GET /docs/overview/ → 200，canonical = /docs/overview/                    ← 正主
```

成因：fumadocs 的 `source.ts` 用 `baseUrl: '/docs'`，
而 `generateStaticParams` 会为空 slug 也产出一个页面（`DOCS_ROUTE_SLUGS` 含 `[]`）。

### 4.2 三个选项与结论

| 方案 | 做法 | 判断 |
|---|---|---|
| **A. canonical 去重（已就位）** | `/docs/` 保持 200，canonical 指向 `/docs/overview/`；sitemap 不收录 `/docs/` | ✅ **基础保障，已完成** |
| **B. 301 `/docs/` → `/docs/overview/`** | 写进 `edgeone.json`（已完成，生效性待验） | ✅ **加分项，已完成，可能被静态文件遮蔽** |
| **C. 删掉 `/docs/` 页面** | `generateStaticParams` 排除空 slug | ❌ **不做**，见下 |
| **D. 让 `/docs/` 变成独立的文档首页** | 给 `/docs/` 写独立内容（分类导航 / 学习路径），两个 URL 各有价值 | 🔸 产品决策，未做 |

**为什么不选 C（删页面）**：删了 `/docs/` 就直接变 404。
而 A（canonical）本来就是 Google 官方推荐的重复内容处理方式，效果与 301 接近，
却不会伤害任何手输 URL / 历史外链的用户。用 404 换「少一个重复 URL」不值得。

顺带确认过一件容易踩的事：**顶部导航「产品文档」指向 `/docs/overview`，不是 `/docs`**
（`src/lib/public-site-navigation.ts` 第 41 行），所以即使真删了也不会破坏导航 ——
但这不改变上面的结论。

### 4.3 结论：这件事已经处理完了，无需额外动作

优先级层次要分清：

- **canonical 是基础保障**（已就位、已被 `seo.test.ts` 锁定）；
- **301 是加分项**（已写入 `edgeone.json`，若被静态文件遮蔽也不损失什么，退回 A 即可）；
- sitemap 不收录 `/docs/`（已就位、已被 6 断言锁定）。

对比 `/zh-cn/`：那边**没有** canonical 兜底可言（路由已不存在，只有 404 或 301 两条路），
所以 301 是唯一手段、必须做。两件事的紧急程度不同，不要混为一谈。

---

## 5. `lastmod` 语义：改为「内容更新日期」（2026-08-20 完成，08-21 按 CR 修正取值）

### 5.1 之前错在哪

`sitemap.xml` 的 `<lastmod>` 取 `lastModified()` → `NEXT_PUBLIC_BUILD_DATE`，
即**构建时间**。每天重新构建就让全站 256 条 URL 的 lastmod 一起变化。

Google 明确要求 lastmod 必须一致且准确，否则**整个信号会被忽略**。
文档页可见的「最后更新于」、`llms.txt` 的时间戳同样取构建时间，三处一起说谎。

### 5.2 关于 git 时间的判断：先否决、后部分推翻

第一版实现是**构建期**跑 `git log`。当时列出的问题：

| 问题 | 当时的证据 | 复查结论 |
|---|---|---|
| history simplification 让同一文件有两个日期 | `git log -1 -- plans.md` → `08-07`；`--full-history -1` → `08-18` | ⚠️ **根因是 merge 提交污染，加 `--no-merges` 后两者一致**。当时没试这个组合 |
| committer date 会被 rebase 重写 | `%cI` 变成操作时间 | ✅ 成立，故改用 `%aI`（author date） |
| 非实质提交污染历史 | merge / 格式化 / auto-stash 都会「碰到」文件 | ✅ 成立，`--no-merges` 可消除主要部分 |
| 批量与单文件查询不一致 | `git log --name-only` 遍历给出 `08-11` | ⚠️ 是当时解析脚本的 bug，非 git 固有问题 |

**唯一无法绕过的是浅克隆**：CI 用 `fetchDepth: 50`（`.ci/frontend.yml`），
`git log` 对早于 shallow boundary 的文件返回 boundary 提交时间；
mono2 提交很密，50 个提交往往只覆盖几天 —— 几乎每篇文档都会拿到
「接近本次构建」的日期，**等于换一种方式重现原问题，而且更难发现**。

**但这只否决了「构建期跑 git」，没有否决「本地一次性生成初始值」。**
第一版把这两件事混为一谈，一起废弃了，导致退化成「全站同一天」。
详见 5.5。

### 5.3 最终方案：显式清单

| 文件 | 角色 |
|---|---|
| `frontend/src/content/docs/last-updated.json` | **真源**，204 条，`源文件路径 → YYYY-MM-DD`，进版本控制 |
| `frontend/scripts/docs-last-updated.mjs` | 生成 / 补齐 / 清理 / 校验 |
| `frontend/scripts/docs-last-updated.test.ts` | 20 断言 |

四个子命令：

```bash
node scripts/docs-last-updated.mjs --check              # 构建链只用这个（纯文件系统校验）
node scripts/docs-last-updated.mjs --check --strict      # 额外校验诞生日期，需完整 git 历史
node scripts/docs-last-updated.mjs --sync                # 补新文档、删幽灵条目，不改已有日期
node scripts/docs-last-updated.mjs --from-git            # 用 git 历史重建全部日期（仅本地）
node scripts/docs-last-updated.mjs --set-all 2026-08-20  # 全部设为同一日期（慎用，见 5.5）
```

关键约束：

- **`--sync` 绝不修改已有日期** —— 日期是人写的，脚本无权改
  （变异测试验证：把它改成会覆盖 → 1 failed ✅）；
- **`--from-git` 禁止进构建链**，浅克隆下会直接报错而非产出假日期
  （有断言锁定 `package.json` 里的构建脚本不含它）；
- 裸 `--check` 已插入 `build` / `build:cn` / `build:global` / `build:next` / `dev*` 等 13 条脚本，
  清单与磁盘不一致直接构建失败；
- 裸 `--check` **不依赖 git**，所以在浅克隆的 CI 上同样可靠（有断言锁定：
  git 查询函数一次都不该被调用）；
- 未来日期直接报错 —— 假的新鲜度信号比没有更糟。

### 5.4 三处时间戳收敛为同一来源

| 位置 | 之前 | 现在 |
|---|---|---|
| 文档页「最后更新于」 | 构建日期 | frontmatter `last_updated`（逐页） |
| sitemap `<lastmod>` | 构建日期（全站同一个） | 逐 URL 取该文档日期 |
| `llms.txt` 时间戳 | 构建日期 | 全部文档中**最新**的那个日期 |

链路：`last-updated.json` → `sync-fumadocs-content.mjs` 注入 frontmatter
→ `docs-route-manifest.ts` 的 `DOCS_LAST_UPDATED` → 页面 / sitemap / llms.txt。
**不存在第二处时间镜像。**

两个刻意的设计决定：

1. **营销 / 法律页不输出 lastmod**。它们的内容散落在 tsx 与 i18n 字典里，
   没有可靠的单一时间。Google 允许省略，**省略比编造好**。
   于是国际站 sitemap 256 条里 228 条有 lastmod（文档页），28 条没有。
2. **清单缺条目时页面不渲染「最后更新于」**，而不是回退到构建日期。
   一个错的时间戳比没有时间戳更糟 —— 引擎会信任它。
   `--check` 保证正常构建走不到这个分支。

### 5.5 日期取值：逐篇取 git 真实日期

用 `docs-last-updated.mjs --from-git` 从 git 历史逐篇生成，实际分布：

| 日期 | 篇数 | 说明 |
|---|---|---|
| 2026-08-03 | 2 | 早期文档，之后未改 |
| 2026-08-12 | 31 | |
| 2026-08-17 | 24 | |
| 2026-08-18 | 45 | |
| 2026-08-20 | 102 | 本轮 GEO 治理实际改动的批次 |

**204 篇全部取自 git 历史，无一 fallback 到当天**，所以 sitemap 的 `<lastmod>`
真实反映内容批次，而不是「全站同一天」。国内站构建实测 15 条 `08-12` + 18 条 `08-20`。

#### 为什么第一版做成了「全站 2026-08-20」，以及为什么那是错的

第一版把 204 篇统一设为复核日，理由是「git 时间不可靠」。CR 指出这与
lastmod 语义注释自相矛盾，且全站同一天对 Google 是「模板批量生成」信号。**这个批评成立。**

更关键的是，「git 时间不可靠」这个前提本身是过度概括 —— 我当时只测了
`plans.md` 一个样本（`git log -1` 得 08-07、`--full-history -1` 得 08-18，差 11 天），
就断定整个方案不可行。复查后：

| 事实 | 数值 |
|---|---|
| 三种口径（`%cI` 简化 / `%aI` 简化 / `%aI` 全历史）完全一致的文档 | **180 / 204（88%）** |
| 有分歧的 | 24 篇，且**只差 1 天** |
| `plans.md` 加 `--no-merges` 后的两种口径 | **完全一致** |

`plans.md` 那 11 天分歧的根因是 **merge 提交污染**，`--no-merges` 即可消除 ——
当时没试这个组合就否决了整个方案。

#### 必须区分的两件事（第一版混为一谈）

| | 可行性 |
|---|---|
| **构建期**跑 git | ❌ 不可行。CI 用 `fetchDepth: 50` 浅克隆，`git log` 对早于 boundary 的文件返回 boundary 日期，几乎每篇都拿到「接近构建日」的值 —— 等于换种方式重现原问题 |
| **本地一次性**生成初始值 | ✅ 可行。本地是完整克隆，无 boundary 问题 |

所以最终形态：`--from-git` 只在本地跑（浅克隆时**直接报错**而非静默产假日期），
构建链只允许裸 `--check`（纯文件系统校验）。

#### 新增的校验

- `--check --strict`：额外校验「更新日期不早于文件首次提交日期」，
  能抓出手写错（打错年月、复制粘贴串行）—— 裸 `--check` 抓不到。
  实测注入 `2025-01-01` 后报 `date 2025-01-01 predates first commit 2026-04-27`；
  浅克隆时该项自动跳过，避免 boundary 日期造成大批误报。
- **产物 ↔ 真源一致性**：逐条比对 `.fumadocs-content` 各页 frontmatter 的
  `last_updated` 与 `last-updated.json`，以及 `DOCS_LAST_UPDATED` 里的日期
  是否都来自真源。这是补 CR 提出的缺口 —— 原先只校验「真源 ↔ 磁盘」，
  有人手改产物或改完真源忘跑 sync 都不会被发现。
- 断言 `package.json` 的构建 / dev 脚本不含 `--from-git`。

`docs-last-updated.test.ts` 共 20 断言。

关于 `DOCS_LAST_UPDATED` 的定位：CR 担心它是「第二份手工数据」。
它**是** `sync-fumadocs-content.mjs` 的生成产物（不是手工拷贝），
但 CR 的风险判断成立，因此补了上述一致性断言，并在生成的注释里明确写了
「不要手工编辑」。

以后改文档时手工把对应条目改成当天；漏改时 `--sync` 的输出会提示
「有未提交改动但日期未更新」。批量修正历史批次可重跑 `--from-git`。

### 5.6 实测（国际站 dev）

```
sitemap:  228/256 条有 lastmod，全部为 2026-08-20，格式一律纯日期
/docs/plans/:  "Last updated 2026-08-20"
llms.txt:      "Last updated: 2026-08-20"
```

---

## 6. 国际站 `/en-us/` 收敛（2026-08-20 完成）

### 6.1 决策

**只保留裸路径 `/about/`，不再生成 `/en-us/about/`** —— 与国内站 `/zh-cn/` 完全同一套处理。
非默认语言 `/zh-sg/`、`/zh-hant/`、`/id-id/` 是真实语言版本，**保持不变**。

### 6.2 改动

| 文件 | 改动 |
|---|---|
| `next-site/seo.tsx` | `SEO_PREFIXED_PUBLIC_URL_LANGS` / `SEO_PREFIXED_DOCS_ROUTE_LOCALES` 移除 `en-us` |
| `next-site/page-extensions.mjs` | 新增：按 region 解析 `pageExtensions`，国内站排除 `.intl.tsx` |
| `src/app/(site)/[lang]/**` 共 10 个页面 | `page.next.tsx` → `page.intl.tsx`（仅国际站识别） |
| `scripts/write-edgeone-config.mjs` | 国际站新增 `/en-us` → `/`、`/en-us/*` → `/:splat` 共 3 条 301 |
| 9 个公共页 | 运行时守卫换成 `prefixedPublicRouteLocale()`，见 6.3 |

### 6.3 顺手挖出的真 bug：dev 与生产行为不一致

改完后实测 `/en-us/docs/overview/` 已 404，但 **`/en-us/about/` 仍返回 200**。

根因：`generateStaticParams()` 用 `SEO_PREFIXED_PUBLIC_URL_LANGS`（已排除 en-us），
而页面里的运行时守卫用 `publicRouteLocaleFromLang()` —— 后者基于**全部 5 种语言**。
两个集合不是同一个来源。

后果：静态导出后 `/en-us/about/` 确实不生成（线上是 404），但 dev 下返回 200。
**dev 与生产行为不一致，极易误判「收敛没生效」或反过来「以为生效了」。**

修法：`seo.tsx` 新增 `prefixedPublicRouteLocale()`，内部就用
`SEO_PREFIXED_PUBLIC_URL_LANGS` 判定，9 个公共页统一改用它。
守卫与路由生成从此同源，不可能再漂移（`seo.test.ts` 有 2 条断言锁定，含国内站全拒绝）。

### 6.3.1 ⚠️ 空数组不是「不生成任何路径」——MR 流水线才暴露的构建失败

把国内站 `SEO_PREFIXED_PUBLIC_URL_LANGS` 改为 `[]` 后，
本地 `dev` / `tsc` / `vitest`（1600 断言）**全部通过**，但 MR 流水线直接失败：

```
Error: Page "/[lang]/changelog" is missing "generateStaticParams()"
       so it cannot be used with "output: export" config.
```

**Next 在 `output: 'export'` 下把「`generateStaticParams()` 返回空数组」
等同于「没有这个函数」。** 空数组不是合法的「不生成任何路径」表达。

为什么本地全绿：`next.config.mjs` 里 `output: isDevelopment ? undefined : 'export'`，
**dev 模式根本不做静态导出**，这个校验不会触发。而 `tsc` 与 `vitest` 都不跑真实构建。
本地唯一能复现的方式是执行完整的 `pnpm build:cn` —— 这一步当时没做，是验证缺口。

复现时本地报的是 `/[lang]/about`、CI 报 `/[lang]/changelog`：
Next 用 13 个 worker 并行收集页面数据，谁先撞上就报谁，
**说明 `[lang]` 下 10 个页面全部受影响，不是单个页面的问题**。

**修法：用 Next 官方的 `pageExtensions` 按 region 排除文件**，
而不是试图用空数组表达。`[lang]` 下的页面统一改名 `page.intl.tsx`：

```js
// next-site/page-extensions.mjs
pageExtensions: isGlobalRegion()
  ? ['next.tsx', 'next.ts', 'intl.tsx', 'intl.ts']
  : ['next.tsx', 'next.ts']
```

国内站不把 `.intl.tsx` 识别为页面 → `[lang]` 路由段**根本不存在** → 不再有
「需要 generateStaticParams」的问题，产物里也不含相关代码。

考虑过但否决的方案：

| 方案 | 否决原因 |
|---|---|
| 国内站恢复生成 `/zh-cn/`，只靠 canonical + 301 去重 | 推翻本轮核心目标，且重复内容仍真实存在 |
| 返回一个哨兵 lang 再 `notFound()` | `output: export` 下会把 404 页面写进该路径，等于又生成了 `/zh-cn/` 目录 |
| 构建前临时移走 `[lang]` 目录 | 污染工作区，失败时残留，且与 dev 行为不一致 |

附带收益：dev 与 build 用同一份 `pageExtensions`，国内站两种模式下 `[lang]` 都不存在，
从根上消除了 6.3 那类「dev 能访问、导出后 404」的不一致。

**逻辑单独抽成 `next-site/page-extensions.mjs` 而非写在 `next.config.mjs` 里**：
后者在 vitest 下无法 import（顶层调用
`fileURLToPath(new URL('.', import.meta.url))`，vitest 的 `import.meta.url`
不是 file:// scheme，抛 `TypeError: The URL must be of scheme file`
—— 既有的 `scripts/next-config.test.mjs` 就是栽在这里，长期处于失败状态）。
抽出后测试验证的是真实逻辑，而不是去正则匹配配置文件源码。

回归防线：`scripts/intl-only-pages.test.ts`（13 断言），含 2 组变异测试 ——
把任一页面改回 `page.next.tsx` → 3 failed；让 `pageExtensions` 不再按 region 切换 → 2 failed。
**这条 CI 失败从此能在本地被拦住，不必等 CI 跑两次完整构建（约 4 分钟）。**

### 6.4 实测（两站真实 `next build`，不是 dev）

`pnpm build:cn` 与 `pnpm build:global` 均 `EXIT=0`，产物核对：

| 检查项 | 国内站 | 国际站 |
|---|---|---|
| `out/zh-cn/` 目录 | 不存在 ✅ | 不存在 ✅ |
| `out/en-us/` 目录 | 不存在 ✅ | 不存在 ✅ |
| `out/zh-sg/`、`out/zh-hant/`、`out/id-id/` | 不适用 | 各 67 页 ✅ |
| sitemap `<loc>` 总数 | 40 | 256 |
| sitemap 含 `zh-cn` | 0 ✅ | 0 ✅ |
| sitemap 含 `en-us` | 0 ✅ | 0 ✅ |
| `<lastmod>` 条数 | 33（仅文档页）✅ | 228 ✅ |
| `edgeone.json` 落位 | `out/.edgeone/`，5 条规则 ✅ | `out/.edgeone/`，5 条规则 ✅ |
| `check-next-seo` | 8 个公共路由通过 | 32 个公共路由通过 |

`zh-CN` hreflang 实测指向 `https://lightvela.com/`、`https://lightvela.com/about/` 等裸路径。

补充：国际站 dev 下的路由状态（验证运行时守卫，见 6.3）

| URL | 结果 |
|---|---|
| `/en-us/` | 404 ✅ |
| `/en-us/about/` | 404 ✅（修守卫前是 200） |
| `/en-us/docs/overview/` | 404 ✅ |
| `/about/` | 200 ✅ |
| `/zh-sg/about/` | 200 ✅ |
| `/id-id/subscribe/` | 200 ✅ |
| sitemap 中含 `en-us` 的 `loc` | 0 条 ✅ |

### 6.5 GSC 侧动作

与 `/zh-cn/` 同一套（见 2.5）：确认 301 生效、提交新 sitemap、
**不要用「移除网址」工具**、301 至少保留 12 个月。

去 GSC 查一下 `lightvela.ai` 上 `/en-us/` 的收录条数 —— 处理方式与国内站一致。

---

## 7. 仍需确认

1. **`edgeone.json` 生效性**：见 2.3，需一次生产发版验证。
2. **`/docs/` 的 301 可能被静态文件遮蔽**：见 4.2，基础保障是 canonical，可接受。
3. **本地验证必须包含真实构建**：本轮教训（见 6.3.1）—— `dev` + `tsc` + `vitest`
   1600 断言全绿仍漏掉了构建期错误，因为 `output: 'export'` 的校验只在
   `next build` 时执行。改动路由结构、`generateStaticParams`、`pageExtensions`
   或任何静态导出相关配置后，**必须本地跑一遍 `pnpm build:cn` 与
   `pnpm build:global`**（各约 2 分钟），不能只依赖单测。
   `scripts/intl-only-pages.test.ts` 已把这一类失败前移到本地，但它只覆盖
   已知的这一种形态，不能替代真实构建。

---

## 8. 相关

- 事实口径：`wiki/product-state/geo-fact-table.md`
- 301 规则真源：`frontend/scripts/write-edgeone-config.mjs`
- 文档日期真源：`frontend/src/content/docs/last-updated.json`
- Google 指南：URL 迁移、canonical、hreflang、sitemap、lastmod（见图示来源）
