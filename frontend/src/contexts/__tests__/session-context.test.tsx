import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTH_UNAUTHORIZED_EVENT } from "@/repositories/http-repositories";
import { SessionProvider, useSession } from "@/contexts/session-context";
import { ACCOUNT_UPDATED_EVENT } from "@opencraft/mobile-account-sdk";

const getSession = vi.fn();
const getProfile = vi.fn();
afterEach(() => { cleanup(); getSession.mockReset(); getProfile.mockReset(); });
const storageValues = new Map<string, string>();
const repositories = {
  auth: {
    getSession,
    getProfile,
  },
};

vi.mock("@/contexts/repository-context", () => ({
  useRepositories: () => repositories,
}));

const SessionProbe = () => {
  const { isAuthenticated, authReady, session } = useSession();
  return (
    <div>
      <span data-testid="auth-ready">{String(authReady)}</span>
      <span data-testid="is-authenticated">{String(isAuthenticated)}</span>
      <span data-testid="name">{session.user?.name ?? ""}</span>
    </div>
  );
};

describe("SessionProvider unauthorized handling", () => {
  it("bootstraps test localStorage", () => {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storageValues.get(key) ?? null,
      setItem: (key: string, value: string) => storageValues.set(key, value),
      removeItem: (key: string) => storageValues.delete(key),
      clear: () => storageValues.clear(),
    });
    globalThis.localStorage.clear();
    expect(globalThis.localStorage.getItem("missing")).toBeNull();
  });

  it("signs the session out when a global unauthorized event is dispatched", async () => {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storageValues.get(key) ?? null,
      setItem: (key: string, value: string) => storageValues.set(key, value),
      removeItem: (key: string) => storageValues.delete(key),
      clear: () => storageValues.clear(),
    });
    globalThis.localStorage.clear();
    getSession.mockResolvedValueOnce({
      user: {
        id: "usr_123",
        name: "Test User",
        inviteRequired: false,
        createdAt: "2026-03-20T00:00:00Z",
      },
      currentSubscription: null,
    });

    render(
      <SessionProvider>
        <SessionProbe />
      </SessionProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("auth-ready")).toHaveTextContent("true");
      expect(screen.getByTestId("is-authenticated")).toHaveTextContent("true");
    });

    await act(async () => {
      window.dispatchEvent(new Event(AUTH_UNAUTHORIZED_EVENT));
    });

    expect(screen.getByTestId("is-authenticated")).toHaveTextContent("false");
  });

  it("refreshes the embedded session after a native account update", async () => {
    getSession.mockResolvedValueOnce({ user: { id: "usr_123", name: "Before", inviteRequired: false, createdAt: "2026-03-20T00:00:00Z" }, currentSubscription: null });
    getProfile.mockResolvedValueOnce({ id: "usr_123", name: "After", inviteRequired: false, createdAt: "2026-03-20T00:00:00Z" });
    render(<SessionProvider><SessionProbe /></SessionProvider>);
    await waitFor(() => expect(screen.getByTestId("name")).toHaveTextContent("Before"));
    await act(async () => { window.dispatchEvent(new Event(ACCOUNT_UPDATED_EVENT)); });
    await waitFor(() => expect(screen.getByTestId("name")).toHaveTextContent("After"));
    expect(getProfile).toHaveBeenCalledTimes(1);
  });
});
