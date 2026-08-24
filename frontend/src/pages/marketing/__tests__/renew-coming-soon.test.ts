import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { getRenewComingSoonTooltipPosition, RenewComingSoonButton } from "@/pages/marketing/renew-coming-soon";

const rect = (values: Partial<DOMRect>): DOMRect => ({
  x: values.left ?? 0,
  y: values.top ?? 0,
  width: values.width ?? 0,
  height: values.height ?? 0,
  top: values.top ?? 0,
  right: values.right ?? ((values.left ?? 0) + (values.width ?? 0)),
  bottom: values.bottom ?? ((values.top ?? 0) + (values.height ?? 0)),
  left: values.left ?? 0,
  toJSON: () => ({}),
});

describe("getRenewComingSoonTooltipPosition", () => {
  it("flips the tooltip below the trigger when there is not enough top space", () => {
    const position = getRenewComingSoonTooltipPosition({
      triggerRect: rect({ left: 100, top: 4, width: 100, height: 40, bottom: 44 }),
      tooltipRect: rect({ width: 120, height: 32 }),
      viewportWidth: 320,
      viewportHeight: 240,
    });

    expect(position).toEqual({
      left: 150,
      top: 52,
      placement: "bottom",
    });
  });

  it("keeps the tooltip inside the horizontal viewport margin", () => {
    const position = getRenewComingSoonTooltipPosition({
      triggerRect: rect({ left: 0, top: 120, width: 20, height: 32, bottom: 152 }),
      tooltipRect: rect({ width: 180, height: 32 }),
      viewportWidth: 240,
      viewportHeight: 240,
    });

    expect(position.left).toBe(102);
    expect(position.placement).toBe("top");
  });
});

describe("RenewComingSoonButton", () => {
  afterEach(cleanup);

  it("closes a focus-opened tooltip with Escape", async () => {
    render(React.createElement(RenewComingSoonButton, { label: "立即续费", tooltip: "Coming Soon" }));

    fireEvent.focus(screen.getByRole("button", { name: "立即续费" }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Coming Soon");

    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());
  });

  it("closes a hover-opened tooltip with Escape", async () => {
    render(React.createElement(RenewComingSoonButton, { label: "立即续费", tooltip: "Coming Soon" }));

    fireEvent.mouseEnter(screen.getByRole("button", { name: "立即续费" }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Coming Soon");

    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());
  });
});
