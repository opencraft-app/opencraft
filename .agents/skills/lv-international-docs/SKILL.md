---
name: lv-international-docs
description: 维护 LightVela 国际站文档（https://lightvela.ai/docs）的专用技能。用户要求编辑、添加、翻译或审查国际站前端文档页面时使用，尤其是涉及 frontend/src/content/docs/en、frontend/src/content/docs/global、文档图片、文档侧边栏、路由 metadata，或提示中出现“国际站文档”、lightvela.ai/docs、English docs、zh-sg docs、docs screenshots/images、区分国内站与国际站文档等信息时使用。
---

# LightVela 国际站文档

## 定位

这个技能只服务 `https://lightvela.ai/docs` 国际站文档。不要把国内站 `lightvela.cn` / `lightvela.com` 中国站文档当成默认修改目标。

如果用户要写 LightVela 长篇营销/产品文章，而不是维护 docs 页面，应改用 `lv-longform-content`。长篇内容正文默认必须严格输出英文，除非用户明确要求中文或双语。

## 核心规则

- 只改国际站文档时，优先修改 `frontend/src/content/docs/global/` 与 `frontend/src/content/docs/en/`。
- 不要直接修改 `frontend/src/content/docs/` 根目录下的国内站文档，除非用户明确要求国内站也同步。
- 如果当前页面由国内站和国际站共享，先为国际站创建或补齐独立文件，再在国际站文件里修改。
- 推荐先写或修改国际站中文稿（`global/`），再自动翻译或本地化英文稿（`en/`）。
- 英文文档中的截图或 UI 图片不能含中文界面。若缺英文版图片，最终回复必须明确提醒。

## 先读代码事实

执行国际站文档任务前，按需读取：

- `frontend/src/lib/docs/docs-loader.ts`
- `frontend/src/config/docs-sidebar.ts`
- `frontend/src/app/(site)/docs/[[...slug]]/page.next.tsx`
- `frontend/src/app/(site)/[lang]/docs/[[...slug]]/page.next.tsx`
- 目标 markdown 的 `global/` 与 `en/` 两份文件

详细目录、加载与图片规则见 `references/docs-rules.md`。

## 工作流

1. 判断目标是否为国际站：
   - 明确提到 `lightvela.ai/docs`、国际站、英文文档、`en-us`、`zh-sg`，按国际站处理。
   - 只说 `/docs` 但上下文是国际站，也按国际站处理。
   - 如果用户没有说国内站，不要改国内站根目录文档。

2. 定位 slug 与文件：
   - 从 `frontend/src/config/docs-sidebar.ts` 找 slug 到 markdown 文件名。
   - 国际站中文文件在 `frontend/src/content/docs/global/<file>`。
   - 国际站英文文件在 `frontend/src/content/docs/en/<file>`。

3. 检查是否共享或缺文件：
   - 若 `en/<file>` 不存在，英文会 fallback 到 `global/<file>`；正式英文文档通常不应依赖 fallback。
   - 若国际站要与国内站不同，必须创建或补齐 `global/<file>` / `en/<file>`，不要修改根目录 `docs/<file>` 来间接影响国际站。

4. 内容编辑顺序：
   - 先改 `global/<file>` 中文国际站稿。
   - 再根据中文稿写 `en/<file>` 英文稿，不做逐字硬翻，要面向国际用户本地化表达。
   - 保持标题层级、步骤顺序、链接结构、注意事项语义一致。

5. 图片检查：
   - 扫描目标 markdown 的 `![](...)` 和 `<img src="...">`。
   - 英文文档若引用中文 UI 图片，要检查 `frontend/src/content/docs/images/` 是否有 `-en` 版本。
   - 如果中文稿新增图片，英文稿通常需要英文截图，命名为同 basename + `-en`，例如 `telegram-step.webp` -> `telegram-step-en.webp`。
   - 如果缺英文图，最终回复必须明确列出待补英文图片。

6. 验证：
   - 小文档改动至少检查链接、图片路径、sidebar slug 是否存在。
   - 涉及 sidebar、route 或 metadata 时，建议运行前端类型检查或相关测试。
   - 若只改 markdown 且未运行测试，最终说明未运行。

## 输出位置

国际站文档输出到：

```text
frontend/src/content/docs/global/<file>.md   # 国际站中文 / zh-sg
frontend/src/content/docs/en/<file>.md       # 国际站英文 / en-us
frontend/src/content/docs/images/*           # 文档图片资源
frontend/src/config/docs-sidebar.ts          # 仅在 sidebar/slug 变化时修改
```

默认不要修改：

```text
frontend/src/content/docs/<file>.md          # 国内站文档
```

除非用户明确要求国内站也同步。

## 最终回复

最终回复用中文，说明：

- 改了哪些国际站文件。
- 是否创建或补齐了中英文独立文件。
- 英文图片是否齐备；若缺，列出缺的图片名。
- 是否触碰国内站文档；正常应为“未触碰”。
- 是否运行了检查或测试；未运行时说明原因。

## Reference

- `references/docs-rules.md`：当前文档加载机制、目录映射、图片本地化规则。
