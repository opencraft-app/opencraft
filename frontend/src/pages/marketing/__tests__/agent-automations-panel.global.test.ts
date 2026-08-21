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
  removeCronJobWithDependentRollback: vi.fn(),
}));

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
  cronClientMocks.removeCronJobWithDependentRollback.mockResolvedValue(undefined);
  skillsClientMocks.listInstalledSkillSlugs.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
});

describe("HermesAgentAutomationsPanel global isolation", () => {
  it("does not detect or expose upstream task context on the global site", async () => {
    cronClientMocks.listCronJobs.mockResolvedValue([
      makeCronJob({ id: "downstream", name: "Downstream", context_from: ["upstream"] }),
      makeCronJob({ id: "upstream", name: "Upstream" }),
    ]);

    render(createElement(HermesAgentAutomationsPanel, { botId: "bot-1" }));

    await waitFor(() => {
      expect(cronClientMocks.listCronJobs).toHaveBeenCalledWith("bot-1", { hydrateContextFrom: false });
    });
    expect(cronClientMocks.detectCronContextFromCapability).not.toHaveBeenCalled();
    expect(screen.queryByText(/From: Upstream|来自：Upstream/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Add|添加/ }));
    expect(screen.queryByText(/Upstream task|上游任务/)).toBeNull();
  });

  it("hides relationship details and keeps deletion on the legacy path", async () => {
    const upstream = makeCronJob({ id: "upstream", name: "Upstream" });
    const downstream = makeCronJob({ id: "downstream", name: "Downstream", context_from: ["upstream"] });
    cronClientMocks.listCronJobs.mockResolvedValue([upstream, downstream]);

    render(createElement(HermesAgentAutomationsPanel, { botId: "bot-1" }));

    const upstreamCard = await getCronJobCard("Upstream");
    fireEvent.click(within(upstreamCard).getByRole("button", { name: /View|查看/ }));
    expect(within(screen.getByRole("dialog")).queryByText(/Upstream task|上游任务/)).toBeNull();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /Close|关闭/ }));

    fireEvent.click(within(upstreamCard).getByRole("button", { name: /Delete|删除/ }));
    const deleteDialog = screen.getByRole("dialog");
    expect(within(deleteDialog).queryByText("Downstream")).toBeNull();
    fireEvent.click(within(deleteDialog).getByRole("button", { name: /Delete|删除/ }));

    await waitFor(() => {
      expect(cronClientMocks.removeCronJob).toHaveBeenCalledWith("bot-1", "upstream");
    });
    expect(cronClientMocks.removeCronJobWithDependentRollback).not.toHaveBeenCalled();
  });

  it("keeps creation on the legacy path", async () => {
    cronClientMocks.listCronJobs.mockResolvedValue([]);

    render(createElement(HermesAgentAutomationsPanel, { botId: "bot-1" }));

    fireEvent.click(await screen.findByRole("button", { name: "Add" }));
    fireEvent.change(screen.getByPlaceholderText("Enter the automation name"), {
      target: { value: "Global task" },
    });
    fireEvent.change(screen.getByPlaceholderText(/Describe the task as a prompt/), {
      target: { value: "Summarize updates" },
    });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Add" }));

    await waitFor(() => {
      expect(cronClientMocks.createCronJobWithScriptRollback).toHaveBeenCalledTimes(1);
    });
    expect(cronClientMocks.createCronJobWithContextAndScriptRollback).not.toHaveBeenCalled();
  });

  it("keeps editing on the legacy path", async () => {
    cronClientMocks.listCronJobs.mockResolvedValue([
      makeCronJob({ id: "ordinary", name: "Ordinary task" }),
    ]);

    render(createElement(HermesAgentAutomationsPanel, { botId: "bot-1" }));

    const card = await getCronJobCard("Ordinary task");
    fireEvent.click(within(card).getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByPlaceholderText("Enter the automation name"), {
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

  it("keeps legacy terminal task card actions", async () => {
    cronClientMocks.listCronJobs.mockResolvedValue([
      makeCronJob({ id: "completed", name: "Completed task", state: "completed", enabled: true }),
    ]);

    render(createElement(HermesAgentAutomationsPanel, { botId: "bot-1" }));

    const card = await getCronJobCard("Completed task");
    expect(within(card).getByRole("button", { name: "Pause" })).toBeInTheDocument();
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
