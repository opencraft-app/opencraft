import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import { ChatLoadingState } from "@/components/site/chat-loading-state";

vi.mock("@/lib/region", () => ({ isCN: false }));
vi.mock("@/i18n/t", () => ({ useT: () => (text: string) => text }));

it("keeps the existing global loading copy and decoration", () => {
  const { container } = render(<ChatLoadingState />);
  const status = screen.getByRole("status");

  expect(status).toHaveTextContent("你的 AI 小助理，马上就来");
  expect(status).toHaveTextContent("正在准备我们的对话");
  expect(container.querySelector(".lv-chat-loading-dot")).toBeNull();
  expect(container.querySelector(".lucide-sparkles")?.classList.contains("motion-safe:animate-pulse")).toBe(false);
});
