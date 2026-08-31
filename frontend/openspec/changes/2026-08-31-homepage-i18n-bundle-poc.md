# Homepage i18n bundle Q0 PoC

**Date:** 2026-08-31

**Scope:** 只回答 Q0：为什么首页会下载两份完整字典，以及是否存在不改变 i18n 初始化、locale 注册表或 hydration 时序的低风险去重方式。本 PoC 不修改运行时 i18n 行为。

## 结论

两个约 1006 KiB 的脚本不是两套不同字典，而是同一组 8 个 JSON 模块被 Turbopack 分别复制进两个 client entry：

1. `(site)/layout.next` 的持久 client entry；
2. `next-site/public-pages.tsx` 的公开页面 client entry。

两边都真实依赖 `useT()`：layout 一侧包含 `RootProvider`、`LightVelaSearchDialog`、Cookie/运行时 Provider，页面一侧包含 `LandingPageView` 等公开页组件。`src/i18n/t.ts` 静态导入 `src/i18n/index.ts`，而 `index.ts` 顶层又静态导入全部 7 份语言字典；`t.ts` 自身还导入 `zh-to-key.json`。因此两个入口各自都把完整资源图打进自己的 chunk，浏览器会下载两份字节不同、JSON 模块内容相同的脚本。

当前没有发现只改 Turbopack 配置或移动单个 import 就能安全移除一整份的方案。要真正去重，需要在后续 Q1 中验证以下之一：

- 把 translated public UI 合并到同一个 client root；或
- 把 docs/search/provider 从所有公开路由共用的 layout client boundary 中拆出，使 layout 不再依赖 `useT()`；或
- 改为外置/按 locale 加载字典，并显式处理 hydration、FOUC、失败回退与缓存。

这些方案都会改变 client boundary 或运行时加载协议，超出 Q0 的低风险范围，本批不实施。

## 构建证据

### 字典源文件

`src/i18n/generated/{zh-to-key,en-US,es,id-ID,ja-JP,ko-KR,zh-CN,zh-Hant}.json` 合计 **1,056,353 bytes**。

### 国际站首页

`pnpm build:global` 后，`out/index.html` 同时引用：

| chunk | raw | gzip | 唯一 hash key 数 |
|---|---:|---:|---:|
| `1bc2hq9g-1b6q.js` | 1,030,557 B | 396,513 B | 2,680 |
| `1dmpbo17rq65j.js` | 1,030,557 B | 396,470 B | 2,680 |

两份 chunk 都包含完全相同的 JSON 模块 ID：

`781867, 123500, 193560, 56947, 50669, 505629, 525395, 784108`

### 国内站首页

`pnpm build` 后同样出现两份完整字典 chunk；本次构建分别为 **1,030,643 B**，每份都包含 2,680 个唯一 hash key 和上述 8 个模块 ID。区域编译造成少量 wrapper 字节差异，不改变重复结论。

### Client boundary

Next 生成的 `page_client-reference-manifest.js` 与 `.next/diagnostics/route-bundle-stats.json` 显示：

- `(site)/layout.next` 的 `entryJSFiles` 包含第一份完整字典 chunk；对应 client modules 包括 `RootProvider`、`LightVelaSearchDialog` 和 `PublicSiteAppProviders`。
- `next-site/public-pages.tsx` 的 client module chunks 包含第二份完整字典 chunk。
- 首页 `/` 的 `firstLoadChunkPaths` 同时包含二者。

Turbopack 给两份 JSON 使用相同模块 ID，证明这是跨 entry 的重复打包，不是 key 冲突、语言映射差异或生成脚本重复生成文件。

## 可复现命令

```bash
cd frontend
pnpm build
pnpm build:global
rg -o '/_next/static/chunks/[^" ]+\.js' out/index.html | sort -u
wc -c src/i18n/generated/{zh-to-key,en-US,es,id-ID,ja-JP,ko-KR,zh-CN,zh-Hant}.json
rg -n '"route": "/"' .next/diagnostics/route-bundle-stats.json
```

对首页 script 逐个统计 `k_[0-9a-f]{8}` 和 JSON module ID，可稳定得到两份 2,680-key / 8-module 的大 chunk。

## 风险与下一步

- 不应直接把 `index.ts` 改成异步 import：`i18n.init()` 当前在模块加载时同步发起，公开路由通过 `LocaleOverrideProvider` 保证 SSR/CSR 首帧一致；异步化会重新引入冷启动中文、hydration mismatch 或 FOUC 风险。
- 不应只删 ja-JP/ko-KR：locale 注册表、历史 localStorage、非公开路由与 fallback 仍需同步设计。
- Q1 建议单独开实施计划，先用 boundary prototype 验证 `/` 是否只剩一份字典 chunk，再覆盖 `/es`、`/zh-hant`、`/id-id`、`/zh-sg`、`/agents`、历史 ja/ko localStorage、手动切换和刷新持久化。
