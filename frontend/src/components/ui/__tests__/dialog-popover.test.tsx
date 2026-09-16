import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "../dialog";
import { Popover, PopoverContent, PopoverTrigger } from "../popover";

afterEach(cleanup);
it("shares focus and dismissal ownership for default portalled Popovers inside a modal Dialog", async () => {
  const user = userEvent.setup();
  render(<Dialog><DialogTrigger>Open form</DialogTrigger><DialogContent aria-describedby={undefined}>
    <DialogTitle>Form</DialogTitle>
    <Popover><PopoverTrigger>Choose</PopoverTrigger><PopoverContent aria-label="Choices">
      <input aria-label="Search choices" />
    </PopoverContent></Popover>
  </DialogContent></Dialog>);
  await user.click(screen.getByRole("button", { name: "Open form" }));
  const form = screen.getByRole("dialog", { name: "Form" });
  const trigger = within(form).getByRole("button", { name: "Choose" });
  await user.click(trigger);
  const input = screen.getByRole("textbox", { name: "Search choices" });
  expect(form).not.toContainElement(input);
  expect(input).toHaveFocus();
  await user.click(input);
  await user.type(input, "real pointer input");
  expect(input).toHaveValue("real pointer input");
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog", { name: "Choices" })).not.toBeInTheDocument();
  expect(form).toBeInTheDocument();
  expect(trigger).toHaveFocus();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Open form" })).toHaveFocus();
});
