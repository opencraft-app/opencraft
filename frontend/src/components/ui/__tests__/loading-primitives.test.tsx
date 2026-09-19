import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";

describe("loading primitives", () => {
  it("renders a decorative spinner with an explicit size", () => {
    render(<Spinner size="xs" data-testid="loading-spinner" />);

    const spinner = screen.getByTestId("loading-spinner");
    expect(spinner).toHaveAttribute("data-slot", "spinner");
    expect(spinner).toHaveAttribute("data-size", "xs");
    expect(spinner).toHaveAttribute("aria-hidden", "true");
    expect(spinner).toHaveClass("size-3", "motion-safe:animate-spin", "motion-reduce:animate-none");
  });

  it("exposes an accessible label when a spinner represents a status", () => {
    render(<Spinner size="lg" aria-label="正在加载" />);

    const spinner = screen.getByLabelText("正在加载");
    expect(spinner).toHaveAttribute("data-size", "lg");
    expect(spinner).not.toHaveAttribute("aria-hidden");
  });

  it("renders a reduced-motion friendly skeleton with the shared surface token", () => {
    render(<Skeleton data-testid="loading-skeleton" className="h-4 w-20" />);

    const skeleton = screen.getByTestId("loading-skeleton");
    expect(skeleton).toHaveAttribute("data-slot", "skeleton");
    expect(skeleton).toHaveAttribute("aria-hidden", "true");
    expect(skeleton).toHaveClass(
      "block",
      "rounded-sm",
      "bg-[var(--surface-muted)]",
      "motion-safe:animate-pulse",
      "motion-reduce:animate-none",
      "h-4",
      "w-20",
    );
  });
});
