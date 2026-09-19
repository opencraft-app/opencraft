import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AgentPageLoadingState } from "../agent-loading-state";

describe("AgentPageLoadingState", () => {
  it("renders one centered page-level status with a decorative spinner", () => {
    render(<AgentPageLoadingState title="正在加载页面" />);

    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-busy", "true");
    expect(status).toHaveTextContent("正在加载页面");
    expect(status).toHaveClass("flex", "min-h-[min(60vh,520px)]", "items-center", "justify-center");
    expect(status.querySelector('[data-slot="spinner"]')).toHaveAttribute("aria-hidden", "true");
  });
});
