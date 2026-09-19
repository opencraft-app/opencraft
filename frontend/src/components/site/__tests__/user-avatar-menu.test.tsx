import type { HTMLAttributes, ReactNode } from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UserAvatarMenu } from "@/components/site/user-avatar-menu";
import { CONSOLE_SHOW_EVENT } from "@/lib/console-show-event";
import { AppNavigationProvider, type AppNavigationValue } from "@/lib/app-navigation";

vi.mock("framer-motion", () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => children,
  motion: {
    div: ({ children, ...props }: HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  },
}));

const useSession = vi.fn();
const useOpenClaw = vi.fn();
const sidebarPlans = { listMyPasses: () => Promise.resolve([]) };
let mockIsGlobal = true;

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

vi.mock("@/components/site/language-switcher", () => ({
  InternationalLanguageMenu: ({ id }: { id: string }) => (
    <div id={id} aria-label="International site languages">
      <button type="button">English</button>
      <button type="button">简体中文</button>
    </div>
  ),
}));

vi.mock("@/lib/region", () => ({
  DEFAULT_LOCALE: "en-US",
  get isCN() { return !mockIsGlobal; },
  get isGlobal() {
    return mockIsGlobal;
  },
}));

// Existing header tests stay provider-free; these stubs serve only the sidebar child.
vi.mock("@/contexts/runtime-config-context", () => ({ usePaidBillingEnabled: () => false }));
vi.mock("@/contexts/repository-context", () => ({ useRepositories: () => ({ plans: sidebarPlans }) }));

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

const createNavigationValue = (navigate = vi.fn()): AppNavigationValue => ({
  Link: ({ to, ...props }) => <a href={to} {...props} />,
  navigate,
  pathname: "/agents",
  search: "",
  setSearchParams: vi.fn(),
});

afterEach(() => {
  cleanup();
  useSession.mockReset();
  useOpenClaw.mockReset();
  mockIsGlobal = true;
  delete (window as Window & { show?: unknown }).show;
  stubLocation("localhost");
});

describe("UserAvatarMenu", () => {
  const readGeneratedDictionary = (locale: string): Record<string, string> =>
    JSON.parse(
      readFileSync(join(process.cwd(), `src/i18n/generated/${locale}.json`), "utf8"),
    ) as Record<string, string>;

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

  it("opens the sidebar account menu by click in a Portal and keeps identity and account navigation", async () => {
    useSession.mockReturnValue({
      session: {
        user: {
          name: "海盐小猫",
          email: "cat@example.com",
          avatarUrl: "https://example.com/avatar.png",
        },
        currentSubscription: { code: "launch" },
      },
      signOut: vi.fn(),
    });
    useOpenClaw.mockReturnValue({
      activePass: null,
    });

    render(<UserAvatarMenu variant="sidebar" />);

    const trigger = screen.getByRole("button", { name: "打开用户菜单" });
    expect(trigger).toHaveClass("lv-agent-account-trigger");
    expect(trigger).toHaveTextContent("海盐小猫");
    expect(trigger).toHaveTextContent("套餐：launch");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("link", { name: "avatar" })).not.toBeInTheDocument();

    fireEvent.mouseEnter(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(trigger);
    const menu = screen.getByRole("dialog", { name: "账号管理" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(trigger.parentElement).not.toContainElement(menu);
    expect(menu).toHaveTextContent("cat@example.com");
    expect(screen.getByRole("link", { name: "账号管理" })).toHaveAttribute("href", "/account");

    fireEvent.mouseLeave(trigger.parentElement!);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    await userEvent.keyboard("{Escape}");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });

  it.each([
    ["domestic", false],
    ["international", true],
  ])("hides the companion link only in the %s sidebar menu", async (_site, global) => {
    mockIsGlobal = global;
    useSession.mockReturnValue({
      session: {
        user: { name: "海盐小猫", avatarUrl: "https://example.com/avatar.png" },
        currentSubscription: { code: "launch" },
      },
      signOut: vi.fn(),
    });
    useOpenClaw.mockReturnValue({ activePass: null });

    const { unmount } = render(<UserAvatarMenu variant="sidebar" />);
    await userEvent.click(screen.getByRole("button", { name: "打开用户菜单" }));

    expect(screen.queryByRole("link", { name: "我的智能体伙伴" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "账号管理" })).toHaveAttribute("href", "/account");

    unmount();
    render(<UserAvatarMenu />);
    fireEvent.mouseEnter(screen.getByRole("link", { name: "avatar" }).parentElement!);

    expect(screen.getByRole("link", { name: "我的智能体伙伴" })).toHaveAttribute("href", "/agents");
  });

  it("opens the international language picker from the click-based account menu", async () => {
    useSession.mockReturnValue({
      session: {
        user: {
          name: "海盐小猫",
          email: "cat@example.com",
          avatarUrl: "https://example.com/avatar.png",
        },
        currentSubscription: { code: "launch" },
      },
      signOut: vi.fn(),
    });
    useOpenClaw.mockReturnValue({ activePass: null });

    render(<UserAvatarMenu showLanguageSwitcher variant="sidebar" />);
    const accountTrigger = screen.getByRole("button", { name: "打开用户菜单" });
    await userEvent.click(accountTrigger);

    const languageTrigger = screen.getByRole("button", { name: "语言" });
    expect(languageTrigger).toHaveAttribute("aria-haspopup", "dialog");
    expect(screen.queryByLabelText("International site languages")).not.toBeInTheDocument();

    await userEvent.click(languageTrigger);

    expect(screen.getByLabelText("International site languages")).toBeVisible();
    expect(document.querySelector('[data-lv-agent-language-menu="true"]')).toBeInTheDocument();

    fireEvent.mouseLeave(accountTrigger.parentElement!);
    expect(accountTrigger).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps the header account menu open while moving into the language picker", () => {
    useSession.mockReturnValue({
      session: {
        user: {
          name: "海盐小猫",
          email: "cat@example.com",
          avatarUrl: "https://example.com/avatar.png",
        },
        currentSubscription: { code: "launch" },
      },
      signOut: vi.fn(),
    });
    useOpenClaw.mockReturnValue({ activePass: null });

    render(<UserAvatarMenu showLanguageSwitcher />);
    const accountTrigger = screen.getByRole("button", { name: "打开用户菜单" });
    fireEvent.mouseEnter(screen.getByRole("link", { name: "avatar" }).parentElement!);
    fireEvent.mouseEnter(screen.getByRole("button", { name: "语言" }));

    fireEvent.mouseLeave(document.querySelector(".lw-user-avatar-menu")!);

    expect(accountTrigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByLabelText("International site languages")).toBeVisible();
  });

  it("does not add a language picker to the domestic account menu", () => {
    mockIsGlobal = false;
    useSession.mockReturnValue({
      session: {
        user: { name: "海盐小猫", avatarUrl: "https://example.com/avatar.png" },
        currentSubscription: { code: "launch" },
      },
      signOut: vi.fn(),
    });
    useOpenClaw.mockReturnValue({ activePass: null });

    render(<UserAvatarMenu showLanguageSwitcher variant="sidebar" />);
    fireEvent.click(screen.getByRole("button", { name: "打开用户菜单" }));

    expect(screen.queryByRole("button", { name: "语言" })).not.toBeInTheDocument();
  });

  it("returns to the public home after signing out from the console menu", () => {
    const signOut = vi.fn();
    const navigate = vi.fn();
    useSession.mockReturnValue({
      session: {
        user: { name: "海盐小猫", avatarUrl: "https://example.com/avatar.png" },
        currentSubscription: { code: "launch" },
      },
      signOut,
    });
    useOpenClaw.mockReturnValue({
      activePass: null,
    });

    render(
      <AppNavigationProvider value={createNavigationValue(navigate)}>
        <UserAvatarMenu />
      </AppNavigationProvider>,
    );

    fireEvent.mouseEnter(screen.getByRole("link", { name: "avatar" }).parentElement!);
    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));

    expect(navigate).toHaveBeenCalledWith("/", { replace: true });
    expect(signOut).toHaveBeenCalledTimes(1);
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

    const onConsoleShow = vi.fn();
    window.addEventListener(CONSOLE_SHOW_EVENT, onConsoleShow);
    let shown: unknown;
    act(() => {
      shown = (window as Window & { show?: () => boolean }).show?.();
    });
    expect(shown).toBe(true);
    expect(onConsoleShow).toHaveBeenCalledTimes(1);
    window.removeEventListener(CONSOLE_SHOW_EVENT, onConsoleShow);

    expect(screen.getByRole("link", { name: "工作台" })).toHaveAttribute("href", "/agents/workbench");
  });

  it("shows domestic feedback from the header click trigger without revealing other hidden entries", async () => {
    mockIsGlobal = false;
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

    const trigger = screen.getByRole("button", { name: "打开用户菜单" });
    // Mobile activation has no preceding mouseenter. Desktop hover opening
    // remains covered separately and is unchanged by the feedback item.
    fireEvent.click(trigger);
    expect(screen.queryByRole("link", { name: "产品反馈" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "用户反馈" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "工作台" })).not.toBeInTheDocument();
    const feedbackLink = screen.getByRole("link", { name: "建议反馈" });
    expect(feedbackLink).toHaveAttribute("href", "https://wj.qq.com/s2/27184784/6d06/");
    expect(feedbackLink).toHaveAttribute("target", "_blank");
    expect(feedbackLink).toHaveAttribute("rel", "noopener noreferrer");
    await userEvent.click(feedbackLink);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(trigger);
    act(() => {
      (window as Window & { show?: () => boolean }).show?.();
    });
    expect(screen.getAllByRole("link", { name: "建议反馈" })).toHaveLength(1);
    expect(screen.getByRole("link", { name: "工作台" })).toBeInTheDocument();
  });

  it("removes the product feedback menu item on the international site", () => {
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
    expect(screen.queryByRole("link", { name: "建议反馈" })).not.toBeInTheDocument();
    act(() => {
      (window as Window & { show?: () => boolean }).show?.();
    });

    expect(screen.queryByRole("link", { name: "建议反馈" })).not.toBeInTheDocument();
  });

  it("keeps the companion and account entries first while removing My Workbench", () => {
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

    const companionLink = screen.getByRole("link", { name: "我的智能体伙伴" });
    const accountLink = screen.getByRole("link", { name: "账号管理" });
    const workbenchLink = screen.getByRole("link", { name: "工作台" });

    expect(companionLink).toHaveAttribute("href", "/agents");
    expect(accountLink).toHaveAttribute("href", "/account");
    expect(companionLink.compareDocumentPosition(accountLink) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(accountLink.compareDocumentPosition(workbenchLink) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole("link", { name: "我的工作台" })).not.toBeInTheDocument();
  });

  it("uses natural English labels for the companion and account entries", () => {
    const keys = readGeneratedDictionary("zh-to-key");
    const english = readGeneratedDictionary("en-US");
    const companionKey = keys["我的智能体伙伴"];
    const accountKey = keys["账号管理"];

    expect(companionKey).toBeDefined();
    expect(accountKey).toBeDefined();
    expect(english[companionKey!]).toBe("My AI Companion");
    expect(english[accountKey!]).toBe("Account Settings");
  });

  it("uses a natural English label for the language entry", () => {
    const keys = readGeneratedDictionary("zh-to-key");
    const english = readGeneratedDictionary("en-US");
    const languageKey = keys["语言"];

    expect(languageKey).toBeDefined();
    expect(english[languageKey!]).toBe("Language");
  });
});
