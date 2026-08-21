import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import { AutomationSkillPicker } from "../automation-skill-picker";

vi.mock("@/lib/region", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/region")>(),
  REGION: "global",
  isCN: false,
  isGlobal: true,
  DEFAULT_LOCALE: "en-US",
}));

vi.mock("@/i18n/t", () => ({
  useT: () => (text: string) => text,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("keeps the international selected Skill option read-only", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();

  render(
    <AutomationSkillPicker
      value="finance-news"
      loadState={{ status: "ready", slugs: ["finance-news"], error: null }}
      onChange={onChange}
      onRetry={vi.fn()}
    />,
  );

  await user.click(screen.getByRole("button", { name: "调用技能" }));
  const selectedOption = screen.getByRole("option", { name: /Finance News.*finance-news/ });

  expect(selectedOption.querySelector(".lucide-check")).toHaveClass("opacity-100");
  expect(selectedOption.querySelector(".lucide-x")).not.toBeInTheDocument();

  await user.click(selectedOption);

  expect(onChange).toHaveBeenCalledWith("finance-news");
});
