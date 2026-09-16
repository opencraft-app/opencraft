import { useState } from "react";
import { act, cleanup, configure, fireEvent, getConfig, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentWebsitePanel } from "@/pages/marketing/agent-website-panel";
import { WebsiteShareDialog, type ShareDialogSite } from "@/pages/marketing/agent-website-share-dialog";

vi.mock("@/i18n/t", () => ({ useT: () => (text: string) => text }));
vi.mock("@/lib/auth-api-base", () => ({ resolveConfiguredAuthApiBaseUrl: () => "https://website.test" }));
vi.mock("@/repositories/http-repositories", () => ({ readStoredAuthToken: () => "fixture-token" }));
vi.mock("@/lib/app-navigation", () => ({ AppLink: ({ children, to, ...props }: React.PropsWithChildren<{ to: string }>) => <a href={to} {...props}>{children}</a> }));

const alpha = { Id: 1, CreatedTime: "2026-01-01T00:00:00Z", UpdatedTime: "2026-01-01T00:00:00Z", UserID: "owner", SiteID: "site-A", PassID: "pass", BundleID: "bundle", Name: "Alpha", Status: "active", CloudPath: "/A", PublicURL: "https://alpha.example.test", DeletedTime: null, AccessMode: "owner_only" as const, ShareExpiresAt: null };
const beta = { ...alpha, Id: 2, SiteID: "site-B", Name: "Beta", PublicURL: "https://beta.example.test" };
const capability = { max_sites: 10, used_sites: 2, monthly_traffic_bytes: 10000, used_traffic_bytes: 10, storage_bytes: 10000, used_storage_bytes: 10, max_artifact_size: 1000, max_files: 100 };
const expiry = "2026-10-01T12:00:00+08:00";
const json = (data: unknown, status = 200) => new Response(JSON.stringify({ code: status === 200 ? "OK" : "ERROR", data, message: status === 200 ? "success" : "fixture request failure" }), { status, headers: { "Content-Type": "application/json" } });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const originalExecCommand = Object.getOwnPropertyDescriptor(document, "execCommand");
const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
const originalAsyncWrapper = getConfig().asyncWrapper;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  // RTL's default microtask drain advances Jest timers only. Keep this fixture's
  // Vitest polling clock deterministic while flushing React after user events.
  configure({ asyncWrapper: async (callback) => { let result; await act(async () => { result = await callback(); }); return result; } });
});
afterEach(() => {
  cleanup();
  configure({ asyncWrapper: originalAsyncWrapper });
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalExecCommand) Object.defineProperty(document, "execCommand", originalExecCommand);
  else Reflect.deleteProperty(document, "execCommand");
  if (originalScrollIntoView) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScrollIntoView);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});
const setupUser = () => userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
const flush = async () => { await act(async () => {}); };

function panelApi({ deletion, operation }: { deletion?: () => Promise<Response>; operation?: () => Promise<Response> } = {}) {
  let sites = [alpha, beta];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (init?.method === "DELETE") return deletion ? deletion() : json({ operation_id: "op-A" });
    if (path === "/v1/websites/site-A/operations/op-A") return operation ? operation() : json({ status: "running" });
    if (path === "/v1/websites/capability") return json(capability);
    if (path === "/v1/websites") return json({ sites, total: sites.length });
    throw new Error(`Unexpected fixture request: ${init?.method ?? "GET"} ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, setSites: (next: typeof sites) => { sites = next; }, operations: () => fetchMock.mock.calls.filter(([url]) => String(url).includes("/operations/")), siteReads: () => fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith("/v1/websites") && !init?.method) };
}
const row = (name: string) => screen.getByText(new RegExp(`^${name} ·`)).parentElement!.parentElement!;
async function openDelete(user: ReturnType<typeof setupUser>) {
  await user.click(within(row("Alpha")).getByRole("button", { name: "删除" }));
  return screen.getByRole("alertdialog", { name: "删除工作台" });
}

describe("website deletion lifecycle", () => {
  it("names the confirmation, traps focus and cancels without sending a request", async () => {
    const api = panelApi();
    const user = setupUser();
    render(<AgentWebsitePanel />); await flush();
    const trigger = within(row("Alpha")).getByRole("button", { name: "删除" });
    const dialog = await openDelete(user);
    expect(within(dialog).getByRole("button", { name: "取消" })).toHaveFocus();
    await user.tab({ shift: true });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(api.fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
  });

  it("waits for DELETE acceptance, locks only its SiteID, polls at 2s and refreshes after success", async () => {
    const accepted = deferred<Response>();
    const api = panelApi({ deletion: () => accepted.promise, operation: async () => json({ status: "success" }) });
    const user = setupUser();
    render(<AgentWebsitePanel />); await flush();
    const dialog = await openDelete(user);
    await user.click(within(dialog).getByRole("button", { name: "确认删除" }));
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "取消" })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(dialog).toBeInTheDocument();
    expect(api.fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE")).toEqual([["https://website.test/v1/websites/site-A", expect.objectContaining({ method: "DELETE", credentials: "include" })]]);
    await act(async () => { accepted.resolve(json({ operation_id: "op-A" })); });
    // Radix restores focus in its documented unmount lifecycle, scheduled at 0ms.
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(within(row("Alpha")).queryByRole("button", { name: "删除" })).not.toBeInTheDocument();
    expect(within(row("Beta")).getByRole("button", { name: "删除" })).toBeEnabled();
    expect(screen.getByRole("heading", { name: "工作台列表" })).toHaveFocus();
    await act(async () => { await vi.advanceTimersByTimeAsync(1999); });
    expect(api.operations()).toHaveLength(0);
    api.setSites([beta]);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(api.operations()).toHaveLength(1);
    expect(api.operations()[0]?.[0]).toBe("https://website.test/v1/websites/site-A/operations/op-A");
    expect(screen.queryByText(/^Alpha ·/)).not.toBeInTheDocument();
    expect(api.siteReads()).toHaveLength(2);
    expect(api.fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/capability"))).toHaveLength(2);
  });

  it("keeps rejected DELETE confirmation open without polling and allows cancellation", async () => {
    const api = panelApi({ deletion: async () => json({}, 500) });
    const user = setupUser();
    render(<AgentWebsitePanel />); await flush();
    const trigger = within(row("Alpha")).getByRole("button", { name: "删除" });
    const dialog = await openDelete(user);
    await user.click(within(dialog).getByRole("button", { name: "确认删除" })); await flush();
    expect(within(dialog).getByRole("alert")).toHaveTextContent("删除失败，请稍后重试。");
    expect(api.operations()).toHaveLength(0);
    await user.keyboard("{Escape}"); expect(trigger).toHaveFocus();
  });

  it.each(["failed", "dead"])("retains the row and restores retry after an accepted operation becomes %s", async (status) => {
    const api = panelApi({ operation: async () => json({ status }) });
    const user = setupUser(); render(<AgentWebsitePanel />); await flush();
    await user.click(within(await openDelete(user)).getByRole("button", { name: "确认删除" })); await flush();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(within(row("Alpha")).getByText("删除失败，请稍后重试。")).toBeInTheDocument();
    expect(within(row("Alpha")).getByRole("button", { name: "删除" })).toBeEnabled();
    expect(api.siteReads()).toHaveLength(2);
  });

  it.each(["running", "network"])("stops local polling at timeout while retaining the row after %s responses", async (mode) => {
    const api = panelApi({ operation: async () => { if (mode === "network") throw new Error("fixture offline"); return json({ status: "running" }); } });
    const user = setupUser(); render(<AgentWebsitePanel />); await flush();
    await user.click(within(await openDelete(user)).getByRole("button", { name: "确认删除" })); await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(70000); });
    expect(within(row("Alpha")).getByText("删除仍在进行中，请稍后刷新查看")).toBeInTheDocument();
    const count = api.operations().length;
    expect(count).toBeGreaterThan(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
    expect(api.operations()).toHaveLength(count);
    expect(within(row("Alpha")).getByRole("button", { name: "删除" })).toBeEnabled();
  });

  it.each([false, true])("cleans local polling on unmount with in-flight GET=%s", async (inFlight) => {
    const response = deferred<Response>();
    const api = panelApi({ operation: () => response.promise });
    const user = setupUser(); const view = render(<AgentWebsitePanel />); await flush();
    await user.click(within(await openDelete(user)).getByRole("button", { name: "确认删除" })); await flush();
    if (inFlight) await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    view.unmount();
    await act(async () => { response.resolve(json({ status: "success" })); await vi.advanceTimersByTimeAsync(20000); });
    expect(api.operations()).toHaveLength(inFlight ? 1 : 0);
    expect(api.siteReads()).toHaveLength(1);
  });
});

function ShareFixture({ site = alpha, onChanged, onClose }: { site?: ShareDialogSite; onChanged: (next: { mode: "share_code" | "owner_only"; expiresAt: string | null }) => void; onClose: () => void }) {
  const [open, setOpen] = useState(false);
  return <><button onClick={() => setOpen(true)}>Open share</button>{open && <WebsiteShareDialog site={site} onChanged={onChanged} onClose={() => { onClose(); setOpen(false); }} />}</>;
}
async function openShare(user: ReturnType<typeof setupUser>, site: ShareDialogSite = alpha) {
  const onChanged = vi.fn(); const onClose = vi.fn();
  render(<ShareFixture site={site} onChanged={onChanged} onClose={onClose} />);
  const trigger = screen.getByRole("button", { name: "Open share" });
  await user.click(trigger);
  return { onChanged, onClose, trigger, dialog: screen.getByRole("dialog", { name: "分享网站" }) };
}

describe("website sharing lifecycle", () => {
  it("focuses its visible close control and restores the opener on Escape", async () => {
    const user = setupUser(); const fixture = await openShare(user);
    expect(within(fixture.dialog).getByRole("button", { name: "关闭" })).toHaveFocus();
    await user.tab({ shift: true }); expect(fixture.dialog).toContainElement(document.activeElement as HTMLElement);
    await user.keyboard("{Escape}"); expect(fixture.onClose).toHaveBeenCalledTimes(1); expect(fixture.trigger).toHaveFocus();
    expect(fixture.onChanged).not.toHaveBeenCalled();
  });

  it("blocks close and duration changes while enabling, then reports only successful access changes", async () => {
    const response = deferred<Response>(); const fetchMock = vi.fn(() => response.promise); vi.stubGlobal("fetch", fetchMock);
    const user = setupUser(); const fixture = await openShare(user);
    await user.click(screen.getByRole("button", { name: "开启分享" }));
    expect(screen.getByRole("combobox", { name: "分享链接有效期" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "关闭" })).toBeDisabled();
    await user.keyboard("{Escape}"); fireEvent.pointerDown(document.body); expect(fixture.onClose).not.toHaveBeenCalled();
    expect(fixture.onChanged).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("https://website.test/v1/websites/site-A/access", expect.objectContaining({ method: "PUT", body: JSON.stringify({ mode: "share_code", duration_days: 7 }) }));
    await act(async () => { response.resolve(json({ code: "NEW-CODE", expires_at: expiry })); });
    expect(fixture.onChanged).toHaveBeenCalledExactlyOnceWith({ mode: "share_code", expiresAt: expiry });
    expect(screen.getByText("NEW-CODE")).toBeInTheDocument();
  });

  it.each(["enable", "reset", "stop"])("keeps %s failures retryable without onChanged or closing", async (operation) => {
    const response = deferred<Response>(); vi.stubGlobal("fetch", vi.fn(() => response.promise));
    const user = setupUser(); const clipboard = vi.spyOn(navigator.clipboard, "writeText");
    const fixture = await openShare(user, operation === "enable" ? alpha : { ...alpha, AccessMode: "share_code", ShareExpiresAt: expiry });
    await user.click(screen.getByRole("button", { name: operation === "enable" ? "开启分享" : operation === "stop" ? "停止分享" : "复制分享信息" }));
    expect(screen.getByRole("button", { name: "关闭" })).toBeDisabled();
    await user.keyboard("{Escape}"); expect(fixture.onClose).not.toHaveBeenCalled();
    await act(async () => { response.resolve(json({}, 500)); });
    expect(screen.getByRole("alert")).toHaveTextContent("fixture request failure");
    expect(fixture.onChanged).not.toHaveBeenCalled();
    expect(clipboard).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "关闭" })).toBeEnabled();
  });

  it("keeps the parent dialog open when duration selection is cancelled and commits the selected duration only on enable", async () => {
    const fetchMock = vi.fn(async () => json({ code: "DURATION-CODE", expires_at: expiry })); vi.stubGlobal("fetch", fetchMock);
    const user = setupUser(); const fixture = await openShare(user);
    const trigger = screen.getByRole("combobox", { name: "分享链接有效期" });
    act(() => trigger.focus()); await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(trigger).toHaveFocus(); expect(fixture.dialog).toBeInTheDocument(); expect(fetchMock).not.toHaveBeenCalled();
    await user.keyboard("{ArrowDown}{End}{Enter}");
    expect(trigger).toHaveTextContent("30 天"); expect(fetchMock).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "开启分享" }));
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("https://website.test/v1/websites/site-A/access", expect.objectContaining({ method: "PUT", body: JSON.stringify({ mode: "share_code", duration_days: 30 }) }));
  });

  it("reports explicit reset and stop changes only after their own responses, keeping all pending actions inert", async () => {
    const reset = deferred<Response>(); const stop = deferred<Response>();
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ code: "FIRST", expires_at: expiry })).mockImplementationOnce(() => reset.promise).mockImplementationOnce(() => stop.promise);
    vi.stubGlobal("fetch", fetchMock);
    const user = setupUser(); const fixture = await openShare(user);
    await user.click(screen.getByRole("button", { name: "开启分享" }));
    expect(fixture.onChanged).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "重置分享码" }));
    expect(screen.getByRole("button", { name: "复制分享信息" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "停止分享" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "关闭" })).toBeDisabled();
    await user.keyboard("{Escape}"); fireEvent.pointerDown(document.body);
    expect(fixture.onClose).not.toHaveBeenCalled(); expect(fixture.onChanged).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[1]).toEqual(["https://website.test/v1/websites/site-A/share-code/reset", expect.objectContaining({ method: "POST" })]);
    await act(async () => { reset.resolve(json({ code: "SECOND", expires_at: expiry })); });
    expect(screen.getByText("SECOND")).toBeInTheDocument(); expect(fixture.onChanged).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole("button", { name: "停止分享" }));
    expect(screen.getByRole("button", { name: "重置分享码" })).toBeDisabled();
    await user.keyboard("{Escape}"); expect(fixture.onClose).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[2]).toEqual(["https://website.test/v1/websites/site-A/access", expect.objectContaining({ method: "PUT", body: JSON.stringify({ mode: "owner_only" }) })]);
    expect(fixture.onChanged).toHaveBeenCalledTimes(2);
    await act(async () => { stop.resolve(json({ mode: "owner_only" })); });
    expect(fixture.onChanged).toHaveBeenLastCalledWith({ mode: "owner_only", expiresAt: null });
    expect(fixture.onChanged).toHaveBeenCalledTimes(3);
    expect(screen.queryByText("SECOND")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开启分享" })).toBeEnabled();
    expect(screen.getByRole("combobox", { name: "分享链接有效期" })).toHaveTextContent("7 天");
  });

  it("resets missing plaintext before copying, then reuses the new code", async () => {
    const response = deferred<Response>(); const fetchMock = vi.fn(() => response.promise); vi.stubGlobal("fetch", fetchMock);
    const user = setupUser(); const clipboard = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const fixture = await openShare(user, { ...alpha, AccessMode: "share_code", ShareExpiresAt: expiry });
    await user.click(screen.getByRole("button", { name: "复制分享信息" }));
    expect(clipboard).not.toHaveBeenCalled(); expect(fixture.onChanged).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("https://website.test/v1/websites/site-A/share-code/reset", expect.objectContaining({ method: "POST" }));
    await act(async () => { response.resolve(json({ code: "RESET-CODE", expires_at: expiry })); });
    expect(clipboard).toHaveBeenCalledTimes(1);
    expect(clipboard.mock.calls[0]?.[0]).toContain(alpha.PublicURL);
    expect(clipboard.mock.calls[0]?.[0]).toContain("RESET-CODE");
    expect(clipboard.mock.calls[0]?.[0]).toContain("2026-10-01");
    expect(fixture.onChanged).toHaveBeenCalledExactlyOnceWith({ mode: "share_code", expiresAt: expiry });
    await user.click(screen.getByRole("button", { name: "已复制" }));
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(clipboard).toHaveBeenCalledTimes(2);
  });

  it("keeps a successfully reset code when clipboard and fallback fail, without reporting copied", async () => {
    const fetchMock = vi.fn(async () => json({ code: "SAVED-CODE", expires_at: expiry })); vi.stubGlobal("fetch", fetchMock);
    const user = setupUser(); const clipboard = vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
    const fallback = vi.fn(() => false); Object.defineProperty(document, "execCommand", { configurable: true, value: fallback });
    const fixture = await openShare(user, { ...alpha, AccessMode: "share_code", ShareExpiresAt: expiry });
    await user.click(screen.getByRole("button", { name: "复制分享信息" })); await flush();
    expect(screen.getByText("SAVED-CODE")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("复制失败，请手动复制");
    expect(screen.queryByRole("button", { name: "已复制" })).not.toBeInTheDocument();
    expect(document.querySelector("textarea")).toBeNull();
    expect(fallback).toHaveBeenCalledWith("copy");
    expect(fixture.onChanged).toHaveBeenCalledExactlyOnceWith({ mode: "share_code", expiresAt: expiry });
    await user.click(screen.getByRole("button", { name: "复制分享信息" })); await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(clipboard).toHaveBeenCalledTimes(2);
  });

  it("keeps the existing-code clipboard fallback selection inside the modal and restores the copy trigger", async () => {
    const fetchMock = vi.fn(async () => json({ code: "SELECTABLE-CODE", expires_at: expiry })); vi.stubGlobal("fetch", fetchMock);
    const user = setupUser(); vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("fixture denied"));
    const originalSelect = HTMLTextAreaElement.prototype.select;
    // jsdom select() sets the range but does not focus like the browser fallback.
    // Exercise the real Radix focus trap with that browser focus step as well.
    vi.spyOn(HTMLTextAreaElement.prototype, "select").mockImplementation(function (this: HTMLTextAreaElement) { this.focus(); originalSelect.call(this); });
    const captures: Array<{ inside: boolean; active: boolean; selected: string }> = [];
    Object.defineProperty(document, "execCommand", { configurable: true, value: vi.fn(() => {
      const textarea = document.querySelector("textarea")!;
      captures.push({ inside: screen.getByRole("dialog").contains(textarea), active: document.activeElement === textarea, selected: textarea.value.slice(textarea.selectionStart, textarea.selectionEnd) });
      return true;
    }) });
    const fixture = await openShare(user, { ...alpha, AccessMode: "share_code", ShareExpiresAt: expiry });
    await user.click(screen.getByRole("button", { name: "复制分享信息" }));
    await user.click(screen.getByRole("button", { name: "已复制" }));
    expect(captures).toHaveLength(2);
    expect(captures[1]).toEqual({ inside: true, active: true, selected: expect.stringContaining("SELECTABLE-CODE") });
    expect(captures[1]?.selected).toContain(alpha.PublicURL);
    expect(screen.getByRole("button", { name: "已复制" })).toHaveFocus();
    expect(document.querySelector("textarea")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(fixture.onChanged).toHaveBeenCalledTimes(1);
  });
});
