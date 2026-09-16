import { useState } from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentWebsitePanel } from "@/pages/marketing/agent-website-panel";
import { WebsiteShareDialog } from "@/pages/marketing/agent-website-share-dialog";

vi.mock("@/lib/region", async (original) => ({ ...await original<typeof import("@/lib/region")>(), REGION: "global", isCN: false, isGlobal: true, DEFAULT_LOCALE: "en-US" }));
vi.mock("@/lib/auth-api-base", () => ({ resolveConfiguredAuthApiBaseUrl: () => "https://website.test" }));
vi.mock("@/repositories/http-repositories", () => ({ readStoredAuthToken: () => "fixture-token" }));
vi.mock("@/lib/app-navigation", () => ({ AppLink: ({ children, to, ...props }: React.PropsWithChildren<{ to: string }>) => <a href={to} {...props}>{children}</a> }));

const site = { Id: 1, SiteID: "global-site", Name: "Global workbench", Status: "active", PublicURL: "https://global.example.test", CreatedTime: "2026-01-01T00:00:00Z", AccessMode: "owner_only" as const };
const response = (data: unknown) => new Response(JSON.stringify({ code: "OK", data }), { headers: { "Content-Type": "application/json" } });
beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("website real global labels and account boundary", () => {
  it("keeps global sharing hidden and cancels a named English confirmation without any write", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => response(String(input).endsWith("/capability") ? { max_sites: 10, used_sites: 1 } : { sites: [site] }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup(); render(<AgentWebsitePanel />);
    expect(await screen.findByRole("heading", { name: "My Workbench" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Share" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Visit" })).toHaveAttribute("href", site.PublicURL);
    const trigger = screen.getByRole("button", { name: "Delete" }); await user.click(trigger);
    const dialog = screen.getByRole("alertdialog", { name: "Delete workbench" });
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(within(dialog).getByText(/Global workbench/)).toBeInTheDocument();
    await user.keyboard("{Escape}"); await waitFor(() => expect(trigger).toHaveFocus());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([input]) => !String(input).includes("bot") && !String(input).includes("profile"))).toBe(true);
  });

  it("uses the actual English share labels while preserving duration and onChanged payload", async () => {
    const expiresAt = "2026-10-01T00:00:00Z";
    const fetchMock = vi.fn(async () => response({ code: "ENGLISH-CODE", expires_at: expiresAt })); vi.stubGlobal("fetch", fetchMock);
    const onChanged = vi.fn(); const onClose = vi.fn();
    function Fixture() { const [open, setOpen] = useState(false); return <><button onClick={() => setOpen(true)}>Open share</button>{open && <WebsiteShareDialog site={site} onChanged={onChanged} onClose={() => { onClose(); setOpen(false); }} />}</>; }
    const user = userEvent.setup(); render(<Fixture />);
    const trigger = screen.getByRole("button", { name: "Open share" }); await user.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Share website" });
    expect(within(dialog).getByRole("button", { name: "Close" })).toHaveFocus();
    expect(within(dialog).getByRole("combobox", { name: "Link validity" })).toHaveTextContent("7");
    await user.click(within(dialog).getByRole("button", { name: "Enable sharing" }));
    expect(await screen.findByText("ENGLISH-CODE")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("https://website.test/v1/websites/global-site/access", expect.objectContaining({ method: "PUT", body: JSON.stringify({ mode: "share_code", duration_days: 7 }) }));
    expect(onChanged).toHaveBeenCalledExactlyOnceWith({ mode: "share_code", expiresAt });
    await user.keyboard("{Escape}"); await waitFor(() => expect(trigger).toHaveFocus()); expect(onClose).toHaveBeenCalledTimes(1);
  });
});
