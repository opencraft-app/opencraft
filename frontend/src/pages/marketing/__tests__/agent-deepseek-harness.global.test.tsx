import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeepSeekHarnessCommandClient, DeepSeekHarnessProvider } from "@/lib/deepseek-harness-command";
import { AgentDeepSeekHarnessModelCard } from "../agent-deepseek-harness-model-card";
import { DeepSeekHarnessRepairDialog } from "../agent-deepseek-harness-repair-dialog";

const fixture = vi.hoisted(() => ({
  repositories: { bots: { execDebugCommand: vi.fn() } },
  listProviders: vi.fn(), saveProvider: vi.fn(), removeProvider: vi.fn(),
}));
vi.mock("@/lib/region", async (original) => ({ ...await original<typeof import("@/lib/region")>(), REGION: "global", isCN: false, isGlobal: true, DEFAULT_LOCALE: "en-US" }));
vi.mock("@/contexts/repository-context", () => ({ useRepositories: () => fixture.repositories }));
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const providers: DeepSeekHarnessProvider[] = [
  { id: "deepseek", displayName: "DeepSeek", configured: true, active: true, writable: true },
  { id: "openrouter", displayName: "OpenRouter", configured: false, active: true, writable: true },
];
const clientFactory = () => fixture as unknown as DeepSeekHarnessCommandClient;
const browserDescriptors = ["hasPointerCapture", "setPointerCapture", "releasePointerCapture", "scrollIntoView"].map((key) => [key, Object.getOwnPropertyDescriptor(HTMLElement.prototype, key)] as const);
beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  for (const [key] of browserDescriptors) Object.defineProperty(HTMLElement.prototype, key, { configurable: true, value: key === "hasPointerCapture" ? () => false : () => undefined });
});
afterAll(() => {
  vi.unstubAllGlobals();
  for (const [key, descriptor] of browserDescriptors) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, key, descriptor);
    else Reflect.deleteProperty(HTMLElement.prototype, key);
  }
});
beforeEach(() => {
  vi.clearAllMocks();
  fixture.listProviders.mockResolvedValue(providers);
  fixture.saveProvider.mockResolvedValue(undefined);
});
afterEach(cleanup);

describe("DSH real global UI", () => {
  it("uses English provider labels while saving the selected raw ID and clearing the submitted key", async () => {
    const user = userEvent.setup();
    render(<AgentDeepSeekHarnessModelCard botId="global-bot" region="global" clientFactory={clientFactory} />);
    const trigger = await screen.findByRole("combobox", { name: "Model provider DeepSeek" });
    await user.click(trigger);
    await user.click(screen.getByRole("option", { name: "OpenRouter" }));
    const input = screen.getByLabelText("OpenRouter API key");
    await user.type(input, "global-draft");
    await user.click(screen.getByRole("button", { name: "Show API key" }));
    expect(input).toHaveAttribute("type", "text");
    await user.click(screen.getByRole("button", { name: "Hide API key" }));
    expect(input).toHaveAttribute("type", "password");
    await user.click(screen.getByRole("button", { name: "Save configuration" }));
    expect(fixture.saveProvider).toHaveBeenCalledExactlyOnceWith("openrouter", "global-draft");
    await waitFor(() => expect(screen.getByLabelText("OpenRouter API key")).toHaveValue(""));
    expect(fixture.listProviders).toHaveBeenCalledTimes(2);
    expect(fixture.listProviders).toHaveBeenLastCalledWith("global");
  });

  it("names the English repair confirmation and restores cancellation focus without confirming", async () => {
    const onConfirm = vi.fn();
    function Harness() {
      const [open, setOpen] = useState(false);
      return <><button onClick={() => setOpen(true)}>Repair</button><DeepSeekHarnessRepairDialog open={open} onOpenChange={setOpen} onConfirm={onConfirm} /></>;
    }
    const user = userEvent.setup(); render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Repair" });
    await user.click(trigger);
    const dialog = screen.getByRole("alertdialog", { name: "Repair DeepSeek Harness" });
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
