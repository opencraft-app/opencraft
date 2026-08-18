# 国际站账号页卡管理（前端 UI 占位）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 国际站账号管理界面新增「签约卡管理」区域，纯前端 UI 占位支持查卡列表/绑卡/默认卡变更/解绑卡。

**Architecture:** 新建独立组件 `SavedCardsSection`，挂载到 `account-page.tsx`，`isGlobal` 时渲染。卡数据用 `useState<SavedCard[]>` 维护，初始预置 3 张演示卡（含 1 张默认），不调后端不落库。复用 `subscribe-page.tsx` 的 `CreditCardConfirmOrderModal` 校验逻辑（复制纯函数，不改 subscribe-page）。

**Tech Stack:** React 19 + TypeScript 5.9 + Tailwind CSS 4 + Vitest + Testing Library。i18n 走 `t()` + `pnpm i18n:extract`。

## Global Constraints

- 纯前端占位：不调后端、不落库、不发请求，刷新页面卡数据丢失。
- 仅国际站展示：`isGlobal=true` 时渲染 section。
- 不改动 `next-site/subscribe-page.tsx`（保持 `fix/next-site-payment-modal-i18n` 已 rebase 状态）。
- CVC 不存储（即便占位也不留 CVC，与 PCI 口径一致）。
- 所有文案走 `t()`，en-US/zh-CN 均需补齐，`pnpm i18n:check` 必须通过。
- 项目无 eslint（lint 不适用），门禁为 `tsc --noEmit` + `vitest` + `i18n:check`。
- commit message 中文在前 + 英文补充在后。

---

### Task 1: SavedCard 类型与纯函数（卡号格式化/品牌识别/校验）

**Files:**
- Create: `src/pages/marketing/saved-cards-section.tsx`
- Test: `src/pages/marketing/__tests__/saved-cards-section.test.tsx`

**Interfaces:**
- Produces:
  - `interface SavedCard { id: string; brand: "visa" | "mastercard" | "amex"; last4: string; expiry: string; holderName: string; isDefault: boolean }`
  - `function formatExpiry(v: string): string` — 输入数字串返回 `MM/YY`
  - `function detectBrand(cardNumber: string): "visa" | "mastercard" | "amex"` — 按卡号前缀识别
  - `function validateCardInput(cardNumber: string, expiry: string, cvc: string, holder: string): string | null` — 返回错误文案 key 或 null
  - `function buildInitialCards(): SavedCard[]` — 返回 3 张预置演示卡

- [ ] **Step 1: Write the failing test**

```tsx
// src/pages/marketing/__tests__/saved-cards-section.test.tsx
import { describe, it, expect } from "vitest";
import {
  formatExpiry,
  detectBrand,
  validateCardInput,
  buildInitialCards,
} from "../saved-cards-section";

describe("saved-cards-section pure functions", () => {
  it("formatExpiry formats digits to MM/YY", () => {
    expect(formatExpiry("12")).toBe("12");
    expect(formatExpiry("1227")).toBe("12/27");
  });

  it("detectBrand identifies visa/mastercard/amex by prefix", () => {
    expect(detectBrand("4242 1111 2222 3333")).toBe("visa");
    expect(detectBrand("5555 1111 2222 3333")).toBe("mastercard");
    expect(detectBrand("3782 822463 10005")).toBe("amex");
  });

  it("validateCardInput returns null for valid input", () => {
    expect(validateCardInput("4242 1111 2222 3333", "12/27", "123", "John Doe")).toBeNull();
  });

  it("validateCardInput returns error for short card number", () => {
    expect(validateCardInput("4242", "12/27", "123", "John Doe")).not.toBeNull();
  });

  it("validateCardInput returns error for invalid expiry", () => {
    expect(validateCardInput("4242 1111 2222 3333", "13/27", "123", "John Doe")).not.toBeNull();
  });

  it("validateCardInput returns error for empty holder", () => {
    expect(validateCardInput("4242 1111 2222 3333", "12/27", "123", "  ")).not.toBeNull();
  });

  it("buildInitialCards returns 3 cards with exactly one default", () => {
    const cards = buildInitialCards();
    expect(cards).toHaveLength(3);
    expect(cards.filter((c) => c.isDefault)).toHaveLength(1);
    expect(cards.map((c) => c.brand).sort()).toEqual(["amex", "mastercard", "visa"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/pages/marketing/__tests__/saved-cards-section.test.tsx`
Expected: FAIL with "Failed to resolve import" or "formatExpiry is not a function"

- [ ] **Step 3: Write minimal implementation**

Create `src/pages/marketing/saved-cards-section.tsx`:

```tsx
import { useTranslation } from "@/i18n/i18n-provider";

export interface SavedCard {
  id: string;
  brand: "visa" | "mastercard" | "amex";
  last4: string;
  expiry: string;
  holderName: string;
  isDefault: boolean;
}

/** 格式化有效期输入：纯数字串 → MM/YY */
export const formatExpiry = (v: string): string => {
  const d = v.replace(/\D/g, "").slice(0, 4);
  return d.length >= 3 ? `${d.slice(0, 2)}/${d.slice(2)}` : d;
};

/** 按卡号前缀识别品牌 */
export const detectBrand = (cardNumber: string): "visa" | "mastercard" | "amex" => {
  const d = cardNumber.replace(/\D/g, "");
  if (d.startsWith("4")) return "visa";
  if (d.startsWith("5")) return "mastercard";
  if (d.startsWith("3")) return "amex";
  return "visa";
};

/** 校验绑卡表单输入，返回错误文案 key 或 null（无错误） */
export const validateCardInput = (
  cardNumber: string,
  expiry: string,
  cvc: string,
  holder: string,
): string | null => {
  const digits = cardNumber.replace(/\D/g, "");
  if (digits.length < 13) return "请输入有效的卡号。";
  if (!/^\d{2}\/\d{2}$/.test(expiry)) return "有效期格式应为 MM/YY。";
  const [mm] = expiry.split("/");
  if (Number(mm) < 1 || Number(mm) > 12) return "有效期月份应在 01-12 之间。";
  if (cvc.replace(/\D/g, "").length < 3) return "安全码无效。";
  if (!holder.trim()) return "请输入持卡人姓名。";
  return null;
};

/** 预置 3 张演示卡（含 1 张默认） */
export const buildInitialCards = (): SavedCard[] => [
  { id: "demo-1", brand: "visa", last4: "4242", expiry: "12/27", holderName: "John Doe", isDefault: true },
  { id: "demo-2", brand: "mastercard", last4: "5555", expiry: "08/26", holderName: "John Doe", isDefault: false },
  { id: "demo-3", brand: "amex", last4: "3782", expiry: "03/28", holderName: "John Doe", isDefault: false },
];

// 占位导出，Task 2 会替换为真实组件
export const _SavedCardsSectionPlaceholder = () => {
  void useTranslation();
  return null;
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/pages/marketing/__tests__/saved-cards-section.test.tsx`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
cd frontend
git add src/pages/marketing/saved-cards-section.tsx src/pages/marketing/__tests__/saved-cards-section.test.tsx
git commit -m "新增卡管理类型与纯函数 / feat(account): add saved-card types and pure helpers"
```

---

### Task 2: SavedCardsSection 组件（卡列表 + 绑卡 + 默认卡 + 解绑）

**Files:**
- Modify: `src/pages/marketing/saved-cards-section.tsx`（替换占位导出为真实组件）
- Modify: `src/pages/marketing/__tests__/saved-cards-section.test.tsx`（追加组件渲染测试）

**Interfaces:**
- Consumes: Task 1 的 `SavedCard`/`formatExpiry`/`detectBrand`/`validateCardInput`/`buildInitialCards`
- Produces: `function SavedCardsSection(): JSX.Element` — 默认导出，无 props，自包含

- [ ] **Step 1: Write the failing test**

追加到 `src/pages/marketing/__tests__/saved-cards-section.test.tsx`：

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, beforeEach } from "vitest";
import { SavedCardsSection } from "../saved-cards-section";

// i18n provider 测试包装
const { I18nProvider } = await import("@/i18n/i18n-provider");

const renderSection = () =>
  render(
    <I18nProvider>
      <SavedCardsSection />
    </I18nProvider>,
  );

describe("SavedCardsSection component", () => {
  it("renders 3 initial cards with one marked default", () => {
    renderSection();
    expect(screen.getByText(/4242/)).toBeInTheDocument();
    expect(screen.getByText(/5555/)).toBeInTheDocument();
    expect(screen.getByText(/3782/)).toBeInTheDocument();
    // 默认卡标记（Visa 4242 是默认）
    expect(screen.getAllByText(/默认|Default/i).length).toBeGreaterThan(0);
  });

  it("shows add card form when clicking add button", () => {
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: /添加卡片|Add card/i }));
    expect(screen.getByPlaceholderText(/卡号|Card number/i)).toBeInTheDocument();
  });

  it("set as default switches default card", () => {
    renderSection();
    // Mastercard 5555 非默认，有「设为默认」按钮
    const setDefaultBtns = screen.getAllByRole("button", { name: /设为默认|Set as default/i });
    fireEvent.click(setDefaultBtns[0]);
    // 切换后默认标记应仍为 1 个
    expect(screen.getAllByText(/默认|Default/i).length).toBeGreaterThan(0);
  });

  it("remove card with confirmation removes from list", () => {
    renderSection();
    const removeBtns = screen.getAllByRole("button", { name: /解绑|Remove|Unbind/i });
    fireEvent.click(removeBtns[0]);
    // 二次确认
    fireEvent.click(screen.getByRole("button", { name: /确认|Confirm/i }));
    expect(screen.queryByText(/5555/)).not.toBeInTheDocument();
  });

  it("empty list after removing all shows empty state", () => {
    renderSection();
    const removeAll = async () => {
      const btns = screen.getAllByRole("button", { name: /解绑|Remove|Unbind/i });
      if (btns.length === 0) return;
      fireEvent.click(btns[0]);
      fireEvent.click(screen.getByRole("button", { name: /确认|Confirm/i }));
      await Promise.resolve();
      removeAll();
    };
    removeAll();
    expect(screen.getByText(/还没有绑定卡片|No saved cards/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/pages/marketing/__tests__/saved-cards-section.test.tsx`
Expected: FAIL — `SavedCardsSection` 未导出或渲染异常

- [ ] **Step 3: Write minimal implementation**

替换 `src/pages/marketing/saved-cards-section.tsx` 中占位导出，保留 Task 1 的纯函数与类型。新增组件：

```tsx
// （保留 Task 1 的 SavedCard/formatExpiry/detectBrand/validateCardInput/buildInitialCards 导出）

import { useState } from "react";

let _cardIdCounter = 100;
const nextCardId = () => `card-${++_cardIdCounter}`;

export const SavedCardsSection = () => {
  const { t } = useTranslation();
  const [cards, setCards] = useState<SavedCard[]>(() => buildInitialCards());
  const [showAddForm, setShowAddForm] = useState(false);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);

  // 绑卡表单状态
  const [cardNumber, setCardNumber] = useState("");
  const [expiry, setExpiry] = useState("");
  const [cvc, setCvc] = useState("");
  const [holder, setHolder] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const resetForm = () => {
    setCardNumber(""); setExpiry(""); setCvc(""); setHolder(""); setFormError(null);
  };

  const handleSaveCard = () => {
    const errKey = validateCardInput(cardNumber, expiry, cvc, holder);
    if (errKey) { setFormError(t(errKey)); return; }
    const digits = cardNumber.replace(/\D/g, "");
    const newCard: SavedCard = {
      id: nextCardId(),
      brand: detectBrand(cardNumber),
      last4: digits.slice(-4),
      expiry,
      holderName: holder.trim(),
      isDefault: cards.length === 0, // 首张卡自动默认
    };
    setCards((prev) => [...prev, newCard]);
    resetForm();
    setShowAddForm(false);
  };

  const handleSetDefault = (id: string) => {
    setCards((prev) => prev.map((c) => ({ ...c, isDefault: c.id === id })));
  };

  const handleConfirmRemove = (id: string) => {
    setCards((prev) => {
      const next = prev.filter((c) => c.id !== id);
      // 移除的是默认卡且列表非空：自动选剩余首张为默认
      const removedWasDefault = prev.find((c) => c.id === id)?.isDefault ?? false;
      if (removedWasDefault && next.length > 0) {
        next[0] = { ...next[0], isDefault: true };
      }
      return next;
    });
    setConfirmRemoveId(null);
  };

  const brandLabel = (brand: SavedCard["brand"]) =>
    brand === "visa" ? "Visa" : brand === "mastercard" ? "Mastercard" : "Amex";

  return (
    <section className="mx-auto px-6 md:px-8" style={{ maxWidth: 800 }}>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold">{t("签约卡管理")}</h2>
        {!showAddForm && (
          <button
            type="button"
            onClick={() => setShowAddForm(true)}
            className="text-sm font-medium text-blue-600 hover:underline"
          >
            {t("添加卡片")}
          </button>
        )}
      </div>

      {/* 卡列表 */}
      {cards.length === 0 ? (
        <p className="text-sm text-gray-500 py-8 text-center">{t("还没有绑定卡片")}</p>
      ) : (
        <ul className="space-y-3">
          {cards.map((card) => (
            <li key={card.id} className="flex items-center justify-between p-4 rounded-lg border border-gray-200">
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-semibold">{brandLabel(card.brand)}</span>
                  <span className="text-gray-500">•••• {card.last4}</span>
                  {card.isDefault && (
                    <span className="px-2 py-0.5 text-xs rounded bg-blue-100 text-blue-700">{t("默认")}</span>
                  )}
                </div>
                <p className="text-xs text-gray-400 mt-1">{card.expiry} · {card.holderName}</p>
              </div>
              <div className="flex items-center gap-2">
                {!card.isDefault && (
                  <button type="button" onClick={() => handleSetDefault(card.id)} className="text-sm text-gray-600 hover:underline">
                    {t("设为默认")}
                  </button>
                )}
                {confirmRemoveId === card.id ? (
                  <>
                    <button type="button" onClick={() => handleConfirmRemove(card.id)} className="text-sm text-red-600 hover:underline">{t("确认")}</button>
                    <button type="button" onClick={() => setConfirmRemoveId(null)} className="text-sm text-gray-500 hover:underline">{t("取消")}</button>
                  </>
                ) : (
                  <button type="button" onClick={() => setConfirmRemoveId(card.id)} className="text-sm text-red-600 hover:underline">{t("解绑")}</button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* 绑卡表单（内联展开） */}
      {showAddForm && (
        <div className="mt-4 p-4 rounded-lg border border-gray-200 bg-gray-50">
          <div className="space-y-3">
            <div>
              <label className="block text-sm font-medium mb-1">{t("卡号")}</label>
              <input
                value={cardNumber}
                onChange={(e) => setCardNumber(e.target.value)}
                placeholder={t("卡号")}
                className="w-full px-3 py-2 border border-gray-300 rounded text-sm"
              />
            </div>
            <div className="flex gap-3">
              <div className="flex-1">
                <label className="block text-sm font-medium mb-1">{t("有效期")}</label>
                <input
                  value={expiry}
                  onChange={(e) => setExpiry(formatExpiry(e.target.value))}
                  placeholder="MM/YY"
                  className="w-full px-3 py-2 border border-gray-300 rounded text-sm"
                />
              </div>
              <div className="flex-1">
                <label className="block text-sm font-medium mb-1">{t("安全码")}</label>
                <input
                  value={cvc}
                  onChange={(e) => setCvc(e.target.value.replace(/\D/g, "").slice(0, 4))}
                  placeholder="CVC"
                  className="w-full px-3 py-2 border border-gray-300 rounded text-sm"
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">{t("持卡人姓名")}</label>
              <input
                value={holder}
                onChange={(e) => setHolder(e.target.value)}
                placeholder={t("持卡人姓名")}
                className="w-full px-3 py-2 border border-gray-300 rounded text-sm"
              />
            </div>
            {formError && <p className="text-sm text-red-600">{formError}</p>}
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => { resetForm(); setShowAddForm(false); }} className="px-4 py-2 text-sm text-gray-600 hover:underline">{t("取消")}</button>
              <button type="button" onClick={handleSaveCard} className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded hover:bg-blue-700">{t("保存")}</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/pages/marketing/__tests__/saved-cards-section.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd frontend
git add src/pages/marketing/saved-cards-section.tsx src/pages/marketing/__tests__/saved-cards-section.test.tsx
git commit -m "新增 SavedCardsSection 卡管理组件 / feat(account): add SavedCardsSection with bind/default/remove"
```

---

### Task 3: 挂载到 account-page 并补 i18n

**Files:**
- Modify: `src/pages/marketing/account-page.tsx`（import + 渲染，`isGlobal` 时）
- Modify: `src/i18n/generated/*.json`（i18n:extract 自动生成）

**Interfaces:**
- Consumes: Task 2 的 `SavedCardsSection` 默认导出

- [ ] **Step 1: 在 account-page 渲染 SavedCardsSection**

在 `src/pages/marketing/account-page.tsx` 中：

1) 顶部 import 区（与其他 `./xxx-section` 同区）加：
```tsx
import { SavedCardsSection } from "./saved-cards-section";
```

2) 在 `SubscriptionSection` 渲染附近（约 line 2809 `<SubscriptionSection ... />` 之后），追加：
```tsx
{isGlobal && <SavedCardsSection />}
```

- [ ] **Step 2: 提取 i18n key**

Run: `cd frontend && node scripts/i18n-extract.mjs`
Expected: 输出 "扫描 N 个源文件 / 发现 X 条中文文案 / 写入 src/i18n/generated"，新增文案被收录。

- [ ] **Step 3: 补齐英文翻译（en-US.json 中本次新增的空值）**

检查 `src/i18n/generated/en-US.json` 中本次新增的空字符串 key，补齐：
- 签约卡管理 → `Saved cards`
- 添加卡片 → `Add card`
- 还没有绑定卡片 → `No saved cards`
- 默认 → `Default`
- 设为默认 → `Set as default`
- 解绑 → `Remove`
- 确认 → `Confirm`
- 取消 → `Cancel`
- 卡号 → `Card number`
- 有效期 → `Expiry`
- 安全码 → `CVC`
- 持卡人姓名 → `Cardholder name`
- 保存 → `Save`
- 请输入有效的卡号。 → `Please enter a valid card number.`
- 有效期格式应为 MM/YY。 → `Expiry date must be MM/YY.`
- 有效期月份应在 01-12 之间。 → `Expiry month must be between 01 and 12.`
- 安全码无效。 → `Invalid security code.`
- 请输入持卡人姓名。 → `Cardholder name is required.`

用 sed 批量替换空值为对应英文（参考 fix/next-site-payment-modal-i18n 的补译方式）。

- [ ] **Step 4: 验证 i18n:check**

Run: `cd frontend && node scripts/i18n-extract.mjs --check`
Expected: `✅ check 通过`，0 待翻译。

- [ ] **Step 5: 验证 tsc**

Run: `cd frontend && npx tsc --noEmit -p tsconfig.json`
Expected: 0 errors。

- [ ] **Step 6: Commit**

```bash
cd frontend
git add src/pages/marketing/account-page.tsx src/i18n/generated/en-US.json src/i18n/generated/zh-CN.json src/i18n/generated/zh-to-key.json
git commit -m "账号页挂载卡管理区域并补齐 i18n / feat(account): mount SavedCardsSection on intl account page"
```

---

## Self-Review 结果

**1. Spec coverage:**
- 查卡列表 ✅ Task 2 渲染 `cards`
- 绑卡 ✅ Task 2 `handleSaveCard`
- 默认卡变更 ✅ Task 2 `handleSetDefault`
- 解绑卡 ✅ Task 2 `handleConfirmRemove`
- 仅国际站展示 ✅ Task 3 `{isGlobal && <SavedCardsSection />}`
- 预置 3 张演示卡 ✅ Task 1 `buildInitialCards`
- 不改 subscribe-page ✅ 全程不碰 `next-site/subscribe-page.tsx`
- CVC 不存储 ✅ Task 2 不存 CVC 到 SavedCard
- i18n:check ✅ Task 3 Step 4
- tsc ✅ Task 3 Step 5

**2. Placeholder scan:** 无 TBD/TODO，所有步骤含完整代码。

**3. Type consistency:** `SavedCard` 接口在 Task 1 定义，Task 2 复用一致；`SavedCardsSection` 默认导出在 Task 2，Task 3 import 名称一致。
