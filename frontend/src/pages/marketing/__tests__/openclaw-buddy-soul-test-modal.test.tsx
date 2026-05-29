import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SoulTestModal } from "@/pages/marketing/openclaw-buddy-soul-test-modal";
import type { SkillHubSoul } from "@/lib/skillhub-api";

const yydsSoul: SkillHubSoul = {
  id: 1,
  slug: "YYDS",
  displayName: "YYDS · 神人",
  summary: "狂傲自信的神人",
  remark: "",
  version: "1.0.0",
  createdAt: 0,
  updatedAt: 0,
};

describe("SoulTestModal", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("uses the recommended Soul in LightVela instead of navigating to SkillHub", async () => {
    const onUseSoul = vi.fn(() => true);
    const onClose = vi.fn();
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);

    render(
      <SoulTestModal
        open
        souls={[yydsSoul]}
        maxDrawsReached={false}
        drawnSlugs={[]}
        onClose={onClose}
        onUseSoul={onUseSoul}
      />,
    );

    for (let index = 0; index < 15; index += 1) {
      fireEvent.click(screen.getByRole("button", { name: /^A\./ }));
      act(() => {
        vi.advanceTimersByTime(300);
      });
      if (index === 4) {
        expect(screen.getByText("第二部分：选择你对智能体伙伴的偏好")).toBeInTheDocument();
      }
    }

    expect(screen.getByText("为你推荐的智能体伙伴 Soul 是")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "使用该 Soul" }));

    expect(onUseSoul).toHaveBeenCalledWith(yydsSoul);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(openSpy).not.toHaveBeenCalled();
  });
});
