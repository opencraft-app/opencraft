import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AuthDialogFrame } from "../auth-dialog-frame";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("keeps the dialog scrollable inside a keyboard-reduced mobile viewport", () => {
  const visual = Object.assign(new EventTarget(), { offsetTop: 0, height: 640 });
  vi.stubGlobal("visualViewport", visual);
  const { unmount } = render(<AuthDialogFrame open ariaLabel="Login" onClose={() => undefined}><div style={{ height: 900 }}>Long form</div></AuthDialogFrame>);
  const dialog = screen.getByRole("dialog");
  expect(dialog).toHaveClass("overflow-y-auto", "max-h-full");
  act(() => { visual.height = 280; visual.offsetTop = 20; visual.dispatchEvent(new Event("resize")); });
  expect(dialog.parentElement).toHaveStyle({ height: "280px", top: "20px", bottom: "auto" });
  const removed = vi.spyOn(visual, "removeEventListener");
  unmount();
  expect(removed).toHaveBeenCalledWith("resize", expect.any(Function));
  expect(removed).toHaveBeenCalledWith("scroll", expect.any(Function));
});
