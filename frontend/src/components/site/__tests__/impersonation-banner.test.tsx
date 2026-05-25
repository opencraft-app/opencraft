import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ImpersonationBanner } from "@/components/site/impersonation-banner";

let sessionState = {
  stage: "anonymous",
  impersonated: false,
};

vi.mock("@/contexts/session-context", () => ({
  useSession: () => ({ session: sessionState }),
}));

vi.mock("@/i18n/t", () => ({
  useT: () => (value: string) => value,
}));

describe("ImpersonationBanner", () => {
  it("stays hidden for normal sessions", () => {
    sessionState = { stage: "authenticated", impersonated: false };

    render(<ImpersonationBanner />);

    expect(screen.queryByText("运营代登中")).not.toBeInTheDocument();
  });

  it("warns operators when the current session is impersonated", () => {
    sessionState = { stage: "authenticated", impersonated: true };

    render(<ImpersonationBanner />);

    expect(screen.getByText("运营代登中")).toBeInTheDocument();
    expect(screen.getByText("当前页面使用运营代登会话，操作将以目标用户身份执行。")).toBeInTheDocument();
  });
});
