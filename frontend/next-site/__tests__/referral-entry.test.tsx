import { cleanup, render, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/pages/auth/sign-in-page", () => ({ SignInPage: () => <div>legacy-login</div> }));
vi.mock("@next-site/app-route-shell", () => ({ AppRouteShell: ({ children }: { children: React.ReactNode }) => children }));
import { SignInPageClient } from "@next-site/sign-in-page-client";

beforeEach(() => {
  (globalThis as { React?: typeof React }).React = React;
});

afterEach(() => {
  cleanup();
  router.replace.mockClear();
  window.history.replaceState(null, "", "/");
});

it("redirects legacy referral links to the current homepage without losing query parameters", async () => {
  window.history.replaceState(null, "", "/auth/sign-in?ref=ABC234&other=1");
  const view = render(<SignInPageClient />);
  await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/?ref=ABC234&other=1"));
  expect(view.queryByText("legacy-login")).toBeNull();
});

it("preserves unrelated legacy authentication consumers", async () => {
  window.history.replaceState(null, "", "/auth/sign-in");
  const view = render(<SignInPageClient />);
  await waitFor(() => expect(view.getByText("legacy-login")).toBeInTheDocument());
  expect(router.replace).not.toHaveBeenCalled();
});
