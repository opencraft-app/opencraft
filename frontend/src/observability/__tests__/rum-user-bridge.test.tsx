import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RumUserBridge } from "@/observability/rum-user-bridge";

const aegisMock = vi.hoisted(() => ({
  initAegis: vi.fn(() => Promise.resolve(null)),
  setAegisUser: vi.fn(),
}));

vi.mock("@/observability/aegis", () => ({
  initAegis: aegisMock.initAegis,
  setAegisUser: aegisMock.setAegisUser,
}));

let sessionState = {
  isAuthenticated: false,
  session: { user: undefined as { id?: string } | undefined },
};

vi.mock("@/contexts/session-context", () => ({
  useSession: () => sessionState,
}));

describe("RumUserBridge", () => {
  beforeEach(() => {
    aegisMock.initAegis.mockClear();
    aegisMock.setAegisUser.mockClear();
    sessionState = { isAuthenticated: false, session: { user: undefined } };
  });

  it("initializes Aegis once on mount so RUM reporting starts under Next", () => {
    render(<RumUserBridge />);

    expect(aegisMock.initAegis).toHaveBeenCalledTimes(1);
  });

  it("binds the authenticated user id to the RUM session", () => {
    sessionState = {
      isAuthenticated: true,
      session: { user: { id: "usr_123" } },
    };

    render(<RumUserBridge />);

    expect(aegisMock.setAegisUser).toHaveBeenCalledWith("usr_123");
  });

  it("clears the RUM user when anonymous", () => {
    render(<RumUserBridge />);

    expect(aegisMock.setAegisUser).toHaveBeenCalledWith(null);
  });
});
