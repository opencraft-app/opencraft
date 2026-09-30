import type { HTMLAttributes, ReactNode } from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UserAvatarMenu } from "@/components/site/user-avatar-menu";
import {
  CONSOLE_SHOW_EVENT,
  CONSOLE_SHOW_STORAGE_KEY,
  setConsoleShowEnabled,
} from "@/lib/console-show-event";
import { AppNavigationProvider, type AppNavigationValue } from "@/lib/app-navigation";

vi.mock("framer-motion", () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => children,
  motion: {
    div: ({ children, ...props }: HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  },
}));

const useSession = vi.fn();
const useOpenClaw = vi.fn();
let mockIsGlobal = true;
let mockLanguage = "zh-CN";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ i18n: { language: mockLanguage } }),
}));

vi.mock("@/contexts/session-context", () => ({
  useSession: () => useSession(),
}));

vi.mock("@/contexts/agent-context", () => ({
  useOpenClaw: () => useOpenClaw(),
}));

vi.mock("@/i18n/t", () => ({
  // 组件里用它按 locale 格式化日期（Intl），mock 固定成 zh-CN
  useCurrentLocale: () => "zh-CN",
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
  get isGlobal() {
    return mockIsGlobal;
  },
  get DEFAULT_LOCALE() {
    return "zh-CN";
  },
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

const createNavigationValue = (navigate = vi.fn()): AppNavigationValue => ({
  Link: ({ to, ...props }) => <a href={to} {...props} />,
  navigate,
  pathname: "/agents",
  search: "",
  setSearchParams: vi.fn(),
});

beforeEach(() => {
  setConsoleShowEnabled(false);
  window.localStorage.removeItem(CONSOLE_SHOW_STORAGE_KEY);
});

afterEach(() => {
  cleanup();
  useSession.mockReset();
  useOpenClaw.mockReset();
  mockIsGlobal = true;
  mockLanguage = "zh-CN";
  delete (window as Window & { show?: unknown }).show;
  delete (window as Window & { __LIGHTVELA_CONSOLE_SHOW_CONTROLLER__?: unknown })
    .__LIGHTVELA_CONSOLE_SHOW_CONTROLLER__;
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

  it("opens the sidebar account menu on hover and preserves identity and account navigation", () => {
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
    expect(trigger.closest(".lv-agent-account-menu")).toBeInTheDocument();
    expect(trigger).toHaveClass("lv-agent-account-trigger");
    const styles = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");
    expect(styles).toMatch(/\.lv-agent-account-trigger\s*\{[\s\S]*?width:\s*100%\s*;/);
    expect(trigger).toHaveTextContent("海盐小猫");
    expect(trigger).toHaveTextContent("套餐：launch");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("link", { name: "avatar" })).not.toBeInTheDocument();

    fireEvent.mouseEnter(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("dialog", { name: "账号管理" })).toBeVisible();

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("dialog", { name: "账号管理" })).toHaveClass(
      "lv-sidebar-user-menu",
      "w-72",
    );
    expect(screen.getByRole("link", { name: "账号" })).toHaveAttribute("href", "/account");
    expect(screen.getByRole("link", { name: "套餐与费用" })).toHaveAttribute("href", "/account/billing");

    fireEvent.mouseLeave(trigger.parentElement!);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });

  it.each([
    ["domestic", false],
    ["international", true],
  ])("hides the companion link only in the %s sidebar menu", (_site, global) => {
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
    fireEvent.click(screen.getByRole("button", { name: "打开用户菜单" }));

    expect(screen.queryByRole("link", { name: "我的智能体" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "账号" })).toHaveAttribute("href", "/account");
    expect(screen.getByRole("link", { name: "套餐与费用" })).toHaveAttribute("href", "/account/billing");

    unmount();
    render(<UserAvatarMenu />);
    fireEvent.mouseEnter(screen.getByRole("link", { name: "avatar" }).parentElement!);

    expect(screen.getByRole("link", { name: "我的智能体" })).toHaveAttribute("href", "/agents");
  });

  it("places the Model link before Plans & billing for ai bundles", () => {
    useSession.mockReturnValue({
      session: {
        user: { name: "海盐小猫", avatarUrl: "https://example.com/avatar.png" },
        currentSubscription: null,
      },
      signOut: vi.fn(),
    });
    useOpenClaw.mockReturnValue({
      activePass: {
        bundle_id: "bundle_future_ai_01",
        bundle_type: "ai",
        bundle_name: "Launch AI",
      },
    });

    render(
      <AppNavigationProvider value={{ ...createNavigationValue(), search: "?bot=bot%2Fsales+east" }}>
        <UserAvatarMenu variant="sidebar" />
      </AppNavigationProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "打开用户菜单" }));

    const billingLink = screen.getByRole("link", { name: "套餐与费用" });
    const modelLink = screen.getByRole("link", { name: "模型" });
    expect(modelLink).toHaveAttribute("href", "/agents/models?bot=bot%2Fsales+east");
    expect(modelLink.compareDocumentPosition(billingLink) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("keeps Model out of the account menu for standard plans", () => {
    useSession.mockReturnValue({
      session: {
        user: { name: "海盐小猫", avatarUrl: "https://example.com/avatar.png" },
        currentSubscription: null,
      },
      signOut: vi.fn(),
    });
    useOpenClaw.mockReturnValue({
      activePass: {
        bundle_id: "bundle_launch_01",
        bundle_type: "general",
        bundle_name: "Launch",
      },
    });

    render(<UserAvatarMenu variant="sidebar" />);
    fireEvent.click(screen.getByRole("button", { name: "打开用户菜单" }));

    expect(screen.queryByRole("link", { name: "模型" })).not.toBeInTheDocument();
  });

  it("uses the plural Models label in the English sidebar menu", () => {
    mockLanguage = "en-US";
    useSession.mockReturnValue({
      session: {
        user: { name: "Sea Salt Cat", avatarUrl: "https://example.com/avatar.png" },
        currentSubscription: null,
      },
      signOut: vi.fn(),
    });
    useOpenClaw.mockReturnValue({
      activePass: {
        bundle_id: "bundle_launch_ai_01",
        bundle_type: "ai",
        bundle_name: "Launch AI",
      },
    });

    render(<UserAvatarMenu variant="sidebar" />);
    fireEvent.click(screen.getByRole("button", { name: "打开用户菜单" }));

    expect(screen.getByRole("link", { name: "Models" })).toHaveAttribute(
      "href",
      "/agents/models",
    );
    expect(screen.queryByRole("link", { name: "Model" })).not.toBeInTheDocument();
  });

  it("does not expose the AI-plan Model entry in the public header menu", () => {
    useSession.mockReturnValue({
      session: {
        user: { name: "海盐小猫", avatarUrl: "https://example.com/avatar.png" },
        currentSubscription: null,
      },
      signOut: vi.fn(),
    });
    useOpenClaw.mockReturnValue({
      activePass: {
        bundle_id: "bundle_launch_ai_01",
        bundle_type: "ai",
        bundle_name: "Launch AI",
      },
    });

    render(<UserAvatarMenu />);
    fireEvent.mouseEnter(screen.getByRole("link", { name: "avatar" }).parentElement!);

    expect(screen.queryByRole("link", { name: "模型" })).not.toBeInTheDocument();
  });

  it("opens the international language picker beside the account menu", () => {
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
    fireEvent.click(accountTrigger);

    const languageTrigger = screen.getByRole("button", { name: "语言" });
    expect(languageTrigger).toHaveAttribute("aria-haspopup", "dialog");
    expect(screen.queryByLabelText("International site languages")).not.toBeInTheDocument();

    fireEvent.click(languageTrigger);

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

  it("reveals the agents workbench menu item after show() on public hosts", async () => {
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

    const view = render(<UserAvatarMenu />);

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
    expect(screen.getByRole("link", { name: "工作台" })).toHaveAttribute("href", "/agents/workbench");

    view.unmount();
    render(<UserAvatarMenu />);
    fireEvent.mouseEnter(screen.getByRole("link", { name: "avatar" }).parentElement!);
    expect(await screen.findByRole("link", { name: "工作台" })).toBeInTheDocument();

    act(() => {
      shown = (window as Window & { show?: () => boolean }).show?.();
    });
    expect(shown).toBe(false);
    expect(onConsoleShow).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("link", { name: "工作台" })).not.toBeInTheDocument();
    window.removeEventListener(CONSOLE_SHOW_EVENT, onConsoleShow);
  });

  it("keeps one domestic product feedback entry before and after show()", () => {
    mockIsGlobal = false;
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
    expect(screen.getAllByRole("link", { name: "产品反馈" })).toHaveLength(1);
    expect(screen.queryByRole("link", { name: "用户反馈" })).not.toBeInTheDocument();

    act(() => {
      (window as Window & { show?: () => boolean }).show?.();
    });

    const feedbackLink = screen.getByRole("link", { name: "产品反馈" });
    expect(feedbackLink).toHaveAttribute("href", "/support");
    expect(feedbackLink).not.toHaveAttribute("target");
    expect(document.querySelectorAll('a[href="/support"]')).toHaveLength(1);
    expect(document.querySelector('a[href*="wj.qq.com"]')).toBeNull();
    act(() => {
      (window as Window & { show?: () => boolean }).show?.();
    });
    expect(screen.getAllByRole("link", { name: "产品反馈" })).toHaveLength(1);
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
    act(() => {
      (window as Window & { show?: () => boolean }).show?.();
    });

    expect(screen.queryByRole("link", { name: "产品反馈" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "用户反馈" })).toHaveAttribute("href", "/support");
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

    const companionLink = screen.getByRole("link", { name: "我的智能体" });
    const accountLink = screen.getByRole("link", { name: "账号" });
    const workbenchLink = screen.getByRole("link", { name: "工作台" });

    expect(companionLink).toHaveAttribute("href", "/agents");
    expect(accountLink).toHaveAttribute("href", "/account");
    expect(companionLink.compareDocumentPosition(accountLink) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(accountLink.compareDocumentPosition(workbenchLink) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole("link", { name: "我的工作台" })).not.toBeInTheDocument();
  });

  it.each([
    ["en-US", "My Agents", "Back to Agents"],
    ["zh-CN", "我的智能体", "返回智能体"],
    ["zh-Hant", "我的智能體", "返回智能體"],
    ["ja-JP", "マイエージェント", "エージェントに戻る"],
    ["ko-KR", "내 에이전트", "에이전트로 돌아가기"],
    ["es", "Mis agentes", "Volver a Agentes"],
    ["id-ID", "Agen Saya", "Kembali ke Agen"],
  ])("distinguishes the Agents menu and return action in %s", (locale, menu, back) => {
    const keys = readGeneratedDictionary("zh-to-key");
    const dictionary = readGeneratedDictionary(locale);
    expect(dictionary[keys["我的智能体"]!]).toBe(menu);
    expect(dictionary[keys["返回智能体"]!]).toBe(back);
  });

  it("uses natural English labels for the agents and account entries", () => {
    const keys = readGeneratedDictionary("zh-to-key");
    const english = readGeneratedDictionary("en-US");
    const companionKey = keys["我的智能体"];
    const accountKey = keys["账号"];

    expect(companionKey).toBeDefined();
    expect(accountKey).toBeDefined();
    expect(english[companionKey!]).toBe("My Agents");
    expect(english[accountKey!]).toBe("Account");
  });

  it("uses a natural English label for the language entry", () => {
    const keys = readGeneratedDictionary("zh-to-key");
    const english = readGeneratedDictionary("en-US");
    const languageKey = keys["语言"];

    expect(languageKey).toBeDefined();
    expect(english[languageKey!]).toBe("Language");
  });
});
