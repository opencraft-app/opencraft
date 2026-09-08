import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cronClientMocks = vi.hoisted(() => ({
  createCronJobWithContextAndScriptRollback: vi.fn(),
  createCronJobWithScriptRollback: vi.fn(),
  detectCronContextFromCapability: vi.fn(),
  editCronJob: vi.fn(),
  editCronJobWithContext: vi.fn(),
  execCommand: vi.fn(),
  listCronJobs: vi.fn(),
  listRecentCronRuns: vi.fn(),
  removeCronJob: vi.fn(),
  removeManagedCronScriptIfUnreferenced: vi.fn(),
  removeCronJobWithDependentRollback: vi.fn(),
  sendHermesChatNotice: vi.fn(),
  writeZeroTokenScript: vi.fn(),
}));

const runtimeConfigMocks = vi.hoisted(() => ({ zeroTokenAutomationsEnabled: true }));

const skillsClientMocks = vi.hoisted(() => ({
  listInstalledSkillSlugs: vi.fn(),
}));

vi.mock("@/lib/region", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/region")>(),
  REGION: "global",
  isCN: false,
  isGlobal: true,
  DEFAULT_LOCALE: "en-US",
}));

vi.mock("@/lib/hermes-cron-client", async () => ({
  ...await vi.importActual<typeof import("@/lib/hermes-cron-client")>("@/lib/hermes-cron-client"),
  ...cronClientMocks,
}));

vi.mock("@/lib/hermes-skills-client", async () => ({
  ...await vi.importActual<typeof import("@/lib/hermes-skills-client")>("@/lib/hermes-skills-client"),
  ...skillsClientMocks,
}));

vi.mock("@/contexts/runtime-config-context", async () => ({
  ...await vi.importActual<typeof import("@/contexts/runtime-config-context")>("@/contexts/runtime-config-context"),
  useZeroTokenAutomationsEnabled: () => runtimeConfigMocks.zeroTokenAutomationsEnabled,
}));

import type { CronJob } from "@/lib/hermes-cron-client";
import { HermesAgentAutomationsPanel } from "../agent-automations-panel";

beforeEach(() => {
  vi.clearAllMocks();
  cronClientMocks.detectCronContextFromCapability.mockResolvedValue("supported");
  cronClientMocks.execCommand.mockResolvedValue({
    status: "SUCCESS",
    exit_code: 0,
    output: JSON.stringify({ success: true, data: { platforms: [] } }),
  });
  cronClientMocks.listRecentCronRuns.mockResolvedValue([]);
  cronClientMocks.createCronJobWithContextAndScriptRollback.mockResolvedValue("created-job");
  cronClientMocks.createCronJobWithScriptRollback.mockResolvedValue(undefined);
  cronClientMocks.editCronJob.mockResolvedValue(undefined);
  cronClientMocks.editCronJobWithContext.mockResolvedValue(undefined);
  cronClientMocks.removeCronJob.mockResolvedValue(undefined);
  cronClientMocks.removeManagedCronScriptIfUnreferenced.mockResolvedValue(undefined);
  cronClientMocks.removeCronJobWithDependentRollback.mockResolvedValue(undefined);
  cronClientMocks.sendHermesChatNotice.mockResolvedValue({ sent: 0, failed: 0 });
  cronClientMocks.writeZeroTokenScript.mockResolvedValue(undefined);
  skillsClientMocks.listInstalledSkillSlugs.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
});

describe("HermesAgentAutomationsPanel global upstream context", () => {
  it("creates a zero-token fixed notification with English copy and global channels", async () => {
    cronClientMocks.listCronJobs.mockResolvedValue([]);
    cronClientMocks.execCommand.mockResolvedValue({
      status: "SUCCESS",
      exit_code: 0,
      output: JSON.stringify({ success: true, data: { platforms: ["telegram"] } }),
    });
    render(createElement(HermesAgentAutomationsPanel, { botId: "bot-1" }));

    fireEvent.click(await screen.findByRole("button", { name: "Create" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Job type")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /AI-powered/ })).toBeInTheDocument();
    expect(screen.getByText("AI understands your needs and completes tasks automatically")).not.toHaveClass("min-h-8");
    expect(screen.getByText("Sends notifications as-is; no model")).not.toHaveClass("min-h-8");
    expect(screen.getByText("Run preset scripts, ideal for developers")).not.toHaveClass("min-h-8");
    expect(screen.queryByText("No model-token usage")).not.toBeInTheDocument();
    expect(within(dialog).getAllByText("AI-powered", { selector: "span" })).toHaveLength(2);
    expect(within(dialog).getAllByText("AI-powered", { selector: "span" })[1]).toHaveClass("bg-indigo-600", "text-white");
    expect(within(dialog).getAllByText("0 Token")).toHaveLength(2);
    within(dialog).getAllByText("0 Token").forEach((label) => {
      expect(label).toHaveClass("bg-blue-50", "text-blue-700");
    });
    expect(within(dialog).queryByRole("button", { name: /0 Token/ })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /Notification task/ })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /Script task/ })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: /Notification task/ }));
    fireEvent.change(screen.getByPlaceholderText("Enter the scheduled task name"), {
      target: { value: "Hydration reminder" },
    });
    fireEvent.change(screen.getByPlaceholderText(/Time for some water/), {
      target: { value: "Time to drink water" },
    });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(cronClientMocks.writeZeroTokenScript).toHaveBeenCalledWith(
        "bot-1",
        expect.stringMatching(/^lightvela-zero-token-/),
        expect.objectContaining({
          kind: "fixed_notification",
          content: "Time to drink water",
        }),
      );
    });
    expect(cronClientMocks.createCronJobWithScriptRollback).toHaveBeenCalledWith(
      "bot-1",
      expect.objectContaining({ noAgent: true, name: "Hydration reminder" }),
      expect.stringMatching(/^lightvela-zero-token-/),
    );
  });

  it("hydrates and exposes upstream job context on the global site", async () => {
    cronClientMocks.listCronJobs.mockResolvedValue([
      makeCronJob({ id: "downstream", name: "Downstream", context_from: ["upstream"] }),
      makeCronJob({ id: "upstream", name: "Upstream" }),
    ]);

    render(createElement(HermesAgentAutomationsPanel, { botId: "bot-1" }));

    await waitFor(() => {
      expect(cronClientMocks.listCronJobs).toHaveBeenCalledWith("bot-1", { hydrateContextFrom: true });
    });
    expect(cronClientMocks.detectCronContextFromCapability).toHaveBeenCalledWith("bot-1");
    expect(await screen.findByText("From: Upstream")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Create|新建/ }));
    expect(screen.getByRole("dialog")).toHaveTextContent("Create Scheduled Task");
    expect(screen.getByRole("dialog")).toHaveTextContent("Instructions");
    expect(screen.getByRole("combobox", { name: "Upstream Job" })).toBeInTheDocument();
  });

  it("shows relationship details and safely detaches dependents before deletion", async () => {
    const upstream = makeCronJob({ id: "upstream", name: "Upstream" });
    const downstream = makeCronJob({ id: "downstream", name: "Downstream", context_from: ["upstream"] });
    cronClientMocks.listCronJobs.mockResolvedValue([upstream, downstream]);

    render(createElement(HermesAgentAutomationsPanel, { botId: "bot-1" }));

    const upstreamCard = await getCronJobCard("Upstream");
    fireEvent.click(within(upstreamCard).getByRole("button", { name: /View|查看/ }));
    expect(within(screen.getByRole("dialog")).getByText("Scheduled Task Details")).toBeInTheDocument();
    expect(within(screen.getByRole("dialog")).getByText("Upstream Job")).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /Close|关闭/ }));

    fireEvent.click(within(upstreamCard).getByRole("button", { name: /Delete|删除/ }));
    const deleteDialog = screen.getByRole("dialog");
    expect(within(deleteDialog).getByText("Downstream")).toBeInTheDocument();
    fireEvent.click(within(deleteDialog).getByRole("button", { name: /Delete|删除/ }));

    await waitFor(() => {
      expect(cronClientMocks.removeCronJobWithDependentRollback).toHaveBeenCalledWith("bot-1", "upstream", [{
        id: "downstream",
        name: "Downstream",
        contextFrom: ["upstream"],
      }]);
    });
    expect(cronClientMocks.removeCronJob).not.toHaveBeenCalled();
  });

  it("uses structured creation when an upstream task is selected", async () => {
    cronClientMocks.listCronJobs.mockResolvedValue([
      makeCronJob({ id: "upstream", name: "Upstream" }),
    ]);

    render(createElement(HermesAgentAutomationsPanel, { botId: "bot-1" }));

    fireEvent.click(await screen.findByRole("button", { name: "Create" }));
    fireEvent.change(screen.getByPlaceholderText("Enter the scheduled task name"), {
      target: { value: "Global downstream" },
    });
    fireEvent.change(screen.getByPlaceholderText(/Describe what you want the agent to understand and do/), {
      target: { value: "Summarize upstream output" },
    });
    fireEvent.click(screen.getByRole("combobox", { name: "Upstream Job" }));
    fireEvent.click(screen.getByRole("option", { name: /Upstream/ }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(cronClientMocks.createCronJobWithContextAndScriptRollback).toHaveBeenCalledWith(
        "bot-1",
        expect.objectContaining({
          name: "Global downstream",
          prompt: "Summarize upstream output",
        }),
        "upstream",
        undefined,
      );
    });
    expect(cronClientMocks.createCronJobWithScriptRollback).not.toHaveBeenCalled();
  });

  it("uses structured editing when an upstream relationship is cleared", async () => {
    const upstream = makeCronJob({ id: "upstream", name: "Upstream" });
    const downstream = makeCronJob({
      id: "downstream",
      name: "Downstream",
      context_from: ["upstream"],
    });
    cronClientMocks.listCronJobs.mockResolvedValue([downstream, upstream]);

    render(createElement(HermesAgentAutomationsPanel, { botId: "bot-1" }));

    const card = await getCronJobCard("Downstream");
    fireEvent.click(within(card).getByRole("button", { name: "Edit" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("Edit Scheduled Task");
    expect(screen.getByRole("combobox", { name: "Upstream Job" })).toHaveTextContent("Upstream");
    fireEvent.click(screen.getByRole("button", { name: "Deselect" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(cronClientMocks.editCronJobWithContext).toHaveBeenCalledWith("bot-1", "downstream", {}, []);
    });
    expect(cronClientMocks.editCronJob).not.toHaveBeenCalled();
  });

  it("keeps ordinary creation on the legacy path", async () => {
    cronClientMocks.listCronJobs.mockResolvedValue([]);

    render(createElement(HermesAgentAutomationsPanel, { botId: "bot-1" }));

    fireEvent.click(await screen.findByRole("button", { name: "Create" }));
    fireEvent.change(screen.getByPlaceholderText("Enter the scheduled task name"), {
      target: { value: "Global task" },
    });
    fireEvent.change(screen.getByPlaceholderText(/Describe what you want the agent to understand and do/), {
      target: { value: "Summarize updates" },
    });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(cronClientMocks.createCronJobWithScriptRollback).toHaveBeenCalledTimes(1);
    });
    expect(cronClientMocks.createCronJobWithContextAndScriptRollback).not.toHaveBeenCalled();
  });

  it("keeps editing on the legacy path when no relationship changes", async () => {
    cronClientMocks.listCronJobs.mockResolvedValue([
      makeCronJob({ id: "ordinary", name: "Ordinary task" }),
    ]);

    render(createElement(HermesAgentAutomationsPanel, { botId: "bot-1" }));

    const card = await getCronJobCard("Ordinary task");
    fireEvent.click(within(card).getByRole("button", { name: "Edit" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("Edit Scheduled Task");
    fireEvent.change(screen.getByPlaceholderText("Enter the scheduled task name"), {
      target: { value: "Updated global task" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(cronClientMocks.editCronJob).toHaveBeenCalledWith(
        "bot-1",
        "ordinary",
        { name: "Updated global task" },
      );
    });
    expect(cronClientMocks.editCronJobWithContext).not.toHaveBeenCalled();
  });

  it("separates active and ended jobs with English tabs", async () => {
    cronClientMocks.listCronJobs.mockResolvedValue([
      makeCronJob({ id: "active", name: "Active task", state: "scheduled" }),
      makeCronJob({ id: "completed", name: "Completed task", state: "completed", enabled: false }),
    ]);

    render(createElement(HermesAgentAutomationsPanel, { botId: "bot-1" }));

    const currentTab = await screen.findByRole("button", { name: "Current Jobs" });
    const taskTypeFilter = screen.getByRole("combobox", { name: "Job type" });
    expect(taskTypeFilter).toHaveTextContent("All");
    fireEvent.click(taskTypeFilter);
    expect(screen.getByRole("option", { name: "AI-powered" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: "All" }));
    expect(taskTypeFilter.parentElement).not.toBe(currentTab.parentElement);
    expect(screen.getByRole("button", { name: "Ended Jobs" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Recent Runs" })).toBeInTheDocument();
    expect(screen.getByText("Active task")).toBeInTheDocument();
    expect(screen.queryByText("Completed task")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Ended Jobs" }));

    const card = await getCronJobCard("Completed task");
    expect(within(card).getByText("Completed")).toBeInTheDocument();
    expect(within(card).queryByText("Paused")).toBeNull();
    expect(within(card).queryByRole("button", { name: "Pause" })).toBeNull();
  });
});

async function getCronJobCard(jobName: string): Promise<HTMLElement> {
  const name = await screen.findByText(jobName);
  const card = name.closest("div.flex.flex-col.rounded-md");
  if (!(card instanceof HTMLElement)) throw new Error(`Cron job card not found: ${jobName}`);
  return card;
}

function makeCronJob(overrides: Partial<CronJob>): CronJob {
  return {
    id: "job-1",
    name: "Task",
    prompt: "Do work",
    schedule: { kind: "cron", expr: "0 9 * * *", display: "every day at 09:00" },
    skills: [],
    enabled: true,
    state: "",
    deliver: "local",
    next_run_at: "2026-08-19T09:00:00+08:00",
    last_run_at: null,
    last_status: null,
    created_at: null,
    script: "",
    effective_window: null,
    lightvela_schedule: null,
    context_from: null,
    context_from_hydrated: true,
    inference_config: null,
    ...overrides,
  };
}
