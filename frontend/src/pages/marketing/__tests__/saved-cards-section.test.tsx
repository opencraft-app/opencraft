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
