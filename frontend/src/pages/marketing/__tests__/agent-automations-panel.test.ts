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
  sendHermesChatNotice: vi.fn(),
  startCronTestRun: vi.fn(),
}));

const skillsClientMocks = vi.hoisted(() => ({
  listInstalledSkillSlugs: vi.fn(),
}));

vi.mock("@/lib/hermes-cron-client", async () => ({
  ...await vi.importActual<typeof import("@/lib/hermes-cron-client")>("@/lib/hermes-cron-client"),
  ...cronClientMocks,
}));

vi.mock("@/lib/hermes-skills-client", async () => ({
  ...await vi.importActual<typeof import("@/lib/hermes-skills-client")>("@/lib/hermes-skills-client"),
  ...skillsClientMocks,
}));

import {
  AutomationFormModal,
  buildEffectiveWindowFromInputs,
  buildDeliverString,
  buildHermesSendCommand,
  buildHermesSendTarget,
  buildHermesSendTestCommand,
  buildScheduleString,
  formatEffectiveWindow,
  formatEffectiveWindowPeriod,
  formatEffectiveWindowTooltipLines,
  formatScheduleTooltip,
  formatTestSendError,
  getAutomationSkillSelectionIssue,
  getEligibleCronUpstreams,
  getTestSendFailureFallback,
  getLastAgentRunForJob,
  getEffectiveWindowStatus,
  isHermesNotificationChannelConfigured,
  isCronJobExpiredBeyondGrace,
  isEffectiveWindowRangeInvalid,
  normalizeDailyTimesForEditing,
  normalizeDailyTimesForForm,
  normalizeEffectiveWindowInput,
  parseEnabledHermesChannels,
  parseCronDate,
  parseInitialDeliver,
  parseInitialSchedule,
  parseOnceScheduleDate,
  HermesAgentAutomationsPanel,
  RecentCronRunsPanel,
  sanitizeClockTimeDraft,
  shouldShowRecentRunsLimitHint,
  shouldRejectPastOnceSchedule,
  toCreateCronSkills,
  toCronContextPatch,
  toEditCronSkills,
  wouldCreateCronContextCycle,
} from "../agent-automations-panel";
import { CronCommandError, type CronJob, type CronRunRecord } from "@/lib/hermes-cron-client";
import { isGlobal } from "@/lib/region";

beforeEach(() => {
  vi.clearAllMocks();
  cronClientMocks.createCronJobWithContextAndScriptRollback.mockResolvedValue("created-job");
  cronClientMocks.createCronJobWithScriptRollback.mockResolvedValue(undefined);
  cronClientMocks.detectCronContextFromCapability.mockResolvedValue("supported");
  cronClientMocks.editCronJob.mockResolvedValue(undefined);
  cronClientMocks.editCronJobWithContext.mockResolvedValue(undefined);
  cronClientMocks.execCommand.mockResolvedValue({
    status: "SUCCESS",
    exit_code: 0,
    output: JSON.stringify({ success: true, data: { platforms: [] } }),
  });
  cronClientMocks.listCronJobs.mockResolvedValue([]);
  cronClientMocks.listRecentCronRuns.mockResolvedValue([]);
  cronClientMocks.removeCronJob.mockResolvedValue(undefined);
  cronClientMocks.removeCronJobWithDependentRollback.mockResolvedValue(undefined);
  cronClientMocks.sendHermesChatNotice.mockResolvedValue({ sent: 0, failed: 0 });
  cronClientMocks.startCronTestRun.mockResolvedValue({
    completion: Promise.resolve({ output: "ok", deliveryError: null }),
  });
  skillsClientMocks.listInstalledSkillSlugs.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("recent run limit hint", () => {
  it("shows the hint only when at least 10 runs are displayed", () => {
    expect(shouldShowRecentRunsLimitHint(0)).toBe(false);
    expect(shouldShowRecentRunsLimitHint(1)).toBe(false);
    expect(shouldShowRecentRunsLimitHint(9)).toBe(false);
    expect(shouldShowRecentRunsLimitHint(10)).toBe(true);
    expect(shouldShowRecentRunsLimitHint(11)).toBe(true);
  });

  it("renders the empty recent-runs message without a nested gray container", () => {
    const { container } = render(createElement(RecentCronRunsPanel, {
      runs: [],
      skillLoadState: { status: "ready", slugs: [], error: null },
    }));
    const message = screen.getByText("暂无执行记录");
    const emptyState = message.closest("div");
    const panel = container.querySelector("section");

    expect(emptyState).not.toBeNull();
    expect(emptyState).toHaveClass("m-4", "px-3", "py-2", "text-xs", "text-black/45");
    expect(emptyState).not.toHaveClass("bg-black/[0.02]", "rounded-lg");
    expect(panel).toHaveClass("rounded-md", "bg-white");
    expect(panel).toHaveStyle({ background: "#ffffff" });
  });

  it("shows model drift as an unexecuted run with a concise reason", () => {
    render(createElement(RecentCronRunsPanel, {
      runs: [makeCronRun({
        job_name: "每日工作小结",
        status: "not_executed",
        skip_reason: "model_changed",
      })],
      skillLoadState: { status: "ready", slugs: [], error: null },
    }));

    expect(screen.getByText("每日工作小结")).toBeTruthy();
    expect(screen.getByText("未执行")).toBeTruthy();
    expect(screen.getByText("问题原因：模型切换导致任务未执行")).toBeTruthy();
  });

  it("localizes the unsupported-plan model error", () => {
    render(createElement(RecentCronRunsPanel, {
      runs: [makeCronRun({
        status: "error: RuntimeError: HTTP 403: The requested model is not available in your current plan.",
      })],
      skillLoadState: { status: "ready", slugs: [], error: null },
    }));

    expect(screen.getByText("执行失败：当前模型暂不可用，请稍后重试或切换模型。")).toBeTruthy();
    expect(screen.queryByText(/The requested model is not available/)).toBeNull();
  });

  it("shows the bound Skill in the recent-run detail", () => {
    render(createElement(RecentCronRunsPanel, {
      runs: [makeCronRun({ skills: ["builder-radar"] })],
      skillLoadState: { status: "ready", slugs: ["builder-radar"], error: null },
    }));

    fireEvent.click(screen.getAllByRole("button", { name: "查看任务详情" })[0]!);

    expect(screen.getByText("调用技能")).toBeTruthy();
    expect(screen.getByText("Builder Radar")).toBeTruthy();
    expect(screen.getByText("builder-radar")).toBeTruthy();
  });

  it("shows an unconfigured Skill binding in the recent-run detail", () => {
    render(createElement(RecentCronRunsPanel, {
      runs: [makeCronRun({ skills: [] })],
      skillLoadState: { status: "ready", slugs: [], error: null },
    }));

    fireEvent.click(screen.getAllByRole("button", { name: "查看任务详情" })[0]!);

    expect(screen.getByText("调用技能")).toBeTruthy();
    expect(screen.getByText("未配置")).toBeTruthy();
  });
});

describe("automation Skill form mapping", () => {
  it("omits Skill input for ordinary tasks and stores one selected slug", () => {
    expect(toCreateCronSkills("")).toBeUndefined();
    expect(toCreateCronSkills("finance-news")).toEqual(["finance-news"]);
  });

  it("distinguishes keeping, replacing and clearing an edit binding", () => {
    expect(toEditCronSkills(["finance-news"], "finance-news")).toBeUndefined();
    expect(toEditCronSkills(["finance-news"], "market-data")).toEqual(["market-data"]);
    expect(toEditCronSkills(["finance-news"], "")).toEqual([]);
  });

  it("does not collapse an external multi-Skill task when its first binding is unchanged", () => {
    expect(toEditCronSkills(["first", "second"], "first")).toBeUndefined();
  });

  it("rejects a new or changed binding that is missing or cannot be verified", () => {
    expect(getAutomationSkillSelectionIssue({
      mode: "create",
      initialSkills: [],
      selectedSkill: "finance-news",
      initialSkillWasAvailable: null,
      verificationState: { status: "ready", slugs: [], error: null },
    })).toBe("unavailable");

    expect(getAutomationSkillSelectionIssue({
      mode: "edit",
      initialSkills: ["finance-news"],
      selectedSkill: "market-data",
      initialSkillWasAvailable: true,
      verificationState: { status: "error", slugs: ["finance-news"], error: "network failed" },
    })).toBe("unverified");
  });

  it("allows ordinary tasks and unchanged historical unavailable bindings", () => {
    expect(getAutomationSkillSelectionIssue({
      mode: "create",
      initialSkills: [],
      selectedSkill: "",
      initialSkillWasAvailable: null,
      verificationState: { status: "error", slugs: [], error: "network failed" },
    })).toBeNull();

    expect(getAutomationSkillSelectionIssue({
      mode: "edit",
      initialSkills: ["removed-skill"],
      selectedSkill: "removed-skill",
      initialSkillWasAvailable: false,
      verificationState: { status: "ready", slugs: [], error: null },
    })).toBeNull();
  });

  it("detects a binding that became unavailable while the edit form was open", () => {
    expect(getAutomationSkillSelectionIssue({
      mode: "edit",
      initialSkills: ["finance-news"],
      selectedSkill: "finance-news",
      initialSkillWasAvailable: true,
      verificationState: { status: "ready", slugs: [], error: null },
    })).toBe("unavailable");
  });
});

describe("cron context relationship helpers", () => {
  it("detects cycles using downstream-to-upstream edges", () => {
    const jobs = [
      makeCronJob({ id: "a", context_from: null }),
      makeCronJob({ id: "b", context_from: ["a"] }),
      makeCronJob({ id: "c", context_from: ["b"] }),
    ];

    expect(wouldCreateCronContextCycle(jobs, "a", "c")).toBe(true);
    expect(wouldCreateCronContextCycle(jobs, "c", "a")).toBe(false);
  });

  it("preserves the unchanged state and only patches explicit relationship changes", () => {
    expect(toCronContextPatch(["a"], "a", false)).toBeUndefined();
    expect(toCronContextPatch(["a"], "", true)).toEqual([]);
    expect(toCronContextPatch(["a", "x"], "", false)).toBeUndefined();
    expect(toCronContextPatch(["a", "x"], "a", true)).toEqual(["a"]);
  });

  it("excludes unsafe or inactive upstream candidates while preserving eligible jobs", () => {
    const now = new Date("2026-08-14T12:00:00+08:00").getTime();
    const jobs = [
      makeCronJob({ id: "current", name: "当前任务" }),
      makeCronJob({ id: "eligible", name: "可选任务" }),
      makeCronJob({ id: "paused", name: "暂停任务", enabled: false }),
      makeCronJob({ id: "expired", name: "过期任务", next_run_at: "2026-08-14T11:00:00+08:00" }),
      makeCronJob({ id: "test", name: "临时测试运行\u2063\u2063" }),
      makeCronJob({ id: "trial", name: "试跑 - 场景任务" }),
      makeCronJob({ id: "cycle", name: "成环任务", context_from: ["current"] }),
    ];

    expect(getEligibleCronUpstreams(jobs, "current", now).map((job) => job.id)).toEqual(["eligible"]);
  });

  it("allows all otherwise eligible jobs when creating without a current job id", () => {
    const jobs = [
      makeCronJob({ id: "a" }),
      makeCronJob({ id: "b", context_from: ["a"] }),
    ];

    expect(getEligibleCronUpstreams(jobs, null, Date.now()).map((job) => job.id)).toEqual(["a", "b"]);
  });

  it("excludes ended effective windows while keeping pending upstreams eligible", () => {
    const now = new Date("2026-08-14T12:00:00+08:00").getTime();
    const recurringSchedule = { kind: "cron", expr: "0 9 * * *", display: "每天 09:00" };
    const jobs = [
      makeCronJob({
        id: "ended",
        schedule: recurringSchedule,
        effective_window: { start_at: null, end_at: "2026-08-14T11:59:00+08:00" },
      }),
      makeCronJob({
        id: "pending",
        schedule: recurringSchedule,
        effective_window: { start_at: "2026-08-14T13:00:00+08:00", end_at: null },
      }),
    ];

    expect(getEligibleCronUpstreams(jobs, null, now).map((job) => job.id)).toEqual(["pending"]);
  });

  it("excludes completed jobs without relying on next_run_at", () => {
    const completed = makeCronJob({
      id: "completed",
      state: "completed",
      enabled: true,
      next_run_at: null,
    });

    expect(getEligibleCronUpstreams([completed], null, Date.now())).toEqual([]);
  });
});

describe("cron context panel integration", () => {
  it.each(["create", "edit"] as const)("uses the wider responsive form in $mode mode", (mode) => {
    renderAutomationForm({
      mode,
      initialJob: mode === "edit" ? makeCronJob({ id: "edit-width", name: "编辑宽度任务" }) : undefined,
    });

    expect(screen.getByRole("dialog").firstElementChild).toHaveClass("w-full", "max-w-[680px]");
  });

  it("uses the new copy for the blank create entry and modal title", async () => {
    render(createElement(HermesAgentAutomationsPanel, { botId: "bot-1" }));

    expect(await screen.findByRole("button", { name: isGlobal ? "Create from a template" : "参考模板新建" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: isGlobal ? "Create" : "新建" }));

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(isGlobal ? "Create Job" : "新建自动任务")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: isGlobal ? "Create" : "新建" })).toBeTruthy();
  });

  it("uses new-task copy when confirming creation above the active-job limit", async () => {
    cronClientMocks.listCronJobs.mockResolvedValue(Array.from({ length: 20 }, (_, index) => makeCronJob({
      id: `limit-${index}`,
      name: `上限任务 ${index}`,
      state: "scheduled",
    })));
    render(createElement(HermesAgentAutomationsPanel, { botId: "bot-1" }));

    fireEvent.click(await screen.findByRole("button", { name: isGlobal ? "Create" : "新建" }));

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("button", { name: isGlobal ? "Continue creating" : "继续新建" })).toBeTruthy();
  });

  it("keeps the refresh button static and disabled during the initial load", async () => {
    let resolveJobs: ((jobs: CronJob[]) => void) | undefined;
    cronClientMocks.listCronJobs.mockImplementationOnce(() => new Promise((resolve) => {
      resolveJobs = resolve;
    }));

    render(createElement(HermesAgentAutomationsPanel, { botId: "bot-1" }));

    const refreshButton = screen.getByRole("button", { name: "刷新" });
    expect(refreshButton).toBeDisabled();
    expect(refreshButton.querySelector("svg")).not.toHaveClass("animate-spin");

    resolveJobs?.([]);
    await waitFor(() => expect(refreshButton).toBeEnabled());
  });

  it("spins the refresh icon only after an explicit refresh", async () => {
    render(createElement(HermesAgentAutomationsPanel, { botId: "bot-1" }));
    const refreshButton = screen.getByRole("button", { name: "刷新" });
    await waitFor(() => expect(refreshButton).toBeEnabled());

    let resolveRefresh: ((jobs: CronJob[]) => void) | undefined;
    cronClientMocks.listCronJobs.mockImplementationOnce(() => new Promise((resolve) => {
      resolveRefresh = resolve;
    }));
    fireEvent.click(refreshButton);

    expect(refreshButton).toBeDisabled();
    expect(refreshButton.querySelector("svg")).toHaveClass("animate-spin");

    resolveRefresh?.([]);
    await waitFor(() => expect(refreshButton).toBeEnabled());
    expect(refreshButton.querySelector("svg")).not.toHaveClass("animate-spin");
  });

  it("renders the Skill picker before the upstream task picker", async () => {
    cronClientMocks.listCronJobs.mockResolvedValue([]);

    render(createElement(HermesAgentAutomationsPanel, { botId: "bot-1" }));

    await waitFor(() => {
      expect(cronClientMocks.detectCronContextFromCapability).toHaveBeenCalledWith("bot-1");
    });
    fireEvent.click(screen.getByRole("button", { name: "新建" }));

    const skillLabel = await screen.findByText("调用技能");
    const upstreamLabel = screen.getByText("上游任务");
    expect(
      skillLabel.compareDocumentPosition(upstreamLabel) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("detects capability for the current bot and keeps its upstream explanation inside the picker", async () => {
    cronClientMocks.listCronJobs.mockResolvedValue([makeCronJob({ id: "upstream", name: "上游任务 A" })]);

    render(createElement(HermesAgentAutomationsPanel, { botId: "bot-1" }));

    await waitFor(() => {
      expect(cronClientMocks.detectCronContextFromCapability).toHaveBeenCalledWith("bot-1");
    });
    fireEvent.click(screen.getByRole("button", { name: "新建" }));

    const upstreamLabel = (await screen.findByText("上游任务")).closest("label");
    expect(upstreamLabel).not.toBeNull();
    expect(within(upstreamLabel!).getByText("（可选）")).toHaveClass(
      "ml-1",
      "text-xs",
      "font-normal",
      "text-black/40",
    );
    expect(screen.queryByText("本任务执行时，将使用该任务最近一次完成输出作为上下文；不会等待上游当前运行完成。")).toBeNull();
    expect(screen.getByRole("combobox", { name: "上游任务" })).toHaveTextContent(
      "本任务执行时，将使用上游任务最近的输出作为上下文",
    );
    expect(screen.getByRole("combobox", { name: "上游任务" })).not.toHaveTextContent(
      "使用上游任务最近一次的输出来作为本任务执行的上下文",
    );
  });

  it("retries an unknown capability check without closing or clearing the create form", async () => {
    cronClientMocks.detectCronContextFromCapability
      .mockResolvedValueOnce("unknown")
      .mockResolvedValueOnce("supported");
    cronClientMocks.listCronJobs.mockResolvedValue([makeCronJob({ id: "upstream", name: "上游任务 A" })]);

    render(createElement(HermesAgentAutomationsPanel, { botId: "bot-1" }));
    await waitFor(() => {
      expect(cronClientMocks.detectCronContextFromCapability).toHaveBeenCalledTimes(1);
    });
    fireEvent.click(screen.getByRole("button", { name: "新建" }));
    fireEvent.change(screen.getByPlaceholderText("请输入自动任务名称"), { target: { value: "保留中的草稿" } });

    fireEvent.click(await screen.findByRole("button", { name: "重试" }));

    await waitFor(() => {
      expect(cronClientMocks.detectCronContextFromCapability).toHaveBeenCalledTimes(2);
      expect(screen.getByRole("combobox", { name: "上游任务" })).toBeEnabled();
    });
    expect(screen.getByDisplayValue("保留中的草稿")).toBeTruthy();
  });

  it("ignores a stale capability response after the bot changes", async () => {
    let resolveFirst: ((value: "unknown") => void) | undefined;
    let resolveSecond: ((value: "supported") => void) | undefined;
    cronClientMocks.detectCronContextFromCapability
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; }));
    cronClientMocks.listCronJobs.mockResolvedValue([makeCronJob({ id: "upstream", name: "上游任务 A" })]);

    const { rerender } = render(createElement(HermesAgentAutomationsPanel, { botId: "bot-1" }));
    await waitFor(() => {
      expect(cronClientMocks.detectCronContextFromCapability).toHaveBeenCalledWith("bot-1");
    });
    rerender(createElement(HermesAgentAutomationsPanel, { botId: "bot-2" }));
    await waitFor(() => {
      expect(cronClientMocks.detectCronContextFromCapability).toHaveBeenCalledWith("bot-2");
    });

    resolveSecond?.("supported");
    await waitFor(() => {
      expect(cronClientMocks.detectCronContextFromCapability).toHaveBeenCalledTimes(2);
    });
    resolveFirst?.("unknown");
    fireEvent.click(screen.getByRole("button", { name: "新建" }));

    expect(await screen.findByRole("combobox", { name: "上游任务" })).toBeEnabled();
  });

  it.each([
    { contextCapability: "unsupported", mode: "create" },
    { contextCapability: "unknown", mode: "create" },
    { contextCapability: "unsupported", mode: "edit" },
    { contextCapability: "unknown", mode: "edit" },
  ] as const)(
    "keeps ordinary $mode saves on the legacy path when context capability is $contextCapability",
    async ({ contextCapability, mode }) => {
      const initialJob = mode === "edit"
        ? makeCronJob({ id: "ordinary", name: "普通任务" })
        : undefined;
      renderAutomationForm({ mode, initialJob, contextCapability });

      if (mode === "create") {
        fillCreateFields();
      } else {
        fireEvent.change(screen.getByPlaceholderText("请输入自动任务名称"), { target: { value: "普通任务已更新" } });
      }
      fireEvent.click(screen.getByRole("button", { name: mode === "create" ? "新建" : "保存" }));

      if (mode === "create") {
        await waitFor(() => {
          expect(cronClientMocks.createCronJobWithScriptRollback).toHaveBeenCalledTimes(1);
        });
      } else {
        await waitFor(() => {
          expect(cronClientMocks.editCronJob).toHaveBeenCalledWith("bot-1", "ordinary", { name: "普通任务已更新" });
        });
      }
      expect(cronClientMocks.createCronJobWithContextAndScriptRollback).not.toHaveBeenCalled();
      expect(cronClientMocks.editCronJobWithContext).not.toHaveBeenCalled();
    },
  );

  it("uses structured create when an upstream is explicitly selected", async () => {
    const upstream = makeCronJob({ id: "upstream", name: "上游任务 A" });
    const onRefreshJobs = vi.fn().mockResolvedValue([upstream]);
    renderAutomationForm({ jobs: [upstream], onRefreshJobs });

    fillCreateFields();
    chooseUpstream("上游任务 A");
    fireEvent.click(screen.getByRole("button", { name: "新建" }));

    await waitFor(() => {
      expect(cronClientMocks.createCronJobWithContextAndScriptRollback).toHaveBeenCalledWith(
        "bot-1",
        expect.objectContaining({ name: "下游任务", prompt: "整理上游结果" }),
        "upstream",
        undefined,
      );
    });
    expect(onRefreshJobs).toHaveBeenCalledTimes(1);
    expect(cronClientMocks.createCronJobWithScriptRollback).not.toHaveBeenCalled();
  });

  it.each(["create", "edit"] as const)(
    "fails closed when a $mode relationship addition sees an untrusted latest relationship snapshot",
    async (mode) => {
      const upstream = makeCronJob({ id: "upstream", name: "上游任务 A" });
      const unrelated = makeCronJob({ id: "untrusted", name: "关系未知任务", context_from_hydrated: false });
      const downstream = makeCronJob({ id: "downstream", name: "下游任务" });
      const initialJobs = mode === "edit" ? [downstream, upstream] : [upstream];
      const onRefreshJobs = vi.fn().mockResolvedValue([
        ...initialJobs,
        unrelated,
      ]);
      renderAutomationForm({
        mode,
        initialJob: mode === "edit" ? downstream : undefined,
        jobs: initialJobs,
        onRefreshJobs,
      });

      if (mode === "create") fillCreateFields();
      chooseUpstream("上游任务 A");
      fireEvent.click(screen.getByRole("button", { name: mode === "create" ? "新建" : "保存" }));

      expect(await within(screen.getByRole("dialog")).findByRole("alert")).toHaveTextContent(
        "暂时无法确认最新依赖关系，请重试",
      );
      expect(cronClientMocks.createCronJobWithContextAndScriptRollback).not.toHaveBeenCalled();
      expect(cronClientMocks.editCronJobWithContext).not.toHaveBeenCalled();
    },
  );

  it("allows clearing a relationship without requiring a trusted graph snapshot", async () => {
    const upstream = makeCronJob({ id: "upstream", name: "上游任务 A" });
    const downstream = makeCronJob({ id: "downstream", name: "下游任务", context_from: ["upstream"] });
    const onRefreshJobs = vi.fn().mockResolvedValue([
      { ...downstream, context_from_hydrated: false },
      { ...upstream, context_from_hydrated: false },
    ]);
    renderAutomationForm({
      mode: "edit",
      initialJob: downstream,
      jobs: [downstream, upstream],
      onRefreshJobs,
    });

    clearUpstream();
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(cronClientMocks.editCronJobWithContext).toHaveBeenCalledWith("bot-1", "downstream", {}, []);
    });
    expect(onRefreshJobs).not.toHaveBeenCalled();
  });

  it("keeps the legacy edit path when the relationship is unchanged", async () => {
    const upstream = makeCronJob({ id: "upstream", name: "上游任务 A" });
    const downstream = makeCronJob({ id: "downstream", name: "下游任务", context_from: ["upstream"] });
    renderAutomationForm({
      mode: "edit",
      initialJob: downstream,
      jobs: [downstream, upstream],
      onRefreshJobs: vi.fn().mockResolvedValue([downstream, upstream]),
    });

    fireEvent.change(screen.getByPlaceholderText("请输入自动任务名称"), { target: { value: "下游任务已更新" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(cronClientMocks.editCronJob).toHaveBeenCalledWith("bot-1", "downstream", { name: "下游任务已更新" });
    });
    expect(cronClientMocks.editCronJobWithContext).not.toHaveBeenCalled();
  });

  it("allows ordinary edits to preserve an unchanged paused upstream", async () => {
    const pausedUpstream = makeCronJob({ id: "upstream", name: "暂停上游", enabled: false, state: "paused" });
    const downstream = makeCronJob({ id: "downstream", name: "下游任务", context_from: ["upstream"] });
    const onRefreshJobs = vi.fn();
    renderAutomationForm({
      mode: "edit",
      initialJob: downstream,
      jobs: [downstream, pausedUpstream],
      onRefreshJobs,
    });

    fireEvent.change(screen.getByPlaceholderText("请输入自动任务名称"), { target: { value: "下游任务已更新" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(cronClientMocks.editCronJob).toHaveBeenCalledWith("bot-1", "downstream", { name: "下游任务已更新" });
    });
    expect(onRefreshJobs).not.toHaveBeenCalled();
    expect(cronClientMocks.editCronJobWithContext).not.toHaveBeenCalled();
  });

  it("shows a missing single upstream and allows clearing it", async () => {
    const downstream = makeCronJob({ id: "downstream", name: "下游任务", context_from: ["deleted-upstream"] });
    renderAutomationForm({ mode: "edit", initialJob: downstream, jobs: [downstream] });

    expect(screen.getByRole("combobox", { name: "上游任务" })).toHaveTextContent("上游任务已不可用");
    clearUpstream();
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(cronClientMocks.editCronJobWithContext).toHaveBeenCalledWith("bot-1", "downstream", {}, []);
    });
  });

  it.each([
    { actionName: "选择其他上游任务", optionName: "上游任务 B", expectedContext: ["upstream-b"] },
    { actionName: "清除上游任务", optionName: null, expectedContext: [] },
  ])("uses one structured update when the user $actionName", async ({ optionName, expectedContext }) => {
    const upstreamA = makeCronJob({ id: "upstream-a", name: "上游任务 A" });
    const upstreamB = makeCronJob({ id: "upstream-b", name: "上游任务 B" });
    const downstream = makeCronJob({ id: "downstream", name: "下游任务", context_from: ["upstream-a"] });
    const jobs = [downstream, upstreamA, upstreamB];
    renderAutomationForm({
      mode: "edit",
      initialJob: downstream,
      jobs,
      onRefreshJobs: vi.fn().mockResolvedValue(jobs),
    });

    fireEvent.change(screen.getByPlaceholderText(/请用提示词的形式描述/), { target: { value: "更新后的说明" } });
    if (optionName) {
      chooseUpstream(optionName);
    } else {
      clearUpstream();
    }
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(cronClientMocks.editCronJobWithContext).toHaveBeenCalledWith(
        "bot-1",
        "downstream",
        expect.objectContaining({ prompt: "更新后的说明" }),
        expectedContext,
      );
    });
    expect(cronClientMocks.editCronJobWithContext).toHaveBeenCalledTimes(1);
    expect(cronClientMocks.editCronJob).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "paused",
      latestJobs: [makeCronJob({ id: "upstream", name: "上游任务 A", enabled: false })],
      message: "所选上游任务已暂停，请重新选择或解除关联",
    },
    {
      label: "deleted",
      latestJobs: [],
      message: "所选上游任务已删除或过期，请重新选择或解除关联",
    },
  ])("keeps the form open when the selected upstream becomes $label", async ({ latestJobs, message }) => {
    const upstream = makeCronJob({ id: "upstream", name: "上游任务 A" });
    renderAutomationForm({ jobs: [upstream], onRefreshJobs: vi.fn().mockResolvedValue(latestJobs) });

    fillCreateFields();
    chooseUpstream("上游任务 A");
    fireEvent.click(screen.getByRole("button", { name: "新建" }));

    const dialog = screen.getByRole("dialog");
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(message);
    expect(within(dialog).getByText("新建自动任务")).toBeTruthy();
    expect(cronClientMocks.createCronJobWithContextAndScriptRollback).not.toHaveBeenCalled();
  });

  it.each(["create", "edit"] as const)(
    "keeps the $mode form open when the selected upstream effective window ends before save",
    async (mode) => {
      const recurringSchedule = { kind: "cron", expr: "0 9 * * *", display: "每天 09:00" };
      const upstream = makeCronJob({ id: "upstream", name: "上游任务 A", schedule: recurringSchedule });
      const endedUpstream = makeCronJob({
        ...upstream,
        effective_window: { start_at: null, end_at: "2020-01-01T00:00:00+08:00" },
      });
      const downstream = makeCronJob({ id: "downstream", name: "下游任务" });
      const initialJobs = mode === "edit" ? [downstream, upstream] : [upstream];
      const latestJobs = mode === "edit" ? [downstream, endedUpstream] : [endedUpstream];
      const onSaved = vi.fn();
      renderAutomationForm({
        mode,
        initialJob: mode === "edit" ? downstream : undefined,
        jobs: initialJobs,
        onRefreshJobs: vi.fn().mockResolvedValue(latestJobs),
        onSaved,
      });

      if (mode === "create") fillCreateFields();
      chooseUpstream("上游任务 A");
      fireEvent.click(screen.getByRole("button", { name: mode === "create" ? "新建" : "保存" }));

      const dialog = screen.getByRole("dialog");
      expect(await within(dialog).findByRole("alert")).toHaveTextContent(
        "所选上游任务已删除或过期，请重新选择或解除关联",
      );
      expect(within(dialog).getByText(mode === "create" ? "新建自动任务" : "编辑自动任务")).toBeTruthy();
      expect(cronClientMocks.createCronJobWithContextAndScriptRollback).not.toHaveBeenCalled();
      expect(cronClientMocks.editCronJobWithContext).not.toHaveBeenCalled();
      expect(onSaved).not.toHaveBeenCalled();
    },
  );

  it("renders external multi-upstream relationships read-only and preserves them on ordinary saves", async () => {
    const upstreamA = makeCronJob({ id: "upstream-a", name: "上游任务 A" });
    const downstream = makeCronJob({
      id: "downstream",
      name: "下游任务",
      context_from: ["missing-upstream", "upstream-a"],
    });
    const jobs = [downstream, upstreamA];
    renderAutomationForm({
      mode: "edit",
      initialJob: downstream,
      jobs,
      onRefreshJobs: vi.fn().mockResolvedValue(jobs),
    });

    expect(screen.getByText("当前任务配置了多个上游，暂不支持在 LightVela 中编辑")).toBeTruthy();
    expect(screen.getByText("上游任务 A")).toBeTruthy();
    expect(screen.getByText("上游任务已不可用")).toBeTruthy();
    expect(screen.queryByText("missing-upstream")).toBeNull();
    expect(screen.queryByRole("combobox", { name: "上游任务" })).toBeNull();

    fireEvent.change(screen.getByPlaceholderText("请输入自动任务名称"), { target: { value: "外部任务已更新" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(cronClientMocks.editCronJob).toHaveBeenCalledWith("bot-1", "downstream", { name: "外部任务已更新" });
    });
    expect(cronClientMocks.editCronJobWithContext).not.toHaveBeenCalled();
  });

  it("shows the current upstream on cards, task details and recent-run details", async () => {
    const upstream = makeCronJob({
      id: "upstream",
      name: "上游任务 A",
      last_run_at: "2026-08-14T09:00:00+08:00",
      last_status: "ok",
      created_at: "2026-08-13T09:00:00+08:00",
    });
    const downstream = makeCronJob({
      id: "downstream",
      name: "下游任务",
      context_from: ["upstream"],
      created_at: "2026-08-14T09:00:00+08:00",
    });
    cronClientMocks.listCronJobs.mockResolvedValue([downstream, upstream]);
    cronClientMocks.listRecentCronRuns.mockResolvedValue([makeCronRun({ job_id: "downstream", job_name: "下游任务" })]);
    render(createElement(HermesAgentAutomationsPanel, { botId: "bot-1" }));

    expect(await screen.findByText("上游任务：上游任务 A")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "查看" })[0]!);
    expect(screen.getByText(/最近完成时间/)).toBeTruthy();
    expect(screen.getByText("本任务执行时，将使用上游任务最近一次的输出作为上下文。")).toBeTruthy();
    expect(screen.queryByText("本任务执行时，将使用该任务最近一次完成输出作为上下文；不会等待上游当前运行完成。")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));

    fireEvent.click(screen.getByRole("button", { name: "最近执行" }));
    fireEvent.click((await screen.findAllByRole("button", { name: "查看任务详情" }))[0]!);
    expect(screen.getByText("当前关联上游")).toBeTruthy();
    expect(screen.queryByText("本次已使用")).toBeNull();
  });

  it("uses the upstream-task prefix when the configured upstream is unavailable", async () => {
    const downstream = makeCronJob({
      id: "downstream",
      name: "下游任务",
      context_from: ["missing-upstream"],
    });
    cronClientMocks.listCronJobs.mockResolvedValue([downstream]);
    render(createElement(HermesAgentAutomationsPanel, { botId: "bot-1" }));

    expect(await screen.findByText("上游任务：已不可用")).toBeTruthy();
    expect(screen.queryByText("来自：上游任务已不可用")).toBeNull();
  });

  it("shows an unconfigured upstream task in task details", async () => {
    const ordinary = makeCronJob({ id: "ordinary", name: "普通任务" });
    cronClientMocks.listCronJobs.mockResolvedValue([ordinary]);
    render(createElement(HermesAgentAutomationsPanel, { botId: "bot-1" }));

    fireEvent.click(within(await getCronJobCard("普通任务")).getByRole("button", { name: "查看" }));

    const dialog = screen.getByRole("dialog");
    const upstreamLabel = within(dialog).getByText("上游任务");
    const upstreamRow = upstreamLabel.closest("div");
    expect(upstreamRow).not.toBeNull();
    expect(within(upstreamRow!).getByText("未配置")).toBeTruthy();
  });

  it("explains paused upstream history and no-history fallback in task details", async () => {
    const pausedWithHistory = makeCronJob({
      id: "paused-history",
      name: "暂停但有历史",
      enabled: false,
      state: "paused",
      last_run_at: "2026-08-14T09:00:00+08:00",
    });
    const noHistory = makeCronJob({ id: "no-history", name: "暂无历史", last_run_at: null });
    const firstDownstream = makeCronJob({ id: "downstream-a", name: "下游 A", context_from: ["paused-history"] });
    const secondDownstream = makeCronJob({ id: "downstream-b", name: "下游 B", context_from: ["no-history"] });
    cronClientMocks.listCronJobs.mockResolvedValue([firstDownstream, secondDownstream, pausedWithHistory, noHistory]);
    render(createElement(HermesAgentAutomationsPanel, { botId: "bot-1" }));

    fireEvent.click(within(await getCronJobCard("下游 A")).getByRole("button", { name: "查看" }));
    expect(screen.getByText("任务已暂停，但仍可能使用最近一次完成输出")).toBeTruthy();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "关闭" }));

    fireEvent.click(within(await getCronJobCard("下游 B")).getByRole("button", { name: "查看" }));
    expect(screen.getByText("暂无完成记录，下游任务会在无上游上下文的情况下继续执行")).toBeTruthy();
  });
});

describe("cron context dependent deletion", () => {
  it("fails closed when the latest relationship hydration is unavailable", async () => {
    const upstream = makeCronJob({ id: "job-a", name: "上游 A" });
    cronClientMocks.listCronJobs
      .mockResolvedValueOnce([upstream])
      .mockResolvedValueOnce([{ ...upstream, context_from_hydrated: false }]);
    render(createElement(HermesAgentAutomationsPanel, { botId: "bot-1" }));

    fireEvent.click(within(await getCronJobCard("上游 A")).getByRole("button", { name: "删除" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "删除" }));

    expect(await within(screen.getByRole("dialog")).findByRole("alert")).toHaveTextContent("暂时无法确认最新依赖关系，请重试");
    expect(cronClientMocks.removeCronJob).not.toHaveBeenCalled();
    expect(cronClientMocks.removeCronJobWithDependentRollback).not.toHaveBeenCalled();
  });

  it("fails closed when refreshing relationships before deletion fails", async () => {
    const upstream = makeCronJob({ id: "job-a", name: "上游 A" });
    cronClientMocks.listCronJobs
      .mockResolvedValueOnce([upstream])
      .mockRejectedValueOnce(new Error("refresh failed"));
    render(createElement(HermesAgentAutomationsPanel, { botId: "bot-1" }));

    fireEvent.click(within(await getCronJobCard("上游 A")).getByRole("button", { name: "删除" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "删除" }));

    expect(await within(screen.getByRole("dialog")).findByRole("alert")).toHaveTextContent("暂时无法确认最新依赖关系，请重试");
    expect(cronClientMocks.removeCronJob).not.toHaveBeenCalled();
  });

  it("updates a changed dependent preview and requires a second confirmation", async () => {
    const upstream = makeCronJob({ id: "job-a", name: "上游 A" });
    const newDependent = makeCronJob({ id: "job-b", name: "新下游 B", context_from: ["job-a"] });
    cronClientMocks.listCronJobs
      .mockResolvedValueOnce([upstream])
      .mockResolvedValueOnce([upstream, newDependent])
      .mockResolvedValueOnce([upstream, newDependent])
      .mockResolvedValueOnce([{ ...newDependent, context_from: null }]);
    render(createElement(HermesAgentAutomationsPanel, { botId: "bot-1" }));

    fireEvent.click(within(await getCronJobCard("上游 A")).getByRole("button", { name: "删除" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent("任务依赖关系已变化，请确认最新受影响任务后再次删除");
    expect(within(dialog).getByText("新下游 B")).toBeTruthy();
    expect(cronClientMocks.removeCronJobWithDependentRollback).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));
    await waitFor(() => {
      expect(cronClientMocks.removeCronJobWithDependentRollback).toHaveBeenCalledWith("bot-1", "job-a", [{
        id: "job-b",
        name: "新下游 B",
        contextFrom: ["job-a"],
      }]);
    });
  });

  it("previews only direct dependents and deletes through the compensation path", async () => {
    const upstream = makeCronJob({ id: "job-a", name: "上游 A", created_at: "2026-08-14T10:00:00+08:00" });
    const directDependent = makeCronJob({
      id: "job-b",
      name: "直接下游 B",
      context_from: ["job-a"],
      created_at: "2026-08-14T09:00:00+08:00",
    });
    const indirectDependent = makeCronJob({
      id: "job-c",
      name: "间接下游 C",
      context_from: ["job-b"],
      created_at: "2026-08-14T08:00:00+08:00",
    });
    cronClientMocks.listCronJobs
      .mockResolvedValueOnce([upstream, directDependent, indirectDependent])
      .mockResolvedValueOnce([upstream, directDependent, indirectDependent])
      .mockResolvedValueOnce([
        { ...directDependent, context_from: null },
        indirectDependent,
      ]);

    render(createElement(HermesAgentAutomationsPanel, { botId: "bot-1" }));

    fireEvent.click(within(await getCronJobCard("上游 A")).getByRole("button", { name: "删除" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("直接下游 B")).toBeTruthy();
    expect(within(dialog).queryByText("间接下游 C")).toBeNull();
    expect(within(dialog).getByText("删除后将解除上游绑定并继续独立执行")).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));

    await waitFor(() => {
      expect(cronClientMocks.removeCronJobWithDependentRollback).toHaveBeenCalledWith("bot-1", "job-a", [{
        id: "job-b",
        name: "直接下游 B",
        contextFrom: ["job-a"],
      }]);
    });
    expect(cronClientMocks.removeCronJob).not.toHaveBeenCalled();
    expect(await getCronJobCard("直接下游 B")).toBeTruthy();
    expect(await getCronJobCard("间接下游 C")).toHaveTextContent("上游任务：直接下游 B");
    expect(screen.queryByText("上游 A")).toBeNull();
  });

  it("keeps the target and shows mapped task names beside the delete action when detaching fails", async () => {
    const upstream = makeCronJob({ id: "job-a", name: "上游 A", prompt: "PRIVATE PROMPT" });
    const firstDependent = makeCronJob({ id: "job-b", name: "下游 B", context_from: ["job-a"] });
    const failedDependent = makeCronJob({ id: "job-c", name: "下游 C", context_from: ["job-a"] });
    cronClientMocks.listCronJobs.mockResolvedValue([upstream, firstDependent, failedDependent]);
    cronClientMocks.removeCronJobWithDependentRollback.mockRejectedValue(new CronCommandError({
      command: "cronjob dependent removal",
      output: "update_failed:job-c;rollback_failed:job-b",
      status: "CRON_DEPENDENT_MUTATION_FAILED",
      exitCode: 1,
    }));

    render(createElement(HermesAgentAutomationsPanel, { botId: "bot-1" }));

    fireEvent.click(within(await getCronJobCard("上游 A")).getByRole("button", { name: "删除" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "删除" }));

    const dialog = await screen.findByRole("dialog");
    const error = await within(dialog).findByRole("alert");
    expect(error).toHaveTextContent("下游 B");
    expect(error).toHaveTextContent("下游 C");
    expect(error).not.toHaveTextContent("job-b");
    expect(error).not.toHaveTextContent("job-c");
    expect(error).not.toHaveTextContent("PRIVATE PROMPT");
    expect(await getCronJobCard("上游 A")).toBeTruthy();
    expect(cronClientMocks.removeCronJob).not.toHaveBeenCalled();
  });

  it("keeps ordinary deletion on the legacy remove path", async () => {
    const ordinary = makeCronJob({ id: "ordinary", name: "普通任务" });
    cronClientMocks.listCronJobs
      .mockResolvedValueOnce([ordinary])
      .mockResolvedValueOnce([ordinary])
      .mockResolvedValueOnce([]);

    render(createElement(HermesAgentAutomationsPanel, { botId: "bot-1" }));

    fireEvent.click(within(await getCronJobCard("普通任务")).getByRole("button", { name: "删除" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "删除" }));

    await waitFor(() => {
      expect(cronClientMocks.removeCronJob).toHaveBeenCalledWith("bot-1", "ordinary");
    });
    expect(cronClientMocks.removeCronJobWithDependentRollback).not.toHaveBeenCalled();
  });
});

describe("terminal cron card visibility", () => {
  it("names the messaging destination as IM software after starting a test run", async () => {
    const job = makeCronJob({ id: "toast-copy", name: "Toast 文案任务" });
    cronClientMocks.listCronJobs.mockResolvedValue([job]);
    render(createElement(HermesAgentAutomationsPanel, { botId: "bot-1" }));

    fireEvent.click(within(await getCronJobCard(job.name)).getByRole("button", { name: isGlobal ? "Test run" : "测试运行" }));

    expect(await screen.findByText(
      isGlobal
        ? "Running in the background — please check the result in your IM app."
        : "已在后台执行，请在你的 IM 软件中查看运行结果",
    )).toBeTruthy();
  });

  it("shows a past-due one-shot job as running while Hermes is still executing it", async () => {
    const running = makeCronJob({
      id: "running-once",
      name: "cron-3",
      state: "active",
      next_run_at: new Date(Date.now() - 11 * 60_000).toISOString(),
      execution_status: " Running ",
    });
    cronClientMocks.listCronJobs.mockResolvedValue([running]);
    render(createElement(HermesAgentAutomationsPanel, { botId: "bot-1" }));

    const card = await getCronJobCard("cron-3");
    expect(card).toHaveTextContent("执行中");
    expect(card).not.toHaveTextContent("已执行");
  });

  it("shows a failed one-shot as failed during the expiration grace period", async () => {
    const failed = makeCronJob({
      id: "failed-once",
      name: "刚刚运行的任务",
      state: "active",
      next_run_at: new Date(Date.now() - 5 * 60_000).toISOString(),
      execution_status: "failed",
    });
    cronClientMocks.listCronJobs.mockResolvedValue([failed]);
    render(createElement(HermesAgentAutomationsPanel, { botId: "bot-1" }));

    const card = await getCronJobCard("刚刚运行的任务");
    expect(card).toHaveTextContent("执行失败");
    expect(card).not.toHaveTextContent("已执行");
  });

  it("keeps disabled jobs active and moves ended states into their own tab", async () => {
    const active = makeCronJob({ id: "active", name: "生效任务", state: "scheduled" });
    const disabled = makeCronJob({
      id: "disabled",
      name: "停用任务",
      state: "disabled",
      enabled: false,
    });
    const endedStates = ["completed", "error", "done", "expired", "cancelled", "canceled"];
    cronClientMocks.listCronJobs.mockResolvedValue([
      active,
      disabled,
      ...endedStates.map((state) => makeCronJob({
        id: `ended-${state}`,
        name: `结束任务 ${state}`,
        schedule: { kind: "cron", expr: "0 9 * * *", display: "每天 09:00" },
        state,
        enabled: false,
        next_run_at: null,
      })),
      makeCronJob({
        id: "completed-with-failed-run",
        name: "任务结束但执行失败",
        state: "completed",
        execution_status: "failed",
        enabled: false,
        next_run_at: null,
      }),
    ]);

    render(createElement(HermesAgentAutomationsPanel, { botId: "bot-1" }));

    expect(await screen.findByRole("button", { name: "当前任务" })).toBeTruthy();
    expect(await screen.findByText("生效任务")).toBeTruthy();
    expect(screen.getByText("停用任务")).toBeTruthy();
    expect(screen.getByText("已停用")).toBeTruthy();
    const disabledCard = await getCronJobCard("停用任务");
    expect(within(disabledCard).getByRole("button", { name: "恢复" })).toBeTruthy();
    expect(within(disabledCard).queryByRole("button", { name: "暂停" })).toBeNull();
    endedStates.forEach((state) => {
      expect(screen.queryByText(`结束任务 ${state}`)).toBeNull();
    });

    fireEvent.click(screen.getByRole("button", { name: "已结束任务" }));

    expect(screen.queryByText("生效任务")).toBeNull();
    expect(screen.queryByText("停用任务")).toBeNull();
    for (const state of endedStates) {
      expect(await screen.findByText(`结束任务 ${state}`)).toBeTruthy();
    }
    expect(screen.getByText("任务结束但执行失败")).toBeTruthy();
    expect(screen.getAllByText("已完成")).toHaveLength(2);
    expect(screen.getAllByText("执行失败")).toHaveLength(2);
    expect(screen.getByText("已过期")).toBeTruthy();
    expect(screen.getAllByText("已取消")).toHaveLength(2);
    const endedCard = await getCronJobCard("结束任务 completed");
    expect(within(endedCard).queryByRole("button", { name: "恢复" })).toBeNull();
    expect(within(endedCard).queryByRole("button", { name: "暂停" })).toBeNull();
  });

  it("moves an overdue one-shot without a terminal state into ended jobs", async () => {
    const overdue = makeCronJob({
      id: "overdue",
      name: "错过执行时间的任务",
      state: "scheduled",
      next_run_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    });
    cronClientMocks.listCronJobs.mockResolvedValue([overdue]);

    render(createElement(HermesAgentAutomationsPanel, { botId: "bot-1" }));

    expect(await screen.findByRole("button", { name: "已结束任务" })).toBeTruthy();
    expect(screen.queryByText("错过执行时间的任务")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "已结束任务" }));
    expect(await screen.findByText("错过执行时间的任务")).toBeTruthy();
    expect(screen.getByText("已过期")).toBeTruthy();
  });

  it("shows the ended-jobs empty state when only active jobs exist", async () => {
    cronClientMocks.listCronJobs.mockResolvedValue([
      makeCronJob({ id: "active", name: "生效任务", state: "scheduled" }),
    ]);
    render(createElement(HermesAgentAutomationsPanel, { botId: "bot-1" }));

    expect(await screen.findByText("生效任务")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "已结束任务" }));

    expect(await screen.findByText("暂无已结束任务")).toBeTruthy();
    expect(screen.queryByRole("button", { name: isGlobal ? "Create from a template" : "参考模板新建" })).toBeNull();
  });

  it("returns to active jobs after creating from the ended-jobs tab", async () => {
    const ended = makeCronJob({ id: "ended", name: "旧任务", state: "completed" });
    const created = makeCronJob({ id: "created", name: "新任务", state: "scheduled" });
    cronClientMocks.listCronJobs
      .mockResolvedValueOnce([ended])
      .mockResolvedValue([created]);
    render(createElement(HermesAgentAutomationsPanel, { botId: "bot-1" }));

    fireEvent.click(await screen.findByRole("button", { name: "已结束任务" }));
    expect(await screen.findByText("旧任务")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "新建" }));
    fillCreateFields();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "新建" }));

    await waitFor(() => {
      expect(cronClientMocks.createCronJobWithScriptRollback).toHaveBeenCalledTimes(1);
    });
    expect(await screen.findByText("新任务")).toBeTruthy();
    expect(screen.getByRole("button", { name: "当前任务" })).toHaveAttribute("aria-pressed", "true");
  });

  it("returns to active jobs after creating from a template on the ended-jobs tab", async () => {
    const ended = makeCronJob({ id: "ended", name: "旧任务", state: "completed" });
    const created = makeCronJob({ id: "created", name: "模板新任务", state: "scheduled" });
    cronClientMocks.listCronJobs
      .mockResolvedValueOnce([ended])
      .mockResolvedValue([created]);
    render(createElement(HermesAgentAutomationsPanel, { botId: "bot-1" }));

    fireEvent.click(await screen.findByRole("button", { name: "已结束任务" }));
    fireEvent.click(screen.getByRole("button", { name: "模板" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /每日工作小结/ }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "新建" }));

    await waitFor(() => {
      expect(cronClientMocks.createCronJobWithScriptRollback).toHaveBeenCalledTimes(1);
    });
    expect(await screen.findByText("模板新任务")).toBeTruthy();
    expect(screen.getByRole("button", { name: "当前任务" })).toHaveAttribute("aria-pressed", "true");
  });
});

describe("buildScheduleString and parseInitialSchedule", () => {
  it("round-trips daily schedules", () => {
    const schedule = buildScheduleString({
      kind: "recurring",
      period: "daily",
      time: "09:05",
      weekday: 1,
      monthday: 1,
      intervalNum: 1,
      intervalUnit: "h",
      onceDate: "",
    });

    expect(schedule).toBe("5 9 * * *");
    expect(parseInitialSchedule(schedule)).toMatchObject({
      kind: "recurring",
      period: "daily",
      time: "09:05",
    });
  });

  it("uses one minute-level cron job for daily schedules with multiple time points", () => {
    const schedule = buildScheduleString({
      kind: "recurring",
      period: "daily",
      time: "09:00",
      dailyTimes: ["09:00", "12:30"],
      weekday: 1,
      monthday: 1,
      intervalNum: 1,
      intervalUnit: "h",
      onceDate: "",
    });

    expect(schedule).toBe("* * * * *");
  });

  it("keeps daily time form edits in input order", () => {
    expect(normalizeDailyTimesForForm(["01:06", "14:06"], "01:06")).toEqual(["01:06", "14:06"]);
    expect(normalizeDailyTimesForForm(["14:06", "01:06"], "14:06")).toEqual(["14:06", "01:06"]);
  });

  it("keeps daily time edits within valid clock bounds", () => {
    expect(normalizeDailyTimesForEditing(["01:06", "", "14:06"], "01:06")).toEqual(["01:06", "01:06", "14:06"]);
    expect(normalizeDailyTimesForForm(["01:06", "", "14:06"], "01:06")).toEqual(["01:06", "14:06"]);
  });

  it("normalizes partial and out-of-range daily time drafts while editing", () => {
    expect(sanitizeClockTimeDraft("ab12:3x")).toBe("12:3");
    expect(normalizeDailyTimesForEditing(["01:06", "1", "12:", "12:3", "19:99", "99:99"], "01:06")).toEqual([
      "01:06",
      "01:06",
      "12:06",
      "12:03",
      "19:59",
      "23:59",
    ]);
    expect(normalizeDailyTimesForForm(["01:06", "1", "12:", "12:3"], "01:06")).toEqual(["01:06"]);
  });

  it("round-trips weekly and monthly schedules", () => {
    expect(parseInitialSchedule(buildScheduleString({
      kind: "recurring",
      period: "weekly",
      time: "18:30",
      weekdays: [1, 3, 5],
      monthday: 1,
      intervalNum: 1,
      intervalUnit: "h",
      onceDate: "",
    }))).toMatchObject({ kind: "recurring", period: "weekly", time: "18:30", weekday: 1, weekdays: [1, 3, 5] });

    // 单日 weekly 也需 round-trip：避免 buildScheduleString 单元素分支退化
    expect(parseInitialSchedule(buildScheduleString({
      kind: "recurring",
      period: "weekly",
      time: "09:00",
      weekdays: [3],
      monthday: 1,
      intervalNum: 1,
      intervalUnit: "h",
      onceDate: "",
    }))).toMatchObject({ kind: "recurring", period: "weekly", time: "09:00", weekday: 3, weekdays: [3] });

    const monthlySchedule = buildScheduleString({
      kind: "recurring",
      period: "monthly",
      time: "07:00",
      weekday: 1,
      monthday: 28,
      intervalNum: 1,
      intervalUnit: "h",
      onceDate: "",
    });
    expect(monthlySchedule).toBe("0 7 28 * *");
    expect(parseInitialSchedule(monthlySchedule)).toMatchObject({
      kind: "recurring",
      period: "monthly",
      time: "07:00",
      monthday: 28,
      monthdays: [28],
    });
  });

  it("round-trips monthly schedules with multiple days", () => {
    const schedule = buildScheduleString({
      kind: "recurring",
      period: "monthly",
      time: "09:00",
      weekdays: [1],
      monthdays: [14, 6, 7],
      intervalNum: 1,
      intervalUnit: "h",
      onceDate: "",
    });

    expect(schedule).toBe("0 9 6,7,14 * *");
    expect(parseInitialSchedule(schedule)).toMatchObject({
      kind: "recurring",
      period: "monthly",
      time: "09:00",
      monthday: 6,
      monthdays: [6, 7, 14],
    });
  });

  it("round-trips interval and once schedules", () => {
    expect(parseInitialSchedule(buildScheduleString({
      kind: "interval",
      period: "daily",
      time: "09:00",
      weekday: 1,
      monthday: 1,
      intervalNum: 5,
      intervalUnit: "m",
      onceDate: "",
    }))).toMatchObject({ kind: "interval", intervalNum: 5, intervalUnit: "m" });

    expect(parseInitialSchedule(buildScheduleString({
      kind: "once",
      period: "daily",
      time: "09:00",
      weekday: 1,
      monthday: 1,
      intervalNum: 1,
      intervalUnit: "h",
      onceDate: "2026-05-26T22:09",
    }))).toMatchObject({ kind: "once", onceDate: "2026-05-26T22:09" });
  });

  it("does not coerce unsupported cron expressions into editable defaults", () => {
    expect(parseInitialSchedule("*/5 * * * *")).toBeNull();
    expect(parseInitialSchedule("0 9 * * 1-5")).toBeNull();
    expect(parseInitialSchedule("0 9-18 * * *")).toBeNull();
  });

  it("parses comma-separated weekly cron weekdays", () => {
    expect(parseInitialSchedule("0 9 * * 1,3,4,5,6,0")).toMatchObject({
      kind: "recurring",
      period: "weekly",
      time: "09:00",
      weekday: 1,
      weekdays: [1, 3, 4, 5, 6, 0],
    });
  });

  it("treats cron weekday 7 as Sunday (0)", () => {
    expect(parseInitialSchedule("0 9 * * 7")).toMatchObject({
      kind: "recurring",
      period: "weekly",
      time: "09:00",
      weekdays: [0],
    });
  });
});

describe("parseInitialDeliver", () => {
  it("treats empty and local deliver targets as no notification", () => {
    expect(parseInitialDeliver("")).toEqual({ platforms: [], chatIds: {} });
    expect(parseInitialDeliver("local")).toEqual({ platforms: [], chatIds: {} });
  });

  it("parses platform list and chat ids", () => {
    expect(parseInitialDeliver("weixin:wx_123,feishu:oc_123,qqbot:qq_123")).toEqual({
      platforms: ["weixin", "feishu", "qqbot"],
      chatIds: { weixin: "wx_123", feishu: "oc_123", qqbot: "qq_123" },
    });
  });

  it("preserves origin and unknown deliver targets as passthrough platforms", () => {
    expect(parseInitialDeliver("origin:oc_123,telegram:tg_123,weixin")).toEqual({
      platforms: ["origin", "telegram", "weixin"],
      chatIds: { origin: "oc_123", telegram: "tg_123" },
    });
  });

  it("round-trips chat ids for every supported platform", () => {
    const deliver = "weixin:wx_123,qqbot:qq_123,feishu:oc_123,slack:C123,origin:oc_origin";
    const parsed = parseInitialDeliver(deliver);

    expect(buildDeliverString(parsed.platforms, parsed.chatIds)).toBe(deliver);
  });

  it("omits chat ids for unchecked platforms", () => {
    const parsed = parseInitialDeliver("weixin:wx_123,qqbot:qq_123,feishu:oc_123");

    expect(buildDeliverString(["weixin", "feishu"], parsed.chatIds)).toBe("weixin:wx_123,feishu:oc_123");
  });
});

describe("buildHermesSendTestCommand", () => {
  it("uses the platform home target when chat id is empty", () => {
    expect(buildHermesSendTarget("feishu", "")).toBe("feishu");
    expect(buildHermesSendTarget("slack", "")).toBe("slack");
    expect(buildHermesSendTestCommand("feishu", "", "deploy finished")).toContain(
      "hermes send --to 'feishu' 'deploy finished'",
    );
    expect(buildHermesSendTestCommand("slack", "", "deploy finished")).toContain(
      "hermes send --to 'slack' 'deploy finished'",
    );
  });

  it("uses platform:chat_id target when chat id is provided", () => {
    expect(buildHermesSendTarget("feishu", " oc_123 ")).toBe("feishu:oc_123");
    expect(buildHermesSendTestCommand("feishu", "oc_123", "it's ready")).toContain(
      "hermes send --to 'feishu:oc_123' 'it'\\''s ready'",
    );
  });

  it("trusts the hermes send exit code instead of grepping natural-language output", () => {
    const command = buildHermesSendTestCommand("qqbot", "", "上次 failed 原因已修复");

    expect(command).toContain("status=$?");
    expect(command).toContain("if [ $status -ne 0 ]; then exit $status; fi");
    expect(command).not.toContain("grep -Eiq");
  });

  it("keeps stderr redirection outside hermes send arguments", () => {
    const command = buildHermesSendCommand("qqbot", "", "测试消息");

    expect(command).toContain("output=$(hermes send --to 'qqbot' '测试消息' 2>&1)");
    expect(command).not.toContain("'2>&1'");
  });
});

describe("parseEnabledHermesChannels", () => {
  const channelStatusPayload = JSON.stringify({
    success: true,
    data: {
      platforms: [
        { name: "weixin", status: "connected" },
        { name: "qqbot", status: "disconnected" },
        { name: "feishu", status: "connected" },
      ],
    },
    error: null,
  });

  it("parses pure acli channel status json", () => {
    expect(parseEnabledHermesChannels(channelStatusPayload)).toEqual(new Set(["weixin", "feishu"]));
  });

  it("normalizes wechat aliases to the weixin notification key", () => {
    const output = JSON.stringify({
      success: true,
      data: {
        platforms: [
          { name: "wechat", status: "connected" },
          { name: "openclaw-weixin", status: "connected" },
        ],
      },
      error: null,
    });

    expect(parseEnabledHermesChannels(output)).toEqual(new Set(["weixin"]));
  });

  it("normalizes the OpenClaw DingTalk alias to the dingtalk notification key", () => {
    const output = JSON.stringify({
      success: true,
      data: {
        platforms: [
          { name: "openclaw-dingtalk", status: "connected" },
        ],
      },
      error: null,
    });

    expect(parseEnabledHermesChannels(output)).toEqual(new Set(["dingtalk"]));
  });

  it("normalizes international channel aliases to notification keys", () => {
    const output = JSON.stringify({
      success: true,
      data: {
        platforms: [
          { name: "openclaw-telegram", status: "connected" },
          { name: "whatsapp-business", status: "ready" },
          { name: "openclaw-discord", status: "enabled" },
          { name: "openclaw-slack", status: "connected" },
          { name: "openclaw-wecom", status: "connected" },
          { name: "openclaw-lark", status: "running" },
          { name: "openclaw-qq", status: "connected" },
        ],
      },
      error: null,
    });

    expect(parseEnabledHermesChannels(output)).toEqual(new Set(["telegram", "whatsapp", "discord", "slack", "wecom", "feishu", "qqbot"]));
  });

  it("parses object-shaped channel status payloads", () => {
    const output = JSON.stringify({
      success: true,
      data: {
        channels: {
          "openclaw-telegram": { enabled: true },
          "openclaw-whatsapp": "connected",
          "openclaw-discord": false,
        },
      },
      error: null,
    });

    expect(parseEnabledHermesChannels(output)).toEqual(new Set(["telegram", "whatsapp"]));
  });
});

describe("isHermesNotificationChannelConfigured", () => {
  it("keeps channels visible until the connected status is known", () => {
    expect(isHermesNotificationChannelConfigured(null, "feishu")).toBe(true);
  });

  it("uses the loaded enabled-channel set when channel status is known", () => {
    const enabledChannels = new Set(["weixin"]);

    expect(isHermesNotificationChannelConfigured(enabledChannels, "weixin")).toBe(true);
    expect(isHermesNotificationChannelConfigured(enabledChannels, "feishu")).toBe(false);
  });

  it("keeps coming-soon channels disabled even when status is unknown", () => {
    expect(isHermesNotificationChannelConfigured(null, "telegram", true)).toBe(false);
  });
});

describe("automation notification channel options", () => {
  it("shows the domestic empty state when no notification channel is configured", () => {
    if (isGlobal) return;
    renderAutomationForm({
      enabledChannels: new Set(),
      channelStatus: "ready",
    });

    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.getByText("暂无已配置的通知通道。")).toBeTruthy();
    expect(screen.getByRole("link", { name: "前往通道配置" })).toHaveAttribute("href", "/agents/channels/");
    expect(screen.queryByText("如不选，智能体只会在后台执行任务，不发通知。")).toBeNull();
  });

  it("shows only configured domestic channels including DingTalk", () => {
    if (isGlobal) return;
    renderAutomationForm({
      enabledChannels: new Set(["dingtalk", "feishu"]),
      channelStatus: "ready",
    });

    expect(screen.getByRole("checkbox", { name: "钉钉" })).toBeEnabled();
    expect(screen.getByRole("checkbox", { name: "飞书" })).toBeEnabled();
    expect(screen.queryByRole("checkbox", { name: "微信" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "QQ" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "企业微信" })).toBeNull();
    expect(screen.getByText("如不选，智能体只会在后台执行任务，不发通知。")).toBeTruthy();
  });

  it("renders all configured domestic channels in the required order", () => {
    if (isGlobal) return;
    renderAutomationForm({
      enabledChannels: new Set(["weixin", "qqbot", "wecom", "feishu", "dingtalk"]),
      channelStatus: "ready",
    });

    expect(screen.getAllByRole("checkbox").map((checkbox) => checkbox.closest("label")?.textContent?.trim())).toEqual([
      "微信",
      "QQ",
      "企业微信",
      "飞书",
      "钉钉",
    ]);
  });

  it("hides the background-only hint in the global channel empty state", () => {
    if (!isGlobal) return;
    renderAutomationForm({
      enabledChannels: new Set(),
      channelStatus: "ready",
    });

    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.getByText("No channels configured.")).toBeTruthy();
    expect(screen.queryByText("No notification channels are configured yet.")).toBeNull();
    expect(screen.queryByText(
      "If none are selected, the agent will only run the job in the background without sending notifications.",
    )).toBeNull();
    expect(screen.getByRole("link", { name: "Configure channels" })).toHaveAttribute("href", "/agents/channels/");
  });

  it("keeps the background-only hint when a global channel is available", () => {
    if (!isGlobal) return;
    renderAutomationForm({
      enabledChannels: new Set(["telegram"]),
      channelStatus: "ready",
    });

    expect(screen.getByRole("checkbox", { name: "Telegram" })).toBeEnabled();
    expect(screen.getByText(
      "If none are selected, the agent will only run the job in the background without sending notifications.",
    )).toBeTruthy();
  });
});

describe("formatTestSendError", () => {
  it("hides unrecognized raw send failures behind actionable copy", () => {
    expect(formatTestSendError(
      new Error("hermes send: Weixin session is unavailable"),
      "发送失败，请先在微信中向 Hermes Agent 发送任意消息，或稍后重试",
    )).toBe("发送失败，请先在微信中向 Hermes Agent 发送任意消息，或稍后重试");
  });

  it("translates common English command errors", () => {
    expect(formatTestSendError(new Error("Command timed out"), "发送失败，请检查通道配置或稍后重试"))
      .toBe("发送失败，请检查通道配置或稍后重试：命令执行超时");
    expect(formatTestSendError(new Error("Unknown platform: wechat"), "发送失败，请检查通道配置或稍后重试"))
      .toBe("发送失败，请检查通道配置或稍后重试：未知通知通道：wechat");
  });

  it("extracts the real stderr from debug exec failure summaries", () => {
    expect(formatTestSendError(
      new Error("status=FAILED exit_code=1 stderr=Unknown platform: telegram"),
      "发送失败，请检查通道配置或稍后重试",
    )).toBe("发送失败，请检查通道配置或稍后重试：未知通知通道：telegram");
  });

  it("formats common command errors in English when an English translator is provided", () => {
    const t = ((text: string, vars?: Record<string, unknown>) => {
      const translations: Record<string, string> = {
        "命令执行超时": "Command timed out",
        "未知通知通道：{{platform}}": "Unknown notification channel: {{platform}}",
        "实例内命令执行权限不足": "Insufficient permission to run commands in the instance",
      };
      const template = translations[text] ?? text;
      if (!vars) return template;
      return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => String(vars[key] ?? ""));
    });

    expect(formatTestSendError(
      new Error("Unknown platform: telegram"),
      "Failed to send. Please check the channel configuration or try again later.",
      t,
    )).toBe("Failed to send. Please check the channel configuration or try again later: Unknown notification channel: telegram");
  });

  it("hides low-level missing-command details from users", () => {
    expect(formatTestSendError(new Error("hermes: command not found"), "发送失败，请检查通道配置或稍后重试"))
      .toBe("发送失败，请检查通道配置或稍后重试");
  });
});

describe("getTestSendFailureFallback", () => {
  it("uses the more specific Weixin home-channel hint for weixin aliases", () => {
    expect(getTestSendFailureFallback("weixin", "通用失败", "微信失败")).toBe("微信失败");
    expect(getTestSendFailureFallback("wechat", "通用失败", "微信失败")).toBe("微信失败");
  });

  it("keeps the generic fallback for other platforms", () => {
    expect(getTestSendFailureFallback("feishu", "通用失败", "微信失败")).toBe("通用失败");
  });

  it("uses the more specific WeCom home-channel hint for wecom aliases when provided", () => {
    expect(getTestSendFailureFallback("wecom", "通用失败", "微信失败", "企微失败")).toBe("企微失败");
    expect(getTestSendFailureFallback("wework", "通用失败", "微信失败", "企微失败")).toBe("企微失败");
    expect(getTestSendFailureFallback("openclaw-wecom", "通用失败", "微信失败", "企微失败")).toBe("企微失败");
  });

  it("falls back to the generic message for wecom when no wecom-specific hint is provided", () => {
    expect(getTestSendFailureFallback("wecom", "通用失败", "微信失败")).toBe("通用失败");
  });
});

describe("cron date parsing and expiration filtering", () => {
  it("parses timezone-less cron dates as local time explicitly", () => {
    const parsed = parseCronDate("2026-05-26T09:00:00.471081");

    expect(parsed.getTime()).toBe(new Date(2026, 4, 26, 9, 0, 0, 471).getTime());
  });

  it("keeps explicit timezone cron dates on their absolute instant", () => {
    const parsed = parseCronDate("2026-05-26T09:00:00.471081+08:00");

    expect(parsed.getTime()).toBe(new Date("2026-05-26T09:00:00.471+08:00").getTime());
  });

  it("parses once display fallback as local display time", () => {
    const parsed = parseOnceScheduleDate("once at 2026-05-26 09:00", null);

    expect(parsed.getTime()).toBe(new Date(2026, 4, 26, 9, 0).getTime());
  });

  it("does not hide once jobs from display-only fallback dates", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-26T10:05:00+08:00"));

    expect(isCronJobExpiredBeyondGrace(makeCronJob({ next_run_at: null }))).toBe(false);
    expect(isCronJobExpiredBeyondGrace(makeCronJob({ next_run_at: "2026-05-26T09:00:00+08:00" }))).toBe(true);
  });

  it("keeps recently expired once jobs visible during the grace window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-26T10:05:00+08:00"));

    expect(isCronJobExpiredBeyondGrace(makeCronJob({ next_run_at: "2026-05-26T09:56:00+08:00" }))).toBe(false);
    expect(isCronJobExpiredBeyondGrace(makeCronJob({ next_run_at: "2026-05-26T09:54:00+08:00" }))).toBe(true);
  });
});

describe("schedule labels", () => {
  const t = ((text: string, vars?: Record<string, unknown>) => {
    if (!vars) return text;
    return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => String(vars[key] ?? ""));
  }) as Parameters<typeof formatScheduleTooltip>[1];

  it("prefixes interval schedule hover labels with the schedule mode", () => {
    expect(formatScheduleTooltip(makeCronJob({
      schedule: { kind: "interval", expr: "every 1h", display: "every 1h" },
    }), t)).toBe("按间隔 · 每 1 小时");
  });

  it("prefixes recurring schedule hover labels with the schedule mode", () => {
    expect(formatScheduleTooltip(makeCronJob({
      schedule: { kind: "cron", expr: "51 10 * * *", display: "51 10 * * *" },
    }), t)).toBe("周期 · 每天 10:51");
  });

  it("formats LightVela daily time metadata as one recurring task label", () => {
    expect(formatScheduleTooltip(makeCronJob({
      schedule: { kind: "cron", expr: "* * * * *", display: "* * * * *" },
      lightvela_schedule: { kind: "daily_times", times: ["09:00", "12:30"] },
    }), t)).toBe("周期 · 每天 09:00、12:30");
  });

  it("keeps one-time schedule hover labels unchanged", () => {
    expect(formatScheduleTooltip(makeCronJob({
      schedule: { kind: "once", expr: "once at 2026-05-26 09:00", display: "once at 2026-05-26 09:00" },
    }), t)).toBe("单次 2026-05-26 09:00");
  });
});

describe("effective window helpers", () => {
  const now = new Date(2026, 5, 15, 9, 0).getTime();

  it("treats an empty effective window as always active", () => {
    expect(buildEffectiveWindowFromInputs("", "")).toBeNull();
    expect(getEffectiveWindowStatus(null, now)).toBe("always");
  });

  it("builds weekday-only gates for interval schedules", () => {
    expect(buildEffectiveWindowFromInputs("", "", [5, 6, 0])).toEqual({
      start_at: null,
      end_at: null,
      weekdays: [5, 6, 0],
    });
    expect(getEffectiveWindowStatus({ start_at: null, end_at: null, weekdays: [5, 6, 0] }, now)).toBe("active");
  });

  it("omits open-ended date placeholders for weekday-only labels", () => {
    const t = ((text: string) => text) as Parameters<typeof formatEffectiveWindow>[1];

    expect(formatEffectiveWindow({ start_at: null, end_at: null, weekdays: [5, 6, 0] }, t))
      .toBe("生效中 · 执行日：周五、周六、周日");
  });

  it("formats detail modal effective periods without repeating weekdays", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-08T12:30:00+08:00"));

    const t = ((text: string) => text) as Parameters<typeof formatEffectiveWindowPeriod>[1];

    expect(formatEffectiveWindowPeriod({
      start_at: "2026-06-08T08:00",
      end_at: "2026-06-08T11:02",
      weekdays: [2, 3, 4, 5, 6, 0],
    }, t)).toBe("2026-06-08 08:00 - 2026-06-08 11:02 · 已过生效期");

    expect(formatEffectiveWindowPeriod(null, t)).toBe("未配置（即始终生效）");
  });

  it("splits configured dates and weekdays across tooltip lines", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-08T09:00:00+08:00"));

    const t = ((text: string) => text) as Parameters<typeof formatEffectiveWindowTooltipLines>[1];

    expect(formatEffectiveWindowTooltipLines({
      start_at: "2026-06-08T08:00",
      end_at: "2026-06-08T11:02",
      weekdays: [2, 3, 4, 5, 6, 0],
    }, t)).toEqual([
      "执行日：周二、周三、周四、周五、周六、周日",
      "生效期：2026-06-08 08:00 - 2026-06-08 11:02 · 生效中",
    ]);
  });

  it("normalizes date-time values from either space or T separators", () => {
    expect(normalizeEffectiveWindowInput("2026-06-10 08:30")).toBe("2026-06-10T08:30");
    expect(normalizeEffectiveWindowInput("2026-06-10T08:30")).toBe("2026-06-10T08:30");
  });

  it("reports pending, active and ended windows without mutating the job", () => {
    expect(getEffectiveWindowStatus({ start_at: "2026-06-16T00:00", end_at: "2026-06-20T00:00" }, now)).toBe("pending");
    expect(getEffectiveWindowStatus({ start_at: "2026-06-10T00:00", end_at: "2026-06-20T00:00" }, now)).toBe("active");
    expect(getEffectiveWindowStatus({ start_at: "2026-06-10T00:00", end_at: "2026-06-14T23:59" }, now)).toBe("ended");
  });

  it("rejects an end time earlier than the start time", () => {
    expect(isEffectiveWindowRangeInvalid({
      start_at: "2026-06-20T00:00",
      end_at: "2026-06-10T00:00",
    })).toBe(true);
  });
});

describe("getLastAgentRunForJob", () => {
  it("uses the latest filtered Agent run instead of Hermes last_run_at", () => {
    const job = makeCronJob({
      id: "job-1",
      last_run_at: "2026-06-06T14:20:37+08:00",
      last_status: "ok",
    });
    const olderAgentRun = makeCronRun({
      job_id: "job-1",
      run_at: "2026-06-06T12:20:37+08:00",
    });
    const latestAgentRun = makeCronRun({
      job_id: "job-1",
      run_at: "2026-06-06T13:20:37+08:00",
    });

    expect(getLastAgentRunForJob(job, [olderAgentRun, latestAgentRun])?.run_at)
      .toBe("2026-06-06T13:20:37+08:00");
  });

  it("localizes DingTalk in task details", async () => {
    const job = makeCronJob({ id: "dingtalk-job", name: "钉钉通知任务", deliver: "dingtalk" });
    cronClientMocks.listCronJobs.mockResolvedValue([job]);
    render(createElement(HermesAgentAutomationsPanel, { botId: "bot-1" }));

    fireEvent.click(within(await getCronJobCard("钉钉通知任务")).getByRole("button", { name: "查看" }));
    const dialog = screen.getByRole("dialog");
    const notificationRow = within(dialog).getByText("通知方式").closest("div");
    expect(notificationRow).not.toBeNull();
    expect(within(notificationRow!).getByText("钉钉")).toBeTruthy();
    expect(within(notificationRow!).queryByText("dingtalk")).toBeNull();
  });

  it("returns null when no confirmed Agent run is available for the job", () => {
    expect(getLastAgentRunForJob(makeCronJob({ id: "job-1" }), [
      makeCronRun({ job_id: "other-job" }),
    ])).toBeNull();
  });
});

describe("once schedule validation", () => {
  const now = new Date(2026, 4, 26, 10, 0).getTime();

  it("rejects creating a once task in the past", () => {
    expect(shouldRejectPastOnceSchedule(makeScheduleCheck({
      mode: "create",
      onceDate: "2026-05-26T09:59",
      schedule: "2026-05-26T09:59",
      now,
    }))).toBe(true);
  });

  it("allows editing an unchanged once task even if its time is already past", () => {
    expect(shouldRejectPastOnceSchedule(makeScheduleCheck({
      mode: "edit",
      onceDate: "2026-05-26T09:59",
      initialOnceDate: "2026-05-26T09:59",
      schedule: "2026-05-26T09:59",
      originalSchedule: "once at 2026-05-26 09:59",
      now,
    }))).toBe(false);
  });

  it("rejects editing a once task to an earlier past time", () => {
    expect(shouldRejectPastOnceSchedule(makeScheduleCheck({
      mode: "edit",
      onceDate: "2026-05-26T09:58",
      initialOnceDate: "2026-05-26T09:59",
      schedule: "2026-05-26T09:58",
      originalSchedule: "once at 2026-05-26 09:59",
      now,
    }))).toBe(true);
  });

  it("allows editing a once task to a future time", () => {
    expect(shouldRejectPastOnceSchedule(makeScheduleCheck({
      mode: "edit",
      onceDate: "2026-05-26T10:10",
      initialOnceDate: "2026-05-26T09:59",
      schedule: "2026-05-26T10:10",
      originalSchedule: "once at 2026-05-26 09:59",
      now,
    }))).toBe(false);
  });
});

function renderAutomationForm(overrides: Partial<Parameters<typeof AutomationFormModal>[0]> = {}) {
  const defaultJobs = [makeCronJob({ id: "upstream", name: "上游任务 A" })];
  const props: Parameters<typeof AutomationFormModal>[0] = {
    botId: "bot-1",
    mode: "create",
    jobs: defaultJobs,
    contextCapability: "supported",
    onRetryContextCapability: vi.fn(),
    enabledChannels: new Set(),
    channelStatus: "ready",
    skillLoadState: { status: "ready", slugs: [], error: null },
    onRefreshJobs: vi.fn().mockResolvedValue(defaultJobs),
    onRefreshSkills: vi.fn().mockResolvedValue({ status: "ready", slugs: [], error: null }),
    onClose: vi.fn(),
    onSaved: vi.fn(),
    onError: vi.fn(),
    testState: "idle",
    onTestRun: vi.fn(),
    ...overrides,
  };
  return render(createElement(AutomationFormModal, props));
}

describe("automation form test run", () => {
  it("test-runs the current unsaved create form without saving it", () => {
    if (isGlobal) return;
    const onTestRun = vi.fn();
    const onSaved = vi.fn();
    renderAutomationForm({
      onTestRun,
      onSaved,
      enabledChannels: new Set(["wecom"]),
      skillLoadState: { status: "ready", slugs: ["news"], error: null },
    });

    fireEvent.change(screen.getByPlaceholderText("请输入自动任务名称"), { target: { value: "未保存名称" } });
    fireEvent.change(screen.getByPlaceholderText(/请用提示词的形式描述/), { target: { value: "未保存说明" } });
    chooseUpstream("上游任务 A");
    fireEvent.click(screen.getByRole("button", { name: "调用技能" }));
    fireEvent.click(screen.getByRole("option", { name: /news/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /企业微信/ }));
    fireEvent.click(screen.getByRole("button", { name: "测试运行" }));

    expect(onTestRun).toHaveBeenCalledWith(expect.objectContaining({
      name: "未保存名称",
      prompt: "未保存说明",
      skills: ["news"],
      deliver: "wecom",
      context_from: ["upstream"],
      script: "",
      effective_window: null,
    }));
    expect(onSaved).not.toHaveBeenCalled();
    expect(cronClientMocks.createCronJobWithContextAndScriptRollback).not.toHaveBeenCalled();
    expect(cronClientMocks.createCronJobWithScriptRollback).not.toHaveBeenCalled();
    expect(screen.getByText("新建自动任务")).toBeInTheDocument();
  });

  it("test-runs unsaved edit values and keeps save separate", () => {
    const onTestRun = vi.fn();
    const onSaved = vi.fn();
    renderAutomationForm({
      mode: "edit",
      initialJob: makeCronJob({
        id: "edit-job",
        name: "旧名称",
        prompt: "旧说明",
        script: "lightvela-effective-window-edit-job.py",
        effective_window: { start_at: "2026-01-01T00:00:00+08:00", end_at: "2026-12-31T23:59:59+08:00" },
        lightvela_schedule: { kind: "daily_times", times: ["09:00", "18:00"] },
      }),
      onTestRun,
      onSaved,
    });

    fireEvent.change(screen.getByDisplayValue("旧名称"), { target: { value: "编辑中的名称" } });
    fireEvent.change(screen.getByDisplayValue("旧说明"), { target: { value: "编辑中的说明" } });
    fireEvent.click(screen.getByRole("button", { name: /测试运行|Test run/ }));

    expect(onTestRun).toHaveBeenCalledWith(expect.objectContaining({
      id: "edit-job",
      name: "编辑中的名称",
      prompt: "编辑中的说明",
      script: "",
      effective_window: null,
      lightvela_schedule: null,
    }));
    expect(onSaved).not.toHaveBeenCalled();
    expect(cronClientMocks.editCronJob).not.toHaveBeenCalled();
    expect(cronClientMocks.editCronJobWithContext).not.toHaveBeenCalled();
  });

  it("disables form test run while required fields are empty", () => {
    renderAutomationForm();
    expect(screen.getByRole("button", { name: /测试运行|Test run/ })).toBeDisabled();
  });

  it("explains why an editable historical task cannot be test-run without a prompt", () => {
    renderAutomationForm({
      mode: "edit",
      initialJob: makeCronJob({ id: "edit-job", name: "历史任务", prompt: "" }),
    });

    const testButton = screen.getByRole("button", { name: /测试运行|Test run/ });
    expect(testButton).toBeDisabled();
    expect(testButton).toHaveAccessibleDescription("请先填写名称和任务说明");
    expect(testButton.parentElement).toHaveAttribute("title", "请先填写名称和任务说明");
    expect(screen.getByRole("button", { name: "保存" })).toBeEnabled();
  });

  it("shows the form test run as busy while it is starting", () => {
    renderAutomationForm({
      mode: "edit",
      initialJob: makeCronJob({ id: "edit-job", name: "草稿", prompt: "执行草稿" }),
      testState: "running",
    });
    const button = screen.getByRole("button", { name: /测试运行|Test run/ });
    expect(button).toBeDisabled();
    expect(button.querySelector(".animate-spin")).not.toBeNull();
  });
});

describe("automation form test-state wiring", () => {
  it.each(["blank", "template"] as const)(
    "shows the running state in the %s create form while the test job is starting",
    async (entry) => {
      cronClientMocks.startCronTestRun.mockImplementationOnce(() => new Promise(() => {}));
      render(createElement(HermesAgentAutomationsPanel, { botId: "bot-1" }));

      if (entry === "blank") {
        fireEvent.click(await screen.findByRole("button", { name: "新建" }));
        fillCreateFields();
      } else {
        fireEvent.click(await screen.findByRole("button", { name: "模板" }));
        fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /每日工作小结/ }));
      }

      const testButton = within(screen.getByRole("dialog")).getByRole("button", { name: "测试运行" });
      fireEvent.click(testButton);

      await waitFor(() => {
        expect(testButton).toBeDisabled();
        expect(testButton.querySelector(".animate-spin")).not.toBeNull();
      });
    },
  );
});

describe("automation notification channel options", () => {
  it("keeps the domestic empty-state guard", () => {
    if (isGlobal) return;
    renderAutomationForm({ enabledChannels: new Set(), channelStatus: "ready" });

    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.getByText("暂无已配置的通知通道。")).toBeTruthy();
    expect(screen.getByRole("link", { name: "前往通道配置" })).toHaveAttribute("href", "/agents/channels/");
  });

  it("sends a creation notice to every selected target and surfaces partial failures without undoing the save", async () => {
    const onSaved = vi.fn();
    const onError = vi.fn();
    cronClientMocks.sendHermesChatNotice.mockResolvedValue({ sent: 1, failed: 1 });
    renderAutomationForm({
      enabledChannels: new Set(["qqbot", "wecom"]),
      onSaved,
      onError,
    });

    fillCreateFields("  下游任务  ");
    fireEvent.click(screen.getByRole("checkbox", { name: "QQ" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "企业微信" }));
    fireEvent.click(screen.getByRole("button", { name: "新建" }));

    await waitFor(() => {
      expect(cronClientMocks.createCronJobWithScriptRollback).toHaveBeenCalledWith(
        "bot-1",
        expect.objectContaining({ name: "下游任务", deliver: "qqbot,wecom" }),
        undefined,
      );
    });
    expect(onSaved).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(cronClientMocks.sendHermesChatNotice).toHaveBeenCalledWith(
        "bot-1",
        "qqbot,wecom",
        "LightVela 已新建自动任务「下游任务」。",
      );
      expect(onError).toHaveBeenCalledWith("自动任务已新建，但部分通知通道发送确认消息失败。");
    });
  });

  it("does not send a creation notice when the new task has no notification target", async () => {
    const onSaved = vi.fn();
    renderAutomationForm({ onSaved });

    fillCreateFields();
    fireEvent.click(screen.getByRole("button", { name: "新建" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(cronClientMocks.sendHermesChatNotice).not.toHaveBeenCalled();
  });

  it("keeps the task saved and warns when the immediate notice request rejects unexpectedly", async () => {
    const onSaved = vi.fn();
    const onError = vi.fn();
    cronClientMocks.sendHermesChatNotice.mockRejectedValue(new Error("transport unavailable"));
    renderAutomationForm({
      enabledChannels: new Set(["qqbot"]),
      onSaved,
      onError,
    });

    fillCreateFields();
    fireEvent.click(screen.getByRole("checkbox", { name: "QQ" }));
    fireEvent.click(screen.getByRole("button", { name: "新建" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      expect(onError).toHaveBeenCalledWith("自动任务已新建，但部分通知通道发送确认消息失败。");
    });
  });

  it("does not send a creation notice when editing an existing task", async () => {
    const onSaved = vi.fn();
    renderAutomationForm({
      mode: "edit",
      initialJob: makeCronJob({ deliver: "qqbot" }),
      enabledChannels: new Set(["qqbot"]),
      onSaved,
    });

    fireEvent.change(screen.getByPlaceholderText("请输入自动任务名称"), { target: { value: "已编辑任务" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(cronClientMocks.sendHermesChatNotice).not.toHaveBeenCalled();
  });
});

function fillCreateFields(name = "下游任务") {
  fireEvent.change(screen.getByPlaceholderText("请输入自动任务名称"), { target: { value: name } });
  fireEvent.change(screen.getByPlaceholderText(/请用提示词的形式描述/), { target: { value: "整理上游结果" } });
}

function chooseUpstream(optionName: string) {
  fireEvent.click(screen.getByRole("combobox", { name: "上游任务" }));
  fireEvent.click(screen.getByRole("option", { name: new RegExp(optionName) }));
}

function clearUpstream() {
  fireEvent.click(screen.getByRole("button", { name: "取消选择" }));
}

async function getCronJobCard(jobName: string): Promise<HTMLElement> {
  const name = await screen.findByText(jobName);
  const card = name.closest("div.flex.flex-col.rounded-md");
  if (!(card instanceof HTMLElement)) throw new Error(`Cron job card not found: ${jobName}`);
  return card;
}

function makeScheduleCheck(overrides: Partial<Parameters<typeof shouldRejectPastOnceSchedule>[0]>): Parameters<typeof shouldRejectPastOnceSchedule>[0] {
  return {
    mode: "edit",
    scheduleUneditable: false,
    kind: "once",
    onceDate: "2026-05-26T10:10",
    initialOnceDate: "2026-05-26T09:59",
    schedule: "2026-05-26T10:10",
    originalSchedule: "2026-05-26T09:59",
    now: new Date(2026, 4, 26, 10, 0).getTime(),
    ...overrides,
  };
}

function makeCronJob(overrides: Partial<CronJob>): CronJob {
  return {
    id: "job-1",
    name: "提醒",
    prompt: "提醒我喝水",
    schedule: { kind: "once", expr: "once at 2026-05-26 09:00", display: "once at 2026-05-26 09:00" },
    skills: [],
    enabled: true,
    state: "",
    deliver: "local",
    next_run_at: null,
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

function makeCronRun(overrides: Partial<CronRunRecord>): CronRunRecord {
  return {
    id: "run-1",
    job_id: "job-1",
    job_name: "提醒",
    job_prompt: "提醒我喝水",
    skills: [],
    schedule: { kind: "cron", expr: "0 9 * * *", display: "0 9 * * *" },
    deliver: "local",
    run_at: "2026-06-06T09:00:00+08:00",
    status: "ok",
    output_path: "/home/agentuser/.hermes/cron/output/job-1/run.md",
    ...overrides,
  };
}
