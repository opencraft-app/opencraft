# 国际站账号页卡管理（前端 UI 占位）设计

## 需求概要

国际站（global site）账号管理界面新增「签约卡管理」区域，支持：
1. 查卡列表
2. 绑卡
3. 默认卡变更
4. 解绑卡

## 范围与约束

- **纯前端 UI 占位**：卡数据仅在组件生命周期内维护，不调后端、不落库、不发请求。
- 与 `CreditCardConfirmOrderModal`（`next-site/subscribe-page.tsx`）的绑卡演示保持一致口径：刷新页面后卡数据丢失。
- 仅国际站展示：`isGlobal=true` 时渲染该 section。
- 不改动 `subscribe-page.tsx`（保持 `fix/next-site-payment-modal-i18n` 分支已 rebase 的状态不被本次需求污染）。

## 架构

新增独立组件 `SavedCardsSection`，挂载到 `account-page.tsx` 主布局，与其他 section（实名/安全手机/邮箱绑定/订阅）并列。

```
account-page.tsx
  └── <SavedCardsSection />   (isGlobal 时渲染)
        ├── 卡列表（CardListItem[]）
        │     ├── 品牌 + 尾号 + 默认卡标记
        │     ├── [设为默认] 按钮（非默认卡）
        │     └── [解绑] 按钮 + 二次确认
        └── [添加卡片] 按钮 → 内联绑卡表单
              ├── 卡号（格式化 + 品牌识别）
              ├── 有效期 MM/YY
              ├── CVC
              ├── 持卡人姓名
              └── [保存] / [取消]
```

## 数据模型

```ts
interface SavedCard {
  id: string;              // 前端生成的唯一 ID（crypto.randomUUID 或自增）
  brand: "visa" | "mastercard" | "amex";  // 由卡号前缀识别
  last4: string;           // 卡号后 4 位
  expiry: string;          // "MM/YY"
  holderName: string;
  isDefault: boolean;      // 默认卡标记，列表内仅 1 张为 true
}
```

- 卡数据用 `useState<SavedCard[]>` 维护，初始预置 3 张演示卡（含 1 张默认）。
- CVC 不存储（与 PCI 合规口径一致，即便占位也不留 CVC）。

## 组件职责

### `SavedCardsSection`（新文件）
- **输入**：无（自包含，纯前端）
- **状态**：`cards: SavedCard[]`、`showAddForm: boolean`、`confirmRemoveId: string | null`
- **行为**：
  - 查卡列表：渲染 `cards`
  - 绑卡：`showAddForm=true` 展示内联表单 → 校验通过 → push 新卡，若为首个则 `isDefault=true`
  - 默认卡变更：点击「设为默认」→ 将目标卡 `isDefault=true`，其余置 `false`
  - 解绑：点击「解绑」→ 二次确认 → 从 `cards` 移除；若移除的是默认卡且列表非空，自动将剩余首张设为默认
- **依赖**：仅 React + i18n `t()`；不依赖后端 repository。

### 复用点
- 卡号格式化、有效期 MM/YY 校验、CVC 位数校验逻辑：参考 `subscribe-page.tsx` 的 `CreditCardConfirmOrderModal` 实现（复制必要纯函数，不抽共享组件以避免改 subscribe-page）。
- 品牌识别：按卡号前缀（4→visa，5→mastercard，3→amex）。

## 卡列表初始预置（演示）

3 张演示卡：
1. Visa •••• 4242，12/27，John Doe，**默认**
2. Mastercard •••• 5555，08/26，John Doe
3. Amex •••• 3782，03/28，John Doe

## 交互细节

- **添加卡片**：按钮在列表底部；点击展开内联表单（不弹窗，保持账号页滚动流），保存后收起表单、新卡追加到列表末尾。
- **设为默认**：每张非默认卡显示「设为默认」按钮；默认卡显示「默认」徽章，无按钮。
- **解绑**：每张卡显示「解绑」按钮；点击后该卡行内出现「确认解绑？[确认][取消]」；确认后移除。
- **空列表**：列表为空时显示「还没有绑定卡片」+ 「添加卡片」按钮。
- **i18n**：所有文案走 `t()`，en-US/zh-CN 均需补齐（i18n:extract 会校验）。

## 错误处理

- 绑卡表单校验失败（卡号格式/有效期/CVC/姓名空）：表单内联红色错误提示，不提交。
- 解绑默认卡：自动选下一张默认，无需用户干预。
- 不涉及网络错误（纯前端）。

## 测试

- 组件级单测（`SavedCardsSection.test.tsx`）：
  - 渲染 3 张初始卡，默认卡标记正确
  - 添加新卡 → 列表 4 张，CVC 不在回显中
  - 设为默认 → 默认标记切换
  - 解绑默认卡 → 自动选剩余首张为默认
  - 空列表 → 展示空态 + 添加按钮
- i18n:check 通过
- tsc --noEmit 通过

## 文件清单

| 文件 | 改动 |
|---|---|
| `src/pages/marketing/saved-cards-section.tsx` | 新建组件 |
| `src/pages/marketing/__tests__/saved-cards-section.test.tsx` | 新建单测 |
| `src/pages/marketing/account-page.tsx` | import + 渲染 `<SavedCardsSection />`（isGlobal 时） |
| `src/i18n/generated/*.json` | i18n:extract 生成 |

## 非目标（YAGNI）

- 不做真实支付渠道集成（Stripe SetupIntent / payment_method 持久化）。
- 不做卡 BIN 完整识别（仅 visa/mastercard/amex 三类）。
- 不做卡排序/搜索。
- 不与订阅页 CreditCardConfirmOrderModal 共享卡状态（两处独立演示）。
