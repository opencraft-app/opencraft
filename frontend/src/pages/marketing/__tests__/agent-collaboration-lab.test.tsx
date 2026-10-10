import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentCollaborationLab } from "@/pages/marketing/agent-collaboration-lab";
import { COLLABORATION_SHOWN_KEY } from "@/lib/collaboration-visibility";

vi.mock("@/lib/auth-api-base", () => ({ resolveConfiguredAuthApiBaseUrl: () => "https://lightclaw.tech" }));
vi.mock("@/i18n/t", () => ({ useT: () => (value: string) => value }));
vi.mock("@/lib/app-navigation", () => ({ AppLink: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock("@/pages/marketing/agent-collaboration-panel", () => ({ AgentCollaborationPanel: () => <div>connected-panel</div> }));
afterEach(() => { cleanup(); window.localStorage.removeItem(COLLABORATION_SHOWN_KEY); });

describe("collaboration lab route", () => {
  it("guards direct URLs, opens after show and removes the mounted panel after hide", async () => {
    render(<AgentCollaborationLab />);
    expect(screen.getByText("此实验室功能尚未开启。")).toBeInTheDocument();
    expect(screen.queryByText("connected-panel")).toBeNull();
    const show = Reflect.get(window, "show") as () => boolean;
    await act(async () => { show(); });
    expect(await screen.findByText("connected-panel")).toBeInTheDocument();
    act(() => { show(); });
    expect(screen.queryByText("connected-panel")).toBeNull();
  });
});
