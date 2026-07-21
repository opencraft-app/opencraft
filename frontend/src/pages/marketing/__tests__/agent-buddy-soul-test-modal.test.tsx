import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SoulTestModal } from "@/pages/marketing/agent-buddy-soul-test-modal";
import type { SkillHubSoul } from "@/lib/skillhub-api";
import { ENGLISH_SOULS } from "@/lib/soul-english-data";

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
    cleanup();
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

    fireEvent.click(screen.getByRole("button", { name: "添加该人设" }));

    expect(onUseSoul).toHaveBeenCalledWith(yydsSoul);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("uses the English soul test dataset when requested", async () => {
    const onUseSoul = vi.fn(() => true);
    const onClose = vi.fn();

    render(
      <SoulTestModal
        open
        souls={ENGLISH_SOULS}
        maxDrawsReached={false}
        drawnSlugs={[]}
        useEnglishSoulData
        onClose={onClose}
        onUseSoul={onUseSoul}
      />,
    );

    expect(screen.getByRole("button", { name: /^A\./ })).toHaveTextContent(/[A-Za-z]/);

    for (let index = 0; index < 15; index += 1) {
      fireEvent.click(screen.getByRole("button", { name: /^A\./ }));
      act(() => {
        vi.advanceTimersByTime(300);
      });
    }

    expect(screen.getByText(/The Legend|The Worker|The Wayfarer|The Blunt One/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "添加该人设" }));

    expect(onUseSoul).toHaveBeenCalledWith(expect.objectContaining({
      displayName: expect.stringMatching(/[A-Za-z]/),
    }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
