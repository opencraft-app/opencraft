import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LegalFooter } from "@/components/site/legal-footer";

vi.mock("@/i18n/t", () => ({
  useT: () => (text: string, values?: Record<string, number>) =>
    values?.year ? text.replace("{{year}}", String(values.year)) : text,
  useLocaleOverride: () => null,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: { language: "zh-CN" },
  }),
}));

vi.mock("@/lib/region", () => ({
  isCN: true,
  isGlobal: false,
  localizedPath: (path: string) => path,
}));

afterEach(() => {
  cleanup();
});

describe("LegalFooter", () => {
  it("links domestic product feedback to the Tencent questionnaire", () => {
    render(<LegalFooter />);

    const feedbackLink = screen.getByRole("link", { name: "产品反馈" });
    expect(feedbackLink).toHaveAttribute("href", "https://wj.qq.com/s2/27184784/6d06/");
    expect(feedbackLink).toHaveAttribute("target", "_blank");
    expect(feedbackLink).toHaveAttribute("rel", "noopener noreferrer");
  });
});
