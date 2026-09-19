import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ReferralSection } from "@/pages/marketing/referral-section";
import { RepositoryError } from "@/repositories/http-repositories";

const auth = {
  issueReferralCode: vi.fn(),
  getReferralStats: vi.fn(),
};

vi.mock("@/contexts/repository-context", () => ({
  useRepositories: () => ({ auth }),
}));

describe("ReferralSection", () => {
  beforeEach(() => {
    auth.issueReferralCode.mockReset().mockResolvedValue({
      code: "ABC234XYZ5",
      url: "https://lightvela.com/auth/sign-in?ref=ABC234XYZ5",
      campaignId: "campaign-1",
      campaignName: "邀请返利内测",
      startsAt: "2026-09-14T00:00:00Z",
      endsAt: "2026-10-14T00:00:00Z",
    });
    auth.getReferralStats.mockReset().mockResolvedValue({
      successfulReferrals: 2,
      grantedCredits: 1000,
      pendingRewards: 1,
      grantedRewards: 2,
    });
    Object.defineProperty(window.navigator, "clipboard", {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
  });

  afterEach(() => cleanup());

  it("shows the real code and aggregate reward state", async () => {
    render(<ReferralSection />);
    expect(await screen.findByText("https://lightvela.com/auth/sign-in?ref=ABC234XYZ5")).toBeInTheDocument();
    expect(screen.getByText("邀请返利").closest("section")).toHaveClass("rounded-md", "shadow-[0_10px_30px_rgba(15,23,42,0.04)]");
    expect(screen.getByText("好友首次开通成功，双方获得积分。")).toBeInTheDocument();
    expect(screen.getByText("1000")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "复制邀请链接" }));
    await waitFor(() => {
      expect(window.navigator.clipboard.writeText).toHaveBeenCalledWith(
        "https://lightvela.com/auth/sign-in?ref=ABC234XYZ5",
      );
    });
  });

  it("stays hidden when the environment does not expose referrals", async () => {
    auth.issueReferralCode.mockRejectedValue(new RepositoryError("not found", 404, "not_found"));
    render(<ReferralSection />);
    await waitFor(() => {
      expect(screen.queryByText("邀请返利")).not.toBeInTheDocument();
    });
  });
});
