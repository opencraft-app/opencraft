import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RealnameStepper } from "@/pages/marketing/realname-stepper";

const labels = {
  identity: "身份信息",
  face: "人脸核身",
  phone: "手机验证",
};

afterEach(cleanup);

describe("RealnameStepper", () => {
  it("marks completed, current, and upcoming steps for a three-step flow", () => {
    render(<RealnameStepper stage="face" includePhoneStep labels={labels} />);

    expect(screen.getByText("身份信息").closest("li")).toHaveAttribute("data-state", "complete");
    expect(screen.getByText("人脸核身").closest("li")).toHaveAttribute("aria-current", "step");
    expect(screen.getByText("手机验证").closest("li")).toHaveAttribute("data-state", "upcoming");
  });

  it("omits the phone step when the current account already has a verified phone", () => {
    render(<RealnameStepper stage="face" includePhoneStep={false} labels={labels} />);

    expect(screen.getByText("身份信息")).toBeInTheDocument();
    expect(screen.getByText("人脸核身")).toBeInTheDocument();
    expect(screen.queryByText("手机验证")).not.toBeInTheDocument();
  });
});
