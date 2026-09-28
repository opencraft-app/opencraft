import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawBot } from "@/contexts/agent-context";
import { AgentFleetOverview, type FleetOverviewProps } from "@/pages/marketing/agent-fleet-overview";

const api = vi.hoisted(() => ({ renameBot: vi.fn(), retryBot: vi.fn(), deleteBot: vi.fn(), refreshBots: vi.fn(), execDebugCommand: vi.fn(), botsError: false, botsLoading: false }));
vi.mock("@/contexts/agent-context", () => ({ useOpenClaw: () => ({ ...api, activePass: null }) }));
vi.mock("@/contexts/repository-context", () => ({ useRepositories: () => ({ bots: api }) }));
vi.mock("@/i18n/t", () => ({ useT: () => (s: string, vars?: Record<string, string>) => s.replace(/{{(\w+)}}/g, (_, key: string) => vars?.[key] ?? key), useCurrentLocale: () => "zh-CN" }));
vi.mock("@/pages/marketing/agent-buddy-profile", () => ({ useBuddyProfile: ({ fallbackName }: { fallbackName: string }) => ({ profile: { name: fallbackName, description: "", shapeId: "circle", color: "#3d7df5" } }) }));
vi.mock("@/pages/marketing/agent-hero-stats", () => ({ useHeroStats: () => ({ credits: 4500 }) }));
vi.mock("@/pages/marketing/agent-fleet-stats", () => ({ useFleetAutomationCounts: () => ({}), sumBotAutomationCounts: () => null }));
vi.mock("@/pages/marketing/agent-overview-panel", () => ({ HeroBanner: () => <div>Account</div>, LatestNewsSection: () => <div>News</div> }));
const bot = (id: string, extra: Partial<OpenClawBot> = {}): OpenClawBot => ({ id, name: id, instanceId: "vm-1", profileId: id, isDefault: false, status: "running", personality: "", personalityEmoji: "", intro: "", createdAt: "", connectedChannels: [], installedSkills: [], ...extra });
let props: FleetOverviewProps;
beforeEach(() => { vi.clearAllMocks(); api.botsError = false; api.botsLoading = false; api.renameBot.mockResolvedValue({}); api.deleteBot.mockResolvedValue(undefined); api.refreshBots.mockResolvedValue(undefined); api.execDebugCommand.mockResolvedValue({ status: "SUCCESS", exitCode: 0, output: "__LV_META_OK__" }); props = { bots: [bot("alpha", { isDefault: true }), bot("bravo")], canCreate: true, createLimitMessage: "", onCreate: vi.fn(), onOpen: vi.fn(), onChanged: vi.fn() }; });
afterEach(cleanup);
const manage = (name: string) => fireEvent.click(screen.getByRole("button", { name: `管理 ${name}` }));

describe("multi Bot overview", () => {
  it("exposes both creation entries and opens the exact card's Bot", () => {
    render(<AgentFleetOverview {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "创建 Bot" }));
    expect(props.onCreate).toHaveBeenCalledWith();
    const card = screen.getByRole("heading", { name: "bravo" }).closest('.rounded-md')!;
    fireEvent.click(within(card as HTMLElement).getByRole("button", { name: "打开 Bot" }));
    expect(props.onOpen).toHaveBeenCalledWith("bravo");
    expect(screen.getByRole("button", { name: /再创建一个 Bot/ })).toBeEnabled();
  });
  it("copies the chosen Bot, never the active/default Bot", () => {
    render(<AgentFleetOverview {...props} />); manage("bravo");
    fireEvent.click(screen.getByRole("button", { name: "复制 Bot" }));
    expect(props.onCreate).toHaveBeenCalledWith("bravo");
  });
  it("renames only the dialog target and refreshes after success", async () => {
    render(<AgentFleetOverview {...props} />); manage("bravo"); fireEvent.click(screen.getByRole("button", { name: "重命名" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Bot 名称" }), { target: { value: "Research" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(api.renameBot).toHaveBeenCalledWith("bravo", "Research"));
    await waitFor(() => expect(props.onChanged).toHaveBeenCalledOnce());
    expect(api.execDebugCommand).toHaveBeenCalledWith("bravo", expect.stringContaining("HERMES_PROFILE_ROOT"), { timeoutMs: 30_000 });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("requires the exact selected name and preserves the card on delete failure", async () => {
    api.deleteBot.mockRejectedValue(new Error("Denied"));
    render(<AgentFleetOverview {...props} />); manage("bravo"); fireEvent.click(screen.getByRole("button", { name: "删除 Bot" }));
    const submit = screen.getByRole("button", { name: "确认删除" });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "bravo" } }); fireEvent.click(submit);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Denied"));
    expect(api.deleteBot).toHaveBeenCalledWith("bravo");
    expect(screen.getByRole("heading", { name: "bravo", hidden: true })).toBeInTheDocument();
  });
  it("blocks default Bot deletion while any sibling remains", () => {
    render(<AgentFleetOverview {...props} />); manage("alpha"); fireEvent.click(screen.getByRole("button", { name: "删除整个 Agent" }));
    expect(screen.getByText("请先删除其他 Bot，再删除主 Bot")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确认删除" })).toBeDisabled();
    expect(api.deleteBot).not.toHaveBeenCalled();
  });
  it("keeps creating/deleting cards visible and their actions disabled", () => {
    props.bots = [bot("creating", { status: "provisioning" }), bot("deleting", { status: "deleting" })];
    render(<AgentFleetOverview {...props} />);
    expect(screen.getByText("创建中")).toBeInTheDocument(); expect(screen.getByText("删除中")).toBeInTheDocument();
    screen.getAllByRole("button", { name: "打开 Bot" }).forEach((button) => expect(button).toBeDisabled());
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
    expect(screen.getByRole("alert")).toHaveTextContent("Bot 列表加载失败");
    expect(screen.queryByText("还没有 Bot，创建你的第一个助手")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "创建 Bot" })).toBeDisabled();
  });
});
