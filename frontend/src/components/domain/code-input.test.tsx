import { useState } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { CodeInput } from "@/components/domain/code-input";

const Harness = () => {
  const [value, setValue] = useState("");

  return (
    <>
      <CodeInput value={value} onChange={setValue} />
      <output data-testid="code-value">{value}</output>
    </>
  );
};

describe("CodeInput", () => {
  afterEach(() => {
    cleanup();
  });

  it("hides the native caret because the visible slots own the focus state", () => {
    render(<Harness />);

    const input = screen.getByLabelText("Verification code");

    expect(input).toHaveClass("caret-transparent");
    expect(input).toHaveClass("text-transparent");
  });

  it("supports entering the full code continuously", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByLabelText("Verification code");

    await user.type(input, "123456");

    expect(screen.getByTestId("code-value")).toHaveTextContent("123456");
    expect(screen.getByLabelText("Digit 1")).toHaveValue("1");
    expect(screen.getByLabelText("Digit 2")).toHaveValue("2");
    expect(screen.getByLabelText("Digit 3")).toHaveValue("3");
    expect(screen.getByLabelText("Digit 4")).toHaveValue("4");
    expect(screen.getByLabelText("Digit 5")).toHaveValue("5");
    expect(screen.getByLabelText("Digit 6")).toHaveValue("6");
  });
});
