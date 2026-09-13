# 升级套餐交互优化与默认展示

日期：2026-09-11。分支：`frontsandbox/upgrade-interaction`。

交付准备：`frontsandbox/upgrade-interaction-clean`，基于本次拉取的 master `b3184f39a45816660787f8e62921673a5658de99`；原分支和预览继续保留。下文“已有本地提交”描述原分支记录。

## 状态与范围

- 用户要求按最新实现同步 OpenSpec；当前规则集中维护在 [升级套餐交互](../specs/pass-upgrade.md)。
- 已有交互代码在本地提交 `289b835ffdccb7a0620a52cb04022e3c42d6fb78`；其后的移除 show 开关及本次文档更新尚未提交。
- 本记录不代表上线或真实支付验收。没有执行 push、创建 MR 或发布，也没有恢复 / 归档不属于本需求的 FE-AI Native change。
- [实现计划](../plan.md) 的 Task 1–7 保留逐轮验证记录；本次 Task 8 仅同步规格和文档引用，未修改业务实现。

## 最新实现摘要

1. 升级入口取消 show / hide 和域名展示限制；继续校验登录、计费启用、有效 Pass 与后端合法目标。
2. 卡片按钮显示“升级至此套餐”；点击后在按钮内询价，完整有效报价返回才打开确认框。
3. 确认框聚焦目标套餐配置、目标模型积分、应补差价和支付方式，统一新购圆角；支付按钮 loading 覆盖重新询价、订单创建和凭证准备。
4. 国内展示专门的微信二维码支付框，国际采用与新购一致的外部卡支付打开方式；支付确认后直接进入 Agents。
5. Agents 升级等待视图展示咖啡插画、目标套餐和到期时间，移除模型积分；目标未知时占位并重试，不显示来源套餐冒充目标。
6. 国际回跳按用户 / 订单恢复，标记不代表支付成功；持有订单上下文时要求订单 success + provisioned、目标 Pass active 和新 Bot 快照齐备后结束等待。无订单上下文的服务端 modifying 恢复路径另行说明，避免夸大校验范围。

## 文档组织

- `specs/pass-upgrade.md`：完整当前规则、异常边界及源码 / 测试映射。
- `spec.md`：本需求当前规格入口，保留其他需求历史章节。
- `specs/plan.md`、`specs/marketing.md`：模块索引及升级摘要，明确旧 createPass / success 页描述不适用于升级。
- `config.yaml`：修正国际订阅一律伪支付的旧概括，增加升级规格路由。
- 不重置旧 `current_state.md`，不改写其他需求的计划或归档状态。

## 验证记录

已执行的前序验证（仅作为历史证据）：

- 合并 master 后：15 个测试文件 517 条通过、1 条原有跳过；国内 / 国际构建分别生成 97 / 607 页。
- 移除 show 开关后：7 个文件 123 条测试通过；`pnpm check` 通过，174 current / 276 baseline / 0 new；独立只读审查无问题。
- 历史浏览器布局 / 支付回跳使用模拟支付状态，未执行真实扣款；不能据此声明生产支付闭环通过。

本次文档更新重新执行：

```bash
cd frontend
pnpm exec vitest run \
  src/lib/__tests__/use-pass-upgrade.test.tsx \
  src/lib/__tests__/upgrade-checkout.test.ts \
  src/pages/marketing/__tests__/upgrade-pass-modal.test.tsx \
  src/pages/marketing/__tests__/agent-upgrading-view.test.tsx \
  src/contexts/__tests__/agent-context-modification.test.tsx \
  next-site/__tests__/subscribe-page.test.tsx \
  next-site/__tests__/subscribe-page.global.test.tsx \
  src/pages/marketing/__tests__/account-page-renewal.global.test.tsx \
  src/pages/marketing/__tests__/agent-settings-renewal-reminder.test.tsx
```

- 结果：9 个文件、132 条测试全部通过。jsdom 的两条原有 `Window.open` 提示不影响用例结果；未执行真实支付。
- 仓库根执行 `python3 .agents/context/scripts/validate_documentation.py --repo . --format json`：errors、warnings、broken links 均为空。该校验不覆盖全部 OpenSpec 链接，因此额外用只读 Node 检查本轮新增 / 修改的 12 个相对链接，均存在；使用已有 YAML 解析器校验 `config.yaml` 通过。
- `git diff --check` 通过；业务源码 diff 的 SHA-256 在本次文档更新前后均为 `1aea7a632d5189324f420b2b957850cd1390e4a758d63819aa75d44bf439c680`，确认没有改动上一轮业务增量。
- 初次文档辅助校验因 YAML 包不是前端直接依赖而无法加载，改用已安装的 pnpm 包路径后通过；未安装新依赖或改变检查规则。
- 本次仅文档 / YAML 描述更新，未重新执行 `pnpm check`、生产构建、真实支付或发布；上述历史结果不充当本轮执行记录。

## Clean 分支交付准备

- 用户要求按建议使用 clean 分支验证后提交 / 推送并创建 MR。当前原分支仅有一个超出 master 的功能提交，不存在其他待移除的无关提交；master 另有19个更新需要纳入基线。
- 新工作区从 master b3184f39a 创建，使用 `cherry-pick --no-commit` 迁入 289b835ff，再迁入之后14个文件的默认展示 / OpenSpec 增量。共36个变更文件，迁入后与原工作树逐文件比对无差异；本节交付状态更新单独追加。
- 首轮 `pnpm check` 因复用依赖的真实路径指向旧目录，部分已有 velachat 类型诊断不匹配相对路径基线；复测改用独立依赖副本，不改检查脚本或类型基线。
- 独立依赖副本下 `pnpm check` exit 0：174 current / 276 baseline / 0 new / 102 resolved；i18n 结构错误0，保留49个既有告警及 id-ID 172条待翻译。
- 全量 `pnpm run test --maxWorkers=2` 首轮记录49 failed / 3071 passed / 14 skipped。账户页新增挂载刷新导致实名测试 mock 缺少 `refreshPasses`，已在该测试补齐稳定的异步方法；不修改实名断言或生产代码。实名20条转绿，变更文件数由36增至37。
- 旧 `src/pages/app/__tests__/plan-select-page.test.tsx` 持续占用 CPU；运行栈定位到该测试挂载的 React 重渲染。终止本次测试 worker 才获得汇总，因此该轮另有1个 worker error，不能视为完整结束的全量测试。master 的相同单测独立运行20秒仍未结束，随后受控终止；未修改该页面、测试或 `useAsyncResource`。
- 最终复测本需求9个文件、实名测试及下表13个失败文件，共23个文件246条断言：217 passed / 29 failed。10个完整通过文件包含本需求及实名相邻测试共152条；29条失败名称集合与 master 独立副本完全一致，`next-config` 加载错误也一致。本轮未排除用例后宣称全量通过。
- 独立只读差异审查未发现迁移漏项或业务阻断项；项目文档校验 errors / warnings / broken links 均为空，`git diff --check` 和 `git diff --cached --check` 通过。本轮没有重新构建或执行真实支付。

### master 对照失败

基线为 `b3184f39a45816660787f8e62921673a5658de99`，通过 `git archive` 导出独立副本，不修改原分支。以下为同一环境下重复出现的失败；这些测试和相关问题未在本需求中修复。

| 测试文件（相对 frontend） | 失败数 / 原因 |
| --- | --- |
| `mdx-components.test.tsx` | 1；React 未定义 |
| `scripts/docs-image-assets.test.ts` | 1；文档引用图片超出512 KiB约束 |
| `scripts/intl-only-pages.test.ts` | 1；公开页 locale 路由集合不一致 |
| `scripts/next-config.test.mjs` | 加载错误；Vitest 无法打包内置 node:test |
| `next-site/__tests__/plan-pricing-consistency.test.ts` | 1；启航 AI 首购价0与折扣推导40.8不一致 |
| `next-site/__tests__/search-routing.test.ts` | 1；已发布文档 locale 集合不一致 |
| `src/content/docs/__tests__/automation-tab-order.test.ts` | 7；多语言文档章节断言不匹配 |
| `src/pages/marketing/__tests__/agent-memory-save.test.ts` | 1；命令参数断言不匹配 |
| `src/pages/marketing/__tests__/agent-settings-channel-slack.test.ts` | 1；Slack 静态源码断言不匹配 |
| `src/pages/marketing/__tests__/agent-settings-labs-nav.test.tsx` | 2；既有 mock 缺少 useMultiBotEnabled |
| `src/pages/marketing/__tests__/agent-settings-nav-spacing.test.ts` | 1；续费标签 CSS 断言不匹配 |
| `src/pages/marketing/__tests__/lightvela-intl-home-copy.test.ts` | 10；首页图片、Footer 与繁中轮播文案断言不匹配 |
| `src/pages/marketing/__tests__/renewal-id-ID.test.ts` | 2；原有文案 key / 印尼语翻译缺失 |

另有上述 PlanSelectPage 单测挂起，未得到通过结果。

### 已确认交付范围（提交前记录）

- 当前37个文件：升级交互及 show 门禁移除（含删除旧门禁模块）、相关回归测试及实名 mock 修正、8份 i18n 映射 / 字典、OpenSpec 与上下文记录。不会带入主工作区或原预览工作区的其他改动。
- 拟提交信息 / MR 标题：`优化升级套餐交互 / feat(frontend): simplify plan upgrade checkout`。
- 拟 MR：`frontsandbox/upgrade-interaction-clean` → `master`；描述明确双站支付、按钮 loading、Agents 升级等待、入口默认展示、规格同步，以及本节验证结果与未执行真实支付的边界。
- 当前未提供 TAPD 链接，不虚构需求关联。用户在查看上述验证及范围后明确回复“确认”，同意将 master 已有失败另行处理，并授权提交、推送和创建 MR；保留原分支和5176预览，不合并或发布。
- 门禁结论为有条件通过（用户风险豁免，非全量测试通过）。本节记录提交前的确认事实；具体 commit / MR 地址与远端状态以本次工蜂交付结果为准，MR 描述必须保留上述未通过项与真实支付未验证的边界。
