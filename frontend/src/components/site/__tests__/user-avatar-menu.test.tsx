import type { HTMLAttributes, ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UserAvatarMenu } from "@/components/site/user-avatar-menu";

vi.mock("framer-motion", () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => children,
  motion: {
    div: ({ children, ...props }: HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  },
}));

const useSession = vi.fn();
const useOpenClaw = vi.fn();

vi.mock("@/contexts/session-context", () => ({
  useSession: () => useSession(),
}));

vi.mock("@/contexts/openclaw-context", () => ({
  useOpenClaw: () => useOpenClaw(),
}));

vi.mock("@/i18n/t", () => ({
  useT: () => (value: string) => value,
}));

vi.mock("@/lib/avatar-image", () => ({
  avatarImageUrl: () => "https://example.com/avatar.png",
}));

afterEach(() => {
  cleanup();
  useSession.mockReset();
  useOpenClaw.mockReset();
});

describe("UserAvatarMenu", () => {
  it("shows active pass bundle name in hover menu when subscription snapshot is missing", () => {
    useSession.mockReturnValue({
      session: {
        user: { name: "海盐小猫", avatarUrl: "https://example.com/avatar.png" },
        currentSubscription: null,
      },
      signOut: vi.fn(),
    });
    useOpenClaw.mockReturnValue({
      activePass: {
        bundle_name: "专业版套餐",
      },
    });

    render(<UserAvatarMenu />);

    fireEvent.mouseEnter(screen.getByRole("link", { name: "avatar" }).parentElement!);

    expect(screen.getByText("套餐：专业版套餐")).toBeInTheDocument();
    expect(screen.queryByText(/^未订阅$/)).not.toBeInTheDocument();
  });

  it("falls back to unsubscribed label when neither pass nor subscription exists", () => {
    useSession.mockReturnValue({
      session: {
        user: { name: "海盐小猫", avatarUrl: "https://example.com/avatar.png" },
        currentSubscription: null,
      },
      signOut: vi.fn(),
    });
    useOpenClaw.mockReturnValue({
      activePass: null,
    });

    render(<UserAvatarMenu />);

    fireEvent.mouseEnter(screen.getByRole("link", { name: "avatar" }).parentElement!);

    expect(screen.getByText(/^未订阅$/)).toBeInTheDocument();
  });

  it("renders without a React Router context", () => {
    useSession.mockReturnValue({
      session: {
        user: { name: "海盐小猫", avatarUrl: "https://example.com/avatar.png" },
        currentSubscription: { code: "launch" },
      },
      signOut: vi.fn(),
    });
    useOpenClaw.mockReturnValue({
      activePass: null,
    });

    render(<UserAvatarMenu />);

    expect(screen.getByRole("link", { name: "avatar" })).toHaveAttribute("href", "/account");
    expect(screen.getByRole("button", { name: "打开用户菜单" })).toBeInTheDocument();
  });
});
