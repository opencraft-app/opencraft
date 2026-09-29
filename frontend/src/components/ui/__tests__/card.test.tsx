import { createRef } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Card } from "@/components/ui/card";

afterEach(cleanup);

describe("Card", () => {
  it("keeps the existing default appearance for other consumers", () => {
    render(<Card data-testid="card" />);
    expect(screen.getByTestId("card")).toHaveClass("rounded-[1.75rem]", "shadow-[var(--shadow-soft)]");
  });

  it("preserves the pricing outline without inheriting a floating shadow", () => {
    const ref = createRef<HTMLDivElement>();
    render(<Card ref={ref} variant="pricing" data-testid="card" />);
    const card = screen.getByTestId("card");
    expect(ref.current).toBe(card);
    expect(card).toHaveClass("rounded-[12px]", "shadow-none");
    expect(card).not.toHaveClass("shadow-[var(--shadow-soft)]");
    expect(card).not.toHaveAttribute("variant");
  });
});
