import { MemoryRouter } from "react-router-dom";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlanSelectPage } from "@/pages/plan-select-page";

const mockNavigate = vi.fn();
const mockSelectPlan = vi.fn();
const mockGetPlanPreview = vi.fn();
const repositories = {
  plans: {
    getPlanPreview: mockGetPlanPreview,
  },
};

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

vi.mock("@/contexts/session-context", () => ({
  useSession: () => ({
    selectPlan: mockSelectPlan,
  }),
}));

vi.mock("@/contexts/repository-context", () => ({
  useRepositories: () => repositories,
}));

describe("PlanSelectPage", () => {
  beforeEach(() => {
    mockNavigate.mockReset();
    mockSelectPlan.mockReset();
    mockGetPlanPreview.mockReset();

    mockSelectPlan.mockResolvedValue(undefined);
    mockGetPlanPreview.mockResolvedValue({
      currentCandidate: "free",
      confirmationNeeded: true,
      plans: [
        {
          tier: "free",
          name: "免费体验",
          description: "先用一个 Bot 跑通创建、测试和配置的完整主链路。",
          priceLabel: "免费",
          priceNote: "当前开放 · 确认后直接进入控制台",
          features: ["创建 1 个 Bot"],
          available: true,
          featured: true,
          ctaLabel: "选择免费体验",
        },
      ],
    });
  });

  it("selects the free plan through the new subscription action", async () => {
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <PlanSelectPage />
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole("button", { name: "选择免费体验" }));

    await waitFor(() => {
      expect(mockSelectPlan).toHaveBeenCalledWith("free");
    });
    expect(mockNavigate).toHaveBeenCalledWith("/dashboard", { replace: true });
  });
});
