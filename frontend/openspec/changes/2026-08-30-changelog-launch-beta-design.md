# Changelog 产品阶段、DeepSeek Harness 与国际化动态设计

**Status:** 方案 A 已实现并通过验证；MR !3458 已合并，待创建后续 MR

## 目标

保持现有静态 Changelog 数据结构和配图不变，准确表达中国站与国际站各自的产品阶段，并补充 DeepSeek Harness、自动任务测试运行和国际站印度尼西亚语支持等用户可见动态。

## 已确认文案与展示

### 2026 年 8 月 · DeepSeek Harness

- 中国站标题：`LightVela 实验室新增 DeepSeek Harness`。
- 国际站使用对应本地化标题。
- 标题右侧显示 `Beta` 胶囊标签。
- 保留现有描述和双站配图。

### 2026 年 8 月 · 自动任务测试运行

- 中国站和国际站同步显示，紧接各自的 DeepSeek Harness 条目。
- 中文标题：`自动任务支持测试运行`。
- 中文描述：`创建或编辑自动任务时，可以先运行一次当前任务内容，无需保存即可确认执行效果，再决定是否创建或更新任务。`
- 英文标题：`Jobs Now Support Test Runs`。
- 英文描述：`When creating or editing a job, you can run the current job once without saving it, review the result, and then decide whether to create or update the job.`
- 不配图，使用现有 `visual: "none"`。

### 2026 年 8 月 · 国际站支持印度尼西亚语

- 仅国际站显示，放在国际站 8 月正式上线条目前一条。
- 不配图，使用现有 `visual: "none"`。
- 各可见语言文案：

| 语言 | 标题 | 描述 |
| --- | --- | --- |
| 简体中文（含 `zh-SG`） | `LightVela 支持印度尼西亚语` | `现在可以使用印度尼西亚语浏览 LightVela 的公开页面、产品文档和账号流程。` |
| 繁体中文 | `LightVela 支持印度尼西亞語` | `現在可以使用印度尼西亞語瀏覽 LightVela 的公開頁面、產品文檔和賬號流程。` |
| English | `Indonesian Is Now Available` | `Browse LightVela's public pages, documentation, and account flows in Indonesian.` |
| Bahasa Indonesia | `Bahasa Indonesia Kini Tersedia` | `Sekarang Anda dapat menjelajahi halaman publik, dokumentasi produk, dan alur akun LightVela dalam Bahasa Indonesia.` |
| Español | `El indonesio ya está disponible` | `Ahora puedes explorar las páginas públicas, la documentación del producto y los flujos de cuenta de LightVela en indonesio.` |

### 2026 年 8 月 · 国际站正式上线并启用付费服务

- 仅国际站显示，放在国际站 8 月更新日志最后一条。
- 不配图，使用现有 `visual: "none"`。
- 各可见语言文案：

| 语言 | 标题 | 描述 |
| --- | --- | --- |
| 简体中文（含 `zh-SG`） | `LightVela 正式上线并启用付费服务` | `LightVela 国际站正式上线，同步启用付费服务。你可以根据使用需求选择合适的订阅套餐。` |
| 繁体中文 | `LightVela 正式上線並啓用付費服務` | `LightVela 國際站正式上線，同步啓用付費服務。你可以根據使用需求選擇合適的訂閲套餐。` |
| English | `LightVela Officially Launches with Paid Services` | `LightVela is now officially available globally with paid services. Choose a subscription plan that fits your needs.` |
| Bahasa Indonesia | `LightVela Resmi Diluncurkan dengan Layanan Berbayar` | `LightVela kini resmi tersedia secara global dengan layanan berbayar. Pilih paket langganan yang sesuai dengan kebutuhan Anda.` |
| Español | `LightVela se lanza oficialmente y activa los servicios de pago` | `LightVela ya está disponible oficialmente a nivel global con servicios de pago. Elige el plan de suscripción que mejor se adapte a tus necesidades.` |

### 2026 年 7 月 · 中国站正式上线

- 仅中国站显示，放在中国站 7 月更新日志最后一条。
- 标题：`LightVela 正式上线并启用付费服务`。
- 描述：`LightVela 产品中国站正式上线，同步启用付费服务。你可以根据使用需求选择合适的订阅套餐。`
- 不配图；国际站不显示该条目。

### 2026 年 4 月 · 双站产品公测

- 中国站和国际站均使用中文源标题 `LightVela 产品公测上线`。
- 国际站复用该翻译键的现有本地化标题：
  - English：`LightVela Public Beta Launch`
  - Bahasa Indonesia：`Peluncuran Beta Publik LightVela`
  - Español：`Lanzamiento de la beta pública de LightVela`
  - 繁体中文：`LightVela 產品公測上線`
- 保留现有渠道描述和上线配图。

## 语言范围

- 覆盖国际站当前可见语言：`en-US`、`zh-CN`、`zh-SG`、`zh-Hant`、`id-ID`、`es`。
- `zh-SG` 继续复用 `zh-CN` 字典，不新增独立资源。
- `ja-JP`、`ko-KR` 当前在语言切换器中隐藏且翻译仍在进行中，本次只由提取脚本维护键结构，不补充对外翻译。

## 实现设计

- 4 月 `beta-launch` 不再按区域选择内测标题，双站统一读取现有公测翻译键。
- 两个新增 8 月条目只追加到 `isGlobal` 分支：`indonesian-language` 在前，`global-official-launch` 在最后。
- 两个新增条目均使用 `visual: "none"`，不新增视觉 variant、图片或样式。
- 中国站 8 月数组、中国站 7 月正式上线条目及其他月份内容保持不变。
- 新中文源文案通过 `pnpm i18n:extract` 生成键，再补齐必填语言；繁体中文通过 `pnpm i18n:zh-hant` 生成。

## 验证设计

- 国际站测试覆盖简体中文、繁体中文、英语、印尼语和西班牙语：
  - 4 月标题均表达 Public Beta。
  - 8 月存在印度尼西亚语支持和正式付费上线条目。
  - 两个条目均无图片，正式上线位于 8 月最后一条。
- 中国站回归测试确认不出现国际站印度尼西亚语支持和国际站正式上线描述。
- 运行 Changelog 定向测试、i18n 提取/检查、TypeScript 检查、差异检查，并分别预览中国站与国际站 Changelog。
