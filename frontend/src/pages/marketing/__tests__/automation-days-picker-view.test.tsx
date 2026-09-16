import { useState } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { AutomationDaysPickerView } from "../automation-days-picker-view";

afterEach(cleanup);
beforeAll(() => { vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); });
afterAll(() => vi.unstubAllGlobals());

it("keeps keyboard focus through controlled day selections and prevents removing the last day", async () => {
  const changed = vi.fn();
  function Fixture() {
    const [selected, setSelected] = useState([1, 2]);
    return <AutomationDaysPickerView label="Weekdays" selected={selected} options={[{ value: 1, label: "Monday" }, { value: 2, label: "Tuesday" }]}
      lastRemainingLabel="Keep at least one day" removeLabel={(day) => `Remove ${day}`}
      onToggle={(value) => { changed(value); setSelected((current) => current.includes(value) ? current.filter((day) => day !== value) : [...current, value]); }} />;
  }
  const user = userEvent.setup();
  render(<Fixture />);
  const trigger = screen.getByRole("button", { name: "Weekdays" });
  trigger.focus();
  await user.keyboard("{ArrowDown}");
  await waitFor(() => expect(screen.getByRole("menuitemcheckbox", { name: "Monday" })).toHaveFocus());
  await user.keyboard("{ArrowDown}{Enter}");
  expect(screen.getByRole("menuitemcheckbox", { name: "Tuesday" })).toHaveFocus();
  expect(screen.getByRole("menuitemcheckbox", { name: "Tuesday" })).toHaveAttribute("aria-checked", "false");
  await user.keyboard("{ArrowUp}{Enter}");
  expect(changed).toHaveBeenCalledExactlyOnceWith(2);
  expect(screen.getByRole("menuitemcheckbox", { name: "Monday" })).toHaveAttribute("aria-checked", "true");
  await user.keyboard("{ArrowDown}{Enter}");
  expect(screen.getByRole("menuitemcheckbox", { name: "Tuesday" })).toHaveFocus();
  expect(screen.getByRole("menuitemcheckbox", { name: "Tuesday" })).toHaveAttribute("aria-checked", "true");
  await user.keyboard("{Escape}");
  expect(trigger).toHaveFocus();
});
