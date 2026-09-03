# Vela 建站支持分享链接 — 技术方案

- 状态：方案设计
- 日期：2026-09-02
- TAPD：https://tapd.woa.com/tapd_fe/10132091/story/detail/1010132091137669820
- 涉及模块：vela 建站工作台（前端）
- 关联后端：`ctl` 分享码能力已就绪，本需求**复用、不改后端**

## 1. 背景与目标

### 背景

vela 建站用户创建完网站后，目前缺少便捷的分享能力，无法快速把网站分享给他人协作使用。为提升建站产品的传播与协作体验，需要在工作台增加「分享链接」能力。

### 目标

在「我的工作台」站点操作区增加「分享」入口，通过分享弹窗完成：

1. 开启分享码访问，并选择有效期（1 天 / 7 天 / 30 天）；
2. 一键复制分享文案（含站点地址、分享码、有效期）；
3. 支持重置分享码、停止分享；
4. 他人凭分享码在站点落地页（site-gateway `/__lightvela/share`）输入后查看网站。

### 非目标（本期不做）

- 不做「带 token 的直接访问链接」（本期是「分享码 + 落地页输入」模型，不是免输码 URL）；
- 不改动后端分享码逻辑（`ctl` 已实现，见 §3）；
- 不新增站点详情页；
- 不做分享数据的统计/埋点分析（如需要后续追加）。

## 2. 现状盘点

### 2.1 后端已实现（复用）

后端分享码能力完整落地在 `ctl/pkg/logic/website/share_access.go`：

| 维度 | 实现 |
|---|---|
| 分享码格式 | 6 位大写，字符集 `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`（Crockford Base32，去掉 `0/1/O/I` 易混淆字符） |
| 存储 | Redis key `website:share:access:{site_id}`，value 只存 `code_hash`(bcrypt) + `generation` + `expires_at`，**不落 MySQL** |
| 有效期 | 仅 1 / 7 / 30 天（`shareDurationByDays`） |
| 明文策略 | 明文分享码只在「开启」或「重置」响应中返回一次，Redis 只存 bcrypt hash |
| 轮转 | `generation`（16 字节随机）作版本号，重置用 Redis WATCH 乐观锁，保留原到期时间 |
| 限流 | 站点 50 次/10min、站点+IP 5 次/10min（Redis Lua 脚本，IP 走 sha256 哈希） |
| 落地页 | site-gateway `/__lightvela/share`，校验通过签发 `__Host-lv_site_share` 加密 Cookie（AES-256-GCM） |

### 2.2 前端现状

| 文件 | 现状 |
|---|---|
| `frontend/src/pages/marketing/agent-website-panel.tsx` | 「我的工作台」面板：创建/模板/列表/访问/删除/配额，**无分享** |
| `frontend/src/pages/app/website-page.tsx` | 「我的作品」只读页，**无分享** |
| 分享 UI 组件 | **无**（搜索 `Share/Share2/Copy/分享` 无建站相关命中） |
| 分享相关 i18n | **无** |

结论：后端就绪，前端 UI 是空白待实现状态（`frontend/openspec/spec.md` 中「国内建站临时分享码 Spec」已明确后端契约与前端交接边界）。

## 3. 后端接口契约（复用，无需改动）

### 3.1 所有者接口（需登录鉴权 `Authorization: Bearer <token>`）

| 方法 | 路径 | 入参 | 出参 | 说明 |
|---|---|---|---|---|
| PUT | `/v1/websites/{site_id}/access` | `{"mode":"share_code","duration_days":1\|7\|30}` | `{"mode":"share_code","code":"7KQ9XM","expires_at":"..."}` | 开启分享，返回一次性明文码 |
| PUT | `/v1/websites/{site_id}/access` | `{"mode":"owner_only"}` | `{"mode":"owner_only"}` | 关闭分享（幂等） |
| POST | `/v1/websites/{site_id}/share-code/reset` | `{}` | `{"mode":"share_code","code":"...","expires_at":"..."}` | 重置分享码，保留原到期时间 |

### 3.2 列表/详情返回的派生字段

`GET /v1/websites` 与 `GET /v1/websites/{site_id}` 会对每个站点调用 `hydrateShareAccess`（`logic.go:594-596`、`610`），返回：

```json
{
  "...": "...",
  "access_mode": "owner_only | share_code",
  "share_expires_at": "RFC3339 | null"
}
```

- 字段名（snake_case）：`access_mode`、`share_expires_at`（后端 `SiteEntity` 的 JSON tag）。
- **不返回** `code_hash` / `generation` / 明文码。
- Redis 异常时降级为 `owner_only`，不破坏列表。

### 3.3 错误码

| 场景 | 错误 |
|---|---|
| 未分享/过期/状态损坏/摘要不匹配 | `ErrWebsiteShareCodeInvalid` |
| 命中限流 | `ErrWebsiteShareRateLimited` (429) |
| Redis 不可用 | `ErrWebsiteShareUnavailable` (503) |
| 非法 `duration_days` | `ErrWebsiteInvalidParam` |

## 4. 前端实现方案

### 4.1 数据结构扩展

`agent-website-panel.tsx` 的 `WebsiteSite` 接口（33-46 行）新增两个字段：

```ts
interface WebsiteSite {
  // ...existing fields
  AccessMode?: "owner_only" | "share_code";
  ShareExpiresAt?: string | null;
}
```

`website-page.tsx` 中同名的 `WebsiteSite` 类型同步扩展（如需在「我的作品」页也加分享入口）。

### 4.2 分享入口

在操作区（`agent-website-panel.tsx:695-733`）「访问」「删除」之间新增「分享」按钮：

- 图标：`Share2`（lucide-react，项目已引入同类图标）；
- 可用条件：`status === "active" && siteURL`（与「访问」一致）；
- 点击打开分享弹窗，目标站点为当前 `site`。

### 4.3 分享弹窗（核心组件）

新建 `frontend/src/pages/marketing/agent-website-share-dialog.tsx`，导出 `WebsiteShareDialog`。按站点当前 `AccessMode` 分两种初始态：

**态 A — 未分享（`owner_only`）**

交互遵循 spec.md 要求「先选择使用分享码访问，再出现时长选项」：

1. 顶部一个「使用分享码访问」开关/单选项（默认关闭）；
2. 开启后展开时长选择：`1 天 / 7 天 / 30 天`（单选，默认 7 天）；
3. 底部「开启分享」按钮 → 调 `PUT /access {mode:share_code, duration_days}`；
4. 成功后进入「已分享」态，展示一次性明文码。

**态 B — 已分享（`share_code`，无明文）**

1. 展示「分享已开启，有效期至 `<time>`」；
2. 「复制分享信息」按钮（复制含码的完整文案，见 §4.4）；
3. 「重置分享码」按钮 → `POST /share-code/reset`，成功后展示新码（覆盖旧码，到期时间不变）；
4. 「停止分享」按钮 → `PUT /access {mode:owner_only}`，回到「未分享」态。

> 说明：明文码只在「开启」「重置」响应中返回一次。再次打开弹窗时后端不返回明文码，因此「复制分享信息」在无明文码的状态下会**先要求用户重置分享码**（换取新码再复制），或者仅复制「站点地址 + 引导文案」。此交互细节见 §6 待确认项。

### 4.4 一键复制文案

复制逻辑用 `navigator.clipboard.writeText`，失败时回退到 `document.execCommand("copy")`（降级方案）。

文案模板（以 TAPD 需求文案为引导 + spec.md 补充结构化信息，**具体措辞待产品确认**）：

```
hello，我使用 LightVela 给你分享了一个网站，点击输入分享码可以查看：
站点地址：<PublicURL>
分享码：<CODE>
有效期至：<YYYY-MM-DD HH:mm>
```

### 4.5 状态流转图

```text
owner_only ──PUT access(share_code, N days)──▶ share_code（拿到一次性 code）
share_code ──POST share-code/reset──────────▶ share_code（换新 code，到期不变）
share_code ──PUT access(owner_only)─────────▶ owner_only（删除分享 key）
```

### 4.6 错误与降级

| 场景 | 前端处理 |
|---|---|
| 429 限流 | 提示「操作过于频繁，请稍后再试」 |
| 503 Redis 不可用 | 提示「分享服务暂时不可用」 |
| 非法时长/参数 | 提示「参数无效」，不重试 |
| 复制失败（剪贴板受限） | 降级 `execCommand`，仍失败则提示手动复制 |

## 5. 国内站 / 国际站差异

- 需求字段：**支持国际站，保持和国内站策略一致**；
- 当前 `website` section 在侧边栏「实验室」分组是**无条件注册**的（`agent-settings-page.tsx:4653-4659`），`<AgentWebsitePanel />` 渲染也无 region 条件，因此分享功能实现后 **cn 与 global 天然都生效**；
- 本需求按「国内站」交付，国际站复用同一套组件与接口，无需额外分支。

## 6. 待确认 / 未决问题

1. **复制文案最终措辞**：TAPD 需求文案（`hello，我使用LightVela给你分享了一个网站，点击输入分享码可以查看`）未含 URL/码/有效期占位，与 spec.md 建议（含 `<URL>/<CODE>/<TIME>`）不完全一致。需产品确认最终模板。
2. **已分享态下「复制分享信息」的可用性**：明文码只返回一次，二次打开弹窗时无码可复制。可选：a) 该按钮在无码时引导「重置分享码」；b) 复制内容改为不含码的引导文案。需产品确认。
3. **「我的作品」页（`website-page.tsx`）是否同步加分享入口**：需求仅明确「工作台」，建议本期只在工作台加，作品页后续评估。

## 7. 安全与合规

复用后端既有安全设计，前端不新增安全面：

- 明文码只在响应中出现一次，前端不持久化、不打日志；
- 分享码校验只在后端做（bcrypt 常量时间比对），前端不做本地校验；
- 复制文案中的 URL 使用后端返回的 `PublicURL`，不拼接用户输入，无 XSS 面；
- 不新增任何 cookie / token / localStorage 分享凭据。

## 8. 测试计划

- 单元/组件测试：`WebsiteShareDialog` 两种初始态渲染、时长选择、复制文案内容、重置/停止按钮回调节点；
- 类型检查 + lint：`WebsiteSite` 扩展字段的类型正确性；
- 接口联调：开启→列表返回 `share_code`、重置保留到期、停止→列表返回 `owner_only`、非法 `duration_days` 报错；
- 浏览器验收：分享码落地页输入码访问站点；过期/重置后旧码失效；限流 429 提示。

## 9. 涉及文件清单

| 文件 | 改动 |
|---|---|
| `frontend/src/pages/marketing/agent-website-panel.tsx` | `WebsiteSite` 类型扩展 + 操作区加分享按钮 + 弹窗挂载 |
| `frontend/src/pages/marketing/agent-website-share-dialog.tsx` | 新增分享弹窗组件 |
| `frontend/src/pages/app/website-page.tsx` | （可选）`WebsiteSite` 类型扩展 |
| i18n 词条 | 新增分享相关文案（中英） |
| `frontend/openspec/` | 归档本需求的 spec/plan（实现后） |
