import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ModelActionTooltip } from "../model-action-tooltip";

describe("ModelActionTooltip", () => {
  afterEach(() => cleanup());
  beforeAll(() => vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }));
  afterAll(() => vi.unstubAllGlobals());

  it("clears its open state when the disabled reason is removed", async () => {
    const view = render(
      <ModelActionTooltip content="当前模型已经是主模型">
        <button type="button" disabled>设为主模型</button>
      </ModelActionTooltip>,
    );
    await userEvent.hover(screen.getByRole("group", { name: "当前模型已经是主模型" }));
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.closest("[data-slot=tooltip-content]")).toHaveClass("agents-ui");

    view.rerender(
      <ModelActionTooltip>
        <button type="button">设为主模型</button>
      </ModelActionTooltip>,
    );
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    view.rerender(
      <ModelActionTooltip content="当前模型已经是主模型">
        <button type="button" disabled>设为主模型</button>
      </ModelActionTooltip>,
    );
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });
});
