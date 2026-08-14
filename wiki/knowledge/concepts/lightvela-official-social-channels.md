# LightVela Official Social and Community Channels

更新时间：2026-08-06

## Canonical URLs

以下链接是当前由 LightVela 提供的官方社群和社交媒体入口。

| 渠道 | 用途 | 官方 URL |
| --- | --- | --- |
| Discord | LightVela 官方 Discord 社群 | <https://discord.gg/NpwV9KFz3A> |
| WhatsApp | LightVela 官方 WhatsApp 群组 | <https://chat.whatsapp.com/KLF9OvdAj4sDdojG20JA9b> |
| X / Twitter | LightVela 官方 X 账号 | <https://x.com/agentlightvela> |

## 使用规则

- 文章、官网页、邮件和社区 CTA 需要引用官方社群或社交媒体入口时，优先使用本页 URL。
- 这些 URL 指向外部平台，不要在 URL 上追加 LightVela 的 `?from=` 归因参数。
- `?from=` 只用于指向 `lightvela.ai` 的内容反链，并按照[内容反链渠道归因参数](../decisions/2026-07-22-content-backlink-attribution.md)选择对应来源值。
- 如果某个平台邀请链接或账号发生变化，先更新本页，再同步检查前端页、内容模板、邮件模板和测试中的消费者。

## 当前代码差异

当前前端 SEO 配置和页脚测试仍包含旧的 Discord 邀请链接 `https://discord.gg/Myh58xEMe2`。

本页记录的 `https://discord.gg/NpwV9KFz3A` 是 2026-08-06 用户确认的最新 Discord 官方入口，但本次只更新 Wiki，没有自动修改前端代码。

相关代码：

- `frontend/next-site/seo.tsx`
- `frontend/src/components/site/__tests__/lightvela-footer.test.tsx`
