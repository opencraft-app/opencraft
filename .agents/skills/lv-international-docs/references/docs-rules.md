# 国际站文档规则

## 当前目录

主要内容在：

```text
frontend/src/content/docs/
  *.md                         # 国内站文档
  configuration/*.md           # 国内站配置文档
  global/*.md                  # 国际站中文文档（zh-sg / Intl 中文）
  global/configuration/*.md
  en/*.md                      # 国际站英文文档（en-us / Intl English）
  en/configuration/*.md
  images/*                     # 中英文文档图片资源
```

## 加载规则

`frontend/src/lib/docs/docs-loader.ts` 定义了文档加载优先级：

- 国内站：只读 `frontend/src/content/docs/<file>`.
- 国际站英文：优先读 `frontend/src/content/docs/en/<file>`，缺失时 fallback 到 `frontend/src/content/docs/global/<file>`.
- 国际站中文：只读 `frontend/src/content/docs/global/<file>`.

因此，改国际站时不要依赖根目录 `docs/<file>`。根目录通常是国内站真源。

## 路由与语言

国际站 docs 主要路由：

- 默认英文裸路径：`/docs/...`
- 英文显式路径：`/en-us/docs/...`
- 国际站中文路径：`/zh-sg/docs/...`

`frontend/src/app/(site)/[lang]/docs/[[...slug]]/page.next.tsx` 中：

- global 构建支持 `en-us` 与 `zh-sg`.
- cn 构建支持 `zh-cn`.

## Sidebar 与 slug

`frontend/src/config/docs-sidebar.ts` 控制：

- 国际站 sidebar：`GLOBAL_SIDEBAR`
- 国内站 sidebar：`CN_SIDEBAR`
- 国际站 slug 到文件：`GLOBAL_SLUG_TO_FILE`
- 国内站 slug 到文件：`CN_SLUG_TO_FILE`

新增国际站页面时：

1. 在 `GLOBAL_SIDEBAR` 加菜单项。
2. 在 `GLOBAL_SLUG_TO_FILE` 加 slug -> file 映射。
3. 创建 `global/<file>` 中文稿。
4. 创建 `en/<file>` 英文稿。
5. 不要顺手加入 `CN_SIDEBAR` / `CN_SLUG_TO_FILE`，除非用户明确要求国内站也上线。

## 共享页拆分规则

当一个页面现在只有根目录文件，或英文 fallback 到 `global/`：

- 如果任务是“国际站 only”，先补齐国际站独立文件。
- 如果已有 `global/<file>` 但没有 `en/<file>`，先从 `global/<file>` 生成英文本地化版本。
- 如果根目录国内站文件和国际站内容有差异，不要通过修改根目录来服务国际站。

## 先中文后英文

推荐编辑顺序：

1. 先把国际站中文稿写在 `global/<file>`。
2. 再基于中文稿生成 `en/<file>`。
3. 英文不是逐字翻译，要符合国际用户语境：
   - WeChat 可保留，但解释使用场景。
   - Feishu 在英文文档中通常写 Lark。
   - 企业微信通常写 WeCom。
   - 国内实名认证、国内支付、国内专属入口不要进入国际站，除非页面明确说明。

保持两份文档：

- 同一信息架构。
- 同一步骤顺序。
- 同一警告/限制语义。
- 链接目标都指向国际站可用页面。

## 图片规则

图片统一放在 `frontend/src/content/docs/images/`。

`rewriteImagePaths()` 会在英文 locale 下优先寻找同名 `-en` 图片：

```text
xxx.webp      # 默认图片
xxx-en.webp   # 英文环境优先使用
```

Markdown 里可以仍引用默认名：

```markdown
![](../images/xxx.webp)
```

英文环境如果存在 `xxx-en.webp`，构建时会自动替换成英文图。

编辑图片时：

- 如果中文文档新增 `xxx.webp`，英文文档通常需要 `xxx-en.webp`。
- 如果英文文档直接引用已有中文 UI 截图，要提醒补英文截图。
- 如果图片没有 UI 文案或语言无关，可以复用，不必强行创建 `-en`。
- 如果使用 `<img src="../images/xxx.webp" width="360" />`，同样需要检查是否有 `xxx-en.webp`。

## 常见验证

文档小改：

- 检查 markdown 链接是否仍是相对 `.md` 或合法外链。
- 检查图片文件是否存在。
- 检查 `global/` 和 `en/` 是否语义一致。

涉及 sidebar 或路由：

- 检查 `GLOBAL_SIDEBAR` 与 `GLOBAL_SLUG_TO_FILE` 同步。
- 检查新增文件同时有 `global/` 和 `en/`。
- 建议运行 `cd frontend && pnpm check`。
