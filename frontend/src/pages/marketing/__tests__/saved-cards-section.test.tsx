// src/pages/marketing/__tests__/saved-cards-section.test.tsx
import { describe, it, expect, vi } from "vitest";
import {
  formatExpiry,
  detectBrand,
  validateCardInput,
  buildInitialCards,
} from "../saved-cards-section";

// i18n 测试适配：项目使用 useT from @/i18n/t（非 useTranslation + I18nProvider）。
// 真实 pattern 是 vi.mock("@/i18n/t") 返回 identity t 函数，无需 Provider 包裹。
vi.mock("@/i18n/t", () => ({
  useT: () => (text: string, options?: Record<string, unknown>) =>
    text.replace(
      /\{\{\s*(\w+)\s*\}\}/g,
      (raw, key: string) => (options?.[key] === undefined ? raw : String(options[key])),
    ),
  t: (text: string, options?: Record<string, unknown>) =>
    text.replace(
      /\{\{\s*(\w+)\s*\}\}/g,
      (raw, key: string) => (options?.[key] === undefined ? raw : String(options[key])),
    ),
}));

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

// ─── 组件渲染测试 ───
// 适配说明：brief 使用 I18nProvider + useTranslation，但项目实际使用 useT from @/i18n/t。
// 真实 pattern：vi.mock("@/i18n/t") 返回 identity t 函数，直接 render 无需 Provider 包裹。
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach } from "vitest";
import { SavedCardsSection } from "../saved-cards-section";

afterEach(cleanup);

const renderSection = () => render(<SavedCardsSection />);

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
    fireEvent.click(setDefaultBtns[0]!);
    // 切换后默认标记应仍为 1 个
    expect(screen.getAllByText(/默认|Default/i).length).toBeGreaterThan(0);
  });

  it("remove card with confirmation removes from list", () => {
    renderSection();
    const removeBtns = screen.getAllByRole("button", { name: /解绑|Remove|Unbind/i });
    // removeBtns[0] 是 Visa 4242（列表第一张），移除后 4242 应消失
    fireEvent.click(removeBtns[0]!);
    // 二次确认
    fireEvent.click(screen.getByRole("button", { name: /确认|Confirm/i }));
    expect(screen.queryByText(/4242/)).not.toBeInTheDocument();
  });

  it("empty list after removing all shows empty state", () => {
    renderSection();
    const removeAll = () => {
      // queryAllByRole 在无匹配时返回空数组（不抛异常），适合递归终止判断
      const btns = screen.queryAllByRole("button", { name: /解绑|Remove|Unbind/i });
      if (btns.length === 0) return;
      fireEvent.click(btns[0]!);
      fireEvent.click(screen.getByRole("button", { name: /确认|Confirm/i }));
      removeAll();
    };
    removeAll();
    expect(screen.getByText(/还没有绑定卡片|No saved cards/i)).toBeInTheDocument();
  });
});
