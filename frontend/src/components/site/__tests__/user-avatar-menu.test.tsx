import type { HTMLAttributes, ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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

vi.mock("@/contexts/agent-context", () => ({
  useOpenClaw: () => useOpenClaw(),
}));

vi.mock("@/i18n/t", () => ({
  useT: () => (value: string) => value,
}));

vi.mock("@/lib/avatar-image", () => ({
  avatarImageUrl: () => "https://example.com/avatar.png",
}));

vi.mock("@/lib/region", () => ({
  isGlobal: true,
}));

const stubLocation = (hostname: string) => {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      ...window.location,
      hostname,
      host: hostname,
      origin: `http://${hostname}`,
      protocol: "http:",
    },
  });
};

afterEach(() => {
  cleanup();
  useSession.mockReset();
  useOpenClaw.mockReset();
  delete (window as Window & { show?: unknown }).show;
  stubLocation("localhost");
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

  it("links the shared account menu to the agents workbench on local hosts", () => {
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

    fireEvent.mouseEnter(screen.getByRole("link", { name: "avatar" }).parentElement!);

    expect(screen.getByRole("link", { name: "工作台" })).toHaveAttribute("href", "/agents/workbench");
  });

  it("hides the agents workbench menu item on public hosts by default", () => {
    stubLocation("lightclaw.tech");
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

    fireEvent.mouseEnter(screen.getByRole("link", { name: "avatar" }).parentElement!);

    expect(screen.queryByRole("link", { name: "工作台" })).not.toBeInTheDocument();
  });

  it("reveals the agents workbench menu item after show() on public hosts", () => {
    stubLocation("lightclaw.tech");
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

    fireEvent.mouseEnter(screen.getByRole("link", { name: "avatar" }).parentElement!);
    expect(screen.queryByRole("link", { name: "工作台" })).not.toBeInTheDocument();

    let shown: unknown;
    act(() => {
      shown = (window as Window & { show?: () => boolean }).show?.();
    });
    expect(shown).toBe(true);

    expect(screen.getByRole("link", { name: "工作台" })).toHaveAttribute("href", "/agents/workbench");
  });

  it("keeps the product feedback menu item hidden until show() reveals it", () => {
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

    fireEvent.mouseEnter(screen.getByRole("link", { name: "avatar" }).parentElement!);
    expect(screen.queryByRole("link", { name: "产品反馈" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "用户反馈" })).not.toBeInTheDocument();

    act(() => {
      (window as Window & { show?: () => boolean }).show?.();
    });

    expect(screen.getByRole("link", { name: "产品反馈" })).toHaveAttribute("href", "/support");
  });

  it("keeps My creations hidden until show() reveals it", () => {
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

    fireEvent.mouseEnter(screen.getByRole("link", { name: "avatar" }).parentElement!);
    expect(screen.queryByRole("link", { name: "我的作品" })).not.toBeInTheDocument();

    act(() => {
      (window as Window & { show?: () => boolean }).show?.();
    });

    expect(screen.getByRole("link", { name: "我的作品" })).toHaveAttribute("href", "/agents/websites");
  });
});
