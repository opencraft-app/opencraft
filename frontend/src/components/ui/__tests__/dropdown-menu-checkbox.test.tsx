import { useState } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger } from "../dropdown-menu";

afterEach(cleanup);
it("keeps controlled checkbox selections open, supports keyboard toggling and skips disabled items", async () => {
  const changed = vi.fn();
  function Example() {
    const [checked, setChecked] = useState(false);
    return <DropdownMenu><DropdownMenuTrigger>Days</DropdownMenuTrigger><DropdownMenuContent>
      <DropdownMenuCheckboxItem checked={checked} onSelect={(event) => event.preventDefault()} onCheckedChange={(next) => { changed(next); setChecked(next); }}>Monday</DropdownMenuCheckboxItem>
      <DropdownMenuCheckboxItem disabled checked onCheckedChange={changed}>Tuesday</DropdownMenuCheckboxItem>
      <DropdownMenuCheckboxItem checked={false}>Wednesday</DropdownMenuCheckboxItem>
    </DropdownMenuContent></DropdownMenu>;
  }
  const user = userEvent.setup();
  render(<Example />);
  await user.tab();
  await user.keyboard("{ArrowDown}");
  await waitFor(() => expect(screen.getByRole("menuitemcheckbox", { name: "Monday" })).toHaveFocus());
  await user.keyboard(" ");
  expect(changed).toHaveBeenCalledExactlyOnceWith(true);
  expect(screen.getByRole("menuitemcheckbox", { name: "Monday" })).toHaveAttribute("aria-checked", "true");
  await user.keyboard("{ArrowDown}");
  expect(screen.getByRole("menuitemcheckbox", { name: "Wednesday" })).toHaveFocus();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Days" })).toHaveFocus();
});
