import { act, cleanup, fireEvent, render as renderComponent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState, type ReactElement } from "react";
import userEvent from "@testing-library/user-event";
import { SoulTestModal } from "@/pages/marketing/agent-buddy-soul-test-modal";
import type { SkillHubSoul } from "@/lib/skillhub-api";
import { ENGLISH_SOULS } from "@/lib/soul-english-data";
import { JAPANESE_SOULS } from "@/lib/soul-japanese-data";
import { SPANISH_SOULS } from "@/lib/soul-spanish-data";
import { LocaleOverrideProvider, type I18nLocale } from "@/i18n/t";

// UI locale is independent of the selected Soul dataset and the deployment region.
const render = (ui: ReactElement, locale: I18nLocale = "zh-CN") => renderComponent(
  <LocaleOverrideProvider locale={locale}>{ui}</LocaleOverrideProvider>,
);

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
  it("keeps keyboard focus in the test and returns it after Escape", async () => {
    vi.useRealTimers();
    function Harness() {
      const [open, setOpen] = useState(false);
      return <><button onClick={() => setOpen(true)}>Test</button><SoulTestModal open={open} souls={[yydsSoul]} maxDrawsReached={false} drawnSlugs={[]} onClose={() => setOpen(false)} onUseSoul={() => true} /></>;
    }
    render(<Harness />);
    const user = userEvent.setup();
    const trigger = screen.getByRole("button", { name: "Test" });
    await user.click(trigger);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveClass("agents-ui");
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    vi.useFakeTimers();
  });
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    if (vi.isFakeTimers()) vi.runOnlyPendingTimers();
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

    const firstAnswer = screen.getByRole("button", { name: /^A\./ });
    fireEvent.click(firstAnswer);
    expect(firstAnswer).toHaveClass("border-black/35", "bg-black/[0.04]", "text-black/90");
    expect(firstAnswer).toHaveAttribute("aria-pressed", "true");
    expect(firstAnswer.querySelector("svg")).not.toBeNull();
    act(() => { vi.advanceTimersByTime(300); });

    for (let index = 1; index < 15; index += 1) {
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

  it("uses English UI labels and passes the displayed English Soul to the host", async () => {
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
      "en-US",
    );

    expect(screen.getByRole("dialog", { name: "Soul personality test" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close Soul personality test" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^A\./ })).toHaveTextContent(/[A-Za-z]/);

    for (let index = 0; index < 15; index += 1) {
      fireEvent.click(screen.getByRole("button", { name: /^A\./ }));
      act(() => {
        vi.advanceTimersByTime(300);
      });
      if (index === 4) {
        expect(screen.getByText("Part 2: Choose your preferences for your AI companion")).toBeInTheDocument();
      }
    }

    expect(screen.getByRole("heading", { name: "Your recommended AI companion Soul is" })).toBeInTheDocument();
    const displayedSoul = screen.getByText(/The Legend|The Worker|The Wayfarer|The Blunt One/);
    const expectedSoul = ENGLISH_SOULS.find((soul) => soul.displayName === displayedSoul.textContent);
    expect(expectedSoul).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Add this persona" }));

    expect(onUseSoul).toHaveBeenCalledWith(expectedSoul);
    expect(onUseSoul).toHaveBeenCalledWith(expect.objectContaining({
      displayName: expect.stringMatching(/[A-Za-z]/),
    }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("uses the Spanish soul test dataset when requested", async () => {
    const onUseSoul = vi.fn(() => true);

    render(
      <SoulTestModal
        open
        souls={SPANISH_SOULS}
        maxDrawsReached={false}
        drawnSlugs={[]}
        useEnglishSoulData
        useSpanishSoulData
        onClose={vi.fn()}
        onUseSoul={onUseSoul}
      />,
    );

    expect(screen.getByRole("button", { name: /^A\./ })).toHaveTextContent(/increíble|Sigo adelante|Inicio conversaciones|Amable|No importa/);

    for (let index = 0; index < 15; index += 1) {
      fireEvent.click(screen.getByRole("button", { name: /^A\./ }));
      act(() => {
        vi.advanceTimersByTime(300);
      });
    }

    expect(screen.getByText(/La leyenda|El incansable|El viajero|Sin rodeos/)).toBeInTheDocument();
  });

  it("uses the Japanese Soul pool, questions, profile, and labels through the locale adapter", async () => {
    const onUseSoul = vi.fn(() => true);

    render(
      <SoulTestModal
        open
        souls={JAPANESE_SOULS}
        maxDrawsReached={false}
        drawnSlugs={[]}
        soulDataLocale="ja"
        onClose={vi.fn()}
        onUseSoul={onUseSoul}
      />,
    );

    expect(screen.getByRole("button", { name: /^A\./ })).toHaveTextContent(/[\u3040-\u30ff]/);

    for (let index = 0; index < 15; index += 1) {
      fireEvent.click(screen.getByRole("button", { name: /^A\./ }));
      act(() => {
        vi.advanceTimersByTime(300);
      });
    }

    expect(screen.getByText(/伝説|働き者|旅人|率直な人/)).toBeInTheDocument();
    expect(screen.getByText("主導力")).toBeInTheDocument();
    expect(screen.getByText("行動力")).toBeInTheDocument();
  });
});
