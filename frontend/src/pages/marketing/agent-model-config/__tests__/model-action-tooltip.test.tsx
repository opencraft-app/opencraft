import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { ModelActionTooltip } from "../model-action-tooltip";

describe("ModelActionTooltip", () => {
  afterEach(() => cleanup());

  it("clears its open state when the disabled reason is removed", async () => {
    const view = render(
      <ModelActionTooltip content="当前模型已经是主模型">
        <button type="button" disabled>设为主模型</button>
      </ModelActionTooltip>,
    );
    await userEvent.hover(screen.getByRole("group", { name: "当前模型已经是主模型" }));
    expect(await screen.findByRole("tooltip")).toBeInTheDocument();

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
