import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AUTH_UNAUTHORIZED_EVENT } from "@/repositories/http-repositories";
import { SessionProvider, useSession } from "@/contexts/session-context";

const getSession = vi.fn();
const storageValues = new Map<string, string>();
const repositories = {
  auth: {
    getSession,
  },
};

vi.mock("@/contexts/repository-context", () => ({
  useRepositories: () => repositories,
}));

const SessionProbe = () => {
  const { isAuthenticated, authReady } = useSession();
  return (
    <div>
      <span data-testid="auth-ready">{String(authReady)}</span>
      <span data-testid="is-authenticated">{String(isAuthenticated)}</span>
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
});
