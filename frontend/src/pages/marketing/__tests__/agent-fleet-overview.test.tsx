import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawBot } from "@/contexts/agent-context";
import { AgentFleetOverview, type FleetOverviewProps } from "@/pages/marketing/agent-fleet-overview";

const api = vi.hoisted(() => ({ renameBot: vi.fn(), deleteBot: vi.fn(), refreshBots: vi.fn(), execDebugCommand: vi.fn(), renderHero: vi.fn(), botsError: false, botsLoading: false }));
const referrals = vi.hoisted(() => ({ enabled: false, getReferralStats: vi.fn() }));
vi.mock("@/contexts/runtime-config-context", () => ({ useReferralEnabled: () => referrals.enabled }));
vi.mock("@/contexts/agent-context", () => ({ useOpenClaw: () => ({ ...api, activePass: null }) }));
vi.mock("@/contexts/repository-context", () => ({ useRepositories: () => ({ bots: api, auth: referrals }) }));
vi.mock("@/i18n/t", () => ({ t: (s: string) => s, useT: () => (s: string, vars?: Record<string, string>) => s.replace(/{{(\w+)}}/g, (_, key: string) => vars?.[key] ?? key), useCurrentLocale: () => "zh-CN" }));
vi.mock("@/pages/marketing/agent-buddy-profile", () => ({ useBuddyProfile: ({ fallbackName }: { fallbackName: string }) => ({ profile: { name: fallbackName, description: "", shapeId: "circle", color: "#3d7df5" }, soulExists: true, loading: false }) }));
vi.mock("@/pages/marketing/agent-hero-stats", () => ({ useHeroStats: () => ({ credits: 4500 }) }));
vi.mock("@/pages/marketing/agent-overview-panel", async (importOriginal) => ({ ...await importOriginal<typeof import("@/pages/marketing/agent-overview-panel")>(), HeroBanner: (props: unknown) => { api.renderHero(props); return <div>Account</div>; }, LatestNewsSection: () => <div>News</div> }));
const bot = (id: string, extra: Partial<OpenClawBot> = {}): OpenClawBot => ({ id, name: id, instanceId: "vm-1", profileId: id, isDefault: false, status: "running", personality: "", personalityEmoji: "", intro: "", createdAt: "", connectedChannels: [], installedSkills: [], ...extra });
let props: FleetOverviewProps;
beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} }); vi.clearAllMocks(); api.botsError = false; api.botsLoading = false; api.renameBot.mockResolvedValue({}); api.deleteBot.mockResolvedValue(undefined); api.refreshBots.mockResolvedValue(undefined); api.execDebugCommand.mockImplementation(async (_id: string, command: string) => ({ status: "SUCCESS", exitCode: 0, output: command.includes("ContentBase64:") ? "Exists: no" : "__LV_META_OK__" })); props = { heroStats: { servedDays: 3, expiresAt: null, credits: 4500, automations: 1, sites: 0 }, bots: [bot("alpha", { isDefault: true }), bot("bravo")], canCreate: true, createLimitMessage: "", onCreate: vi.fn(), onChanged: vi.fn(), onDelete: vi.fn(), getAvatarForBot: (id) => `/avatars/${id}.webp` }; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); referrals.enabled = false; referrals.getReferralStats.mockReset(); });
const manage = (name: string) => fireEvent.click(screen.getByRole("button", { name: `管理 ${name}` }));

describe("multi Bot overview", () => {
  it.each([0, 5, undefined])("loads the account's successful invitation count %s", async (count) => {
    referrals.enabled = true;
    referrals.getReferralStats.mockResolvedValue({ successfulReferrals: count });
    render(<AgentFleetOverview {...props} />);
    expect(api.renderHero).toHaveBeenLastCalledWith({ stats: props.heroStats, botCount: 2, invitedFriends: null });
    await waitFor(() => expect(api.renderHero).toHaveBeenLastCalledWith({ stats: props.heroStats, botCount: 2, invitedFriends: count ?? 0 }));
    expect(referrals.getReferralStats).toHaveBeenCalledOnce();
  });
  it("passes missing invitation data to the banner's zero fallback when the request fails", async () => {
    referrals.enabled = true;
    referrals.getReferralStats.mockRejectedValue(new Error("Unavailable"));
    render(<AgentFleetOverview {...props} />);
    await waitFor(() => expect(referrals.getReferralStats).toHaveBeenCalledOnce());
    expect(api.renderHero).toHaveBeenLastCalledWith({ stats: props.heroStats, botCount: 2, invitedFriends: null });
  });
  it("follows the account referral feature switch", () => {
    render(<AgentFleetOverview {...props} />);
    expect(referrals.getReferralStats).not.toHaveBeenCalled();
    expect(api.renderHero).toHaveBeenLastCalledWith({ stats: props.heroStats, botCount: 2, invitedFriends: undefined });
  });
  it("keeps header creation and card editing alongside the management menu", () => {
    render(<AgentFleetOverview {...props} />);
    expect(api.renderHero).toHaveBeenLastCalledWith({ stats: props.heroStats, botCount: 2 });
    expect(screen.getByRole("heading", { name: "定时任务推荐" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "查看全部" })).toHaveAttribute("href", "/agents/automations");
    expect(screen.getByRole("heading", { name: "bravo" }).closest('.border')?.querySelector('img')).toHaveAttribute("src", "/avatars/bravo.webp");
    fireEvent.click(screen.getByRole("button", { name: "创建 Bot" }));
    expect(props.onCreate).toHaveBeenCalledWith();
    const card = screen.getByRole("heading", { name: "bravo" }).closest('.border')!;
    expect(within(card as HTMLElement).getAllByRole("button")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "配置通道" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "打开 Bot" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /再创建一个 Bot/ })).not.toBeInTheDocument();
  });
  it("opens the original editor for the clicked card", () => {
    render(<AgentFleetOverview {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "修改资料: bravo" }));
    expect(screen.getByRole("dialog", { name: "编辑资料" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "名字" })).toHaveValue("bravo");
    expect(api.renameBot).not.toHaveBeenCalled();
  });
  it("marks only the currently selected Bot and follows selection changes", () => {
    const { rerender } = render(<AgentFleetOverview {...props} currentBotId="bravo" />);
    const card = (name: string) => screen.getByRole("heading", { name }).closest('.border') as HTMLElement;
    expect(within(card("bravo")).getByText("当前 Bot")).toBeInTheDocument();
    expect(within(card("alpha")).queryByText("当前 Bot")).not.toBeInTheDocument();
    rerender(<AgentFleetOverview {...props} currentBotId="alpha" />);
    expect(within(card("alpha")).getByText("当前 Bot")).toBeInTheDocument();
    expect(within(card("bravo")).queryByText("当前 Bot")).not.toBeInTheDocument();
  });
  it("enables a keyboard-accessible horizontal region only above three Bots", () => {
    props.bots = [bot("alpha"), bot("bravo"), bot("charlie")];
    const { rerender } = render(<AgentFleetOverview {...props} />);
    expect(screen.queryByRole("region", { name: "我的 Bots" })).not.toBeInTheDocument();
    rerender(<AgentFleetOverview {...props} bots={[...props.bots, bot("delta")]} />);
    const strip = screen.getByRole("region", { name: "我的 Bots" });
    expect(strip).toHaveAttribute("tabindex", "0");
    expect(screen.getByText("左右滑动查看更多 Bot")).toBeInTheDocument();
    Object.defineProperties(strip, { clientWidth: { value: 900 }, scrollWidth: { value: 1200 }, scrollLeft: { value: 0, writable: true } });
    const scrollTo = vi.fn();
    strip.scrollTo = scrollTo;
    fireEvent.scroll(strip);
    expect(screen.queryByRole("button", { name: "刷新 Bot 列表" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "上一页" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "下一页" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "第 1 页，共 2 页" })).toHaveAttribute("aria-current", "page");
    fireEvent.click(screen.getByRole("button", { name: "第 2 页，共 2 页" }));
    expect(scrollTo).toHaveBeenCalledWith({ left: 300, behavior: "auto" });
    strip.scrollLeft = 300;
    fireEvent.scroll(strip);
    expect(screen.getByRole("button", { name: "第 2 页，共 2 页" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "第 1 页，共 2 页" })).not.toHaveAttribute("aria-current");
    expect(within(strip).getAllByRole("heading")).toHaveLength(4);
    fireEvent.click(within(strip).getByRole("button", { name: "修改资料: delta" }));
    expect(screen.getByRole("textbox", { name: "名字" })).toHaveValue("delta");
  });
  it("orders the menu as edit profile, copy Bot, delete", () => {
    render(<AgentFleetOverview {...props} />); manage("bravo");
    expect(within(screen.getByRole("dialog")).getAllByRole("button").map((button) => button.textContent)).toEqual(["修改资料", "复制 Bot", "删除"]);
  });
  it("copies the chosen Bot, never the active/default Bot", () => {
    render(<AgentFleetOverview {...props} />); manage("bravo");
    fireEvent.click(screen.getByRole("button", { name: "复制 Bot" }));
    expect(props.onCreate).toHaveBeenCalledWith("bravo");
  });
  it("reuses the original profile editor and saves name, description and avatar only for its target", async () => {
    render(<AgentFleetOverview {...props} />); manage("bravo"); fireEvent.click(screen.getByRole("button", { name: "修改资料" }));
    expect(screen.getByRole("dialog", { name: "编辑资料" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "名字" })).toHaveValue("bravo");
    expect(screen.getByRole("button", { name: "圆形" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "换一批" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "六边形" }));
    fireEvent.change(screen.getByRole("textbox", { name: "名字" }), { target: { value: "Research" } });
    fireEvent.change(screen.getByRole("textbox", { name: /描述/ }), { target: { value: "Daily research" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(api.renameBot).not.toHaveBeenCalled();
    await waitFor(() => expect(props.onChanged).toHaveBeenCalledOnce());
    expect(api.execDebugCommand).toHaveBeenCalledWith("bravo", expect.stringContaining("HERMES_PROFILE_ROOT"), { timeoutMs: 60_000 });
    expect(api.execDebugCommand.mock.calls.every(([id]) => id === "bravo")).toBe(true);
    expect(api.execDebugCommand.mock.calls[0]![1]).toContain("ContentBase64");
    const command = api.execDebugCommand.mock.calls.find(([, command]) => command.includes("__LV_META_OK__"))![1] as string;
    const payload = JSON.parse(atob(command.match(/base64.b64decode\("([^"\n]+)"\)/)![1]!));
    expect(payload).toEqual({ display_name: "Research", description: "Daily research", description_auto: false, avatar: "hexagon:#3d7df5" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("delegates the selected Bot to the existing page delete dialog", () => {
    render(<AgentFleetOverview {...props} />); manage("bravo"); fireEvent.click(screen.getByRole("button", { name: "删除" }));
    expect(props.onDelete).toHaveBeenCalledWith(props.bots[1]);
    expect(api.deleteBot).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("keeps the original default Bot deletion restriction while siblings remain", () => {
    render(<AgentFleetOverview {...props} />); manage("alpha");
    expect(screen.getByRole("button", { name: "删除" })).toBeDisabled();
    expect(props.onDelete).not.toHaveBeenCalled();
  });
  it("keeps creating/deleting cards visible and their actions disabled", () => {
    props.bots = [bot("creating", { status: "provisioning" }), bot("deleting", { status: "deleting" })];
    render(<AgentFleetOverview {...props} />);
    expect(screen.getByText("创建中")).toBeInTheDocument(); expect(screen.getByText("删除中")).toBeInTheDocument();
    screen.getAllByRole("button", { name: /^(管理 |修改资料: )/ }).forEach((button) => expect(button).toBeDisabled());
  });
  it("retains quota explanation and prevents creation/copy", () => {
    props.canCreate = false; props.createLimitMessage = "Quota reached";
    render(<AgentFleetOverview {...props} />);
    expect(screen.getByRole("button", { name: "创建 Bot" })).toBeDisabled();
    expect(screen.getByText("Quota reached")).toBeInTheDocument();
    manage("bravo"); expect(screen.getByRole("button", { name: "复制 Bot" })).toBeDisabled();
  });
  it("shows a failed list read instead of a false empty account", () => {
    api.botsError = true; props.bots = [];
    render(<AgentFleetOverview {...props} />);
    expect(api.renderHero).toHaveBeenLastCalledWith({ stats: props.heroStats, botCount: null });
    expect(screen.getByRole("alert")).toHaveTextContent("Bot 列表加载失败");
    expect(screen.queryByText("还没有 Bot，创建你的第一个助手")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "创建 Bot" })).toBeDisabled();
  });
});
