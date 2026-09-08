import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildEffectiveWindowScript,
  buildDetectCronContextFromCapabilityCommand,
  buildCronjobToolCommand,
  buildCreateCommand,
  buildEditCommand,
  buildTestRunMarker,
  buildZeroTokenScript,
  createCronJob,
  createCronJobWithContextAndScriptRollback,
  createCronJobWithScriptRollback,
  detectCronContextFromCapability,
  execCommand,
  execCommandStream,
  editCronJobWithContext,
  listCronJobs,
  listRecentCronRuns,
  normalizeCronContextFrom,
  parseCronjobToolOutput,
  parseCronRunFilesOutput,
  parseCronContextCapabilityOutput,
  parseEffectiveWindowScript,
  parseLightVelaCronScript,
  parseZeroTokenScript,
  parseCronListOutput,
  pickFallbackChannelFromStatusOutput,
  removeCronJobWithDependentRollback,
  removeManagedCronScriptIfUnreferenced,
  runCronJob,
  runCronJobAsTest,
  startCronTestRun,
  shellQuote,
  splitLastRunValue,
  type CronJob,
} from "../hermes-cron-client";
import { AUTH_UNAUTHORIZED_EVENT, writeStoredAuthToken } from "@/repositories/http-repositories";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  writeStoredAuthToken(null);
});

describe("parseCronListOutput", () => {
  it("splits last run timestamp and inline status from Hermes output", () => {
    const jobs = parseCronListOutput(`
  6e8b6fc74896 [active]
    Name:      pablo测试
    Schedule:  every 5m
    Next run:  2026-05-26T22:32:22+08:00
    Last run:  2026-05-26T22:25:31.471081+08:00 ok
    Deliver:   feishu: oc_ff2babafce5bfc575b03a8adcdfa6b1c
`);

    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.last_run_at).toBe("2026-05-26T22:25:31.471081+08:00");
    expect(jobs[0]?.last_status).toBe("ok");
  });

  it("parses the attached script field when Hermes lists it", () => {
    const jobs = parseCronListOutput(`
  6e8b6fc74896 [active]
    Name:      生效区间任务
    Schedule:  every 5m
    Script:    lightvela-effective-window-job-1.py
`);

    expect(jobs[0]?.script).toBe("lightvela-effective-window-job-1.py");
  });

  it("parses empty list output as no jobs", () => {
    expect(parseCronListOutput("No scheduled jobs. Create one with hermes cron create")).toEqual([]);
  });

  it("keeps unknown fields and missing prompt safe", () => {
    const jobs = parseCronListOutput(`
  abcdef123456 [paused]
    Name:      复杂任务
    Schedule:  */5 * * * *
    Deliver:   origin
`);

    expect(jobs[0]).toMatchObject({
      id: "abcdef123456",
      name: "复杂任务",
      prompt: "",
      enabled: false,
      schedule: { kind: "", expr: "*/5 * * * *", display: "*/5 * * * *" },
      deliver: "origin",
    });
  });

  it.each([["completed", true], ["disabled", false]] as const)("parses the enabled flag for the %s state", (state, enabled) => {
    const jobs = parseCronListOutput(`
  abcdef123456 [${state}]
    Name:      终态任务
    Schedule:  every 2h
`);

    expect(jobs[0]).toMatchObject({ state, enabled });
  });
});

describe("normalizeCronContextFrom", () => {
  it("normalizes strings and preserves unique non-empty upstream ids", () => {
    expect(normalizeCronContextFrom(" job-a ")).toEqual(["job-a"]);
    expect(normalizeCronContextFrom(["job-a", "", "job-a", "job-b"])).toEqual(["job-a", "job-b"]);
  });

  it("returns null for empty or unsupported values", () => {
    expect(normalizeCronContextFrom([])).toBeNull();
    expect(normalizeCronContextFrom({ job: "job-a" })).toBeNull();
  });
});

describe("cron context_from capability detection", () => {
  it("parses supported, unsupported, and unknown capability markers", () => {
    expect(parseCronContextCapabilityOutput('LIGHTVELA_CRON_CONTEXT_CAPABILITY={"supported":true}')).toBe("supported");
    expect(parseCronContextCapabilityOutput('LIGHTVELA_CRON_CONTEXT_CAPABILITY={"supported":false}')).toBe("unsupported");
    expect(parseCronContextCapabilityOutput("noise")).toBe("unknown");
  });

  it("builds an inspection command in the Hermes virtual environment", () => {
    const command = buildDetectCronContextFromCapabilityCommand();

    expect(command).toContain('cd "$HOME/.hermes/hermes-agent"');
    expect(command).toContain("inspect.signature(cronjob)");
    expect(command).toContain("context_from");
    expect(command).toContain("./venv/bin/python");
  });

  it("returns unknown when the capability command cannot execute", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(failedExec("cannot import cronjob")));

    await expect(detectCronContextFromCapability("bot-1")).resolves.toBe("unknown");
  });
});

describe("cronjob structured tool wrapper", () => {
  it("serializes the complete update payload for the official cronjob tool", () => {
    const command = buildCronjobToolCommand({
      action: "update",
      job_id: "job-b",
      context_from: ["job-a"],
    });

    expect(command).toContain('cd "$HOME/.hermes/hermes-agent"');
    expect(command).toContain("./venv/bin/python");
    expect(command).toContain("from tools.cronjob_tools import cronjob");
    expect(command).toContain("payload = json.loads(");
    expect(command).toContain("context_from");
    expect(command).toContain("LIGHTVELA_CRON_CONTEXT_RESULT=");
    expect(command).not.toContain("cronjob(action=");
  });

  it("parses the last successful result marker", () => {
    expect(parseCronjobToolOutput([
      'LIGHTVELA_CRON_CONTEXT_RESULT={"success":false}',
      'LIGHTVELA_CRON_CONTEXT_RESULT={"success":true,"job":{"id":"job-b"}}',
    ].join("\n"))).toMatchObject({ success: true, job: { id: "job-b" } });
  });

  it("parses the official create result with a top-level job_id", () => {
    expect(parseCronjobToolOutput(
      'LIGHTVELA_CRON_CONTEXT_RESULT={"success":true,"job_id":"job-official","name":"daily digest"}',
    )).toMatchObject({ success: true, job_id: "job-official" });
  });

  it.each([
    ['LIGHTVELA_CRON_CONTEXT_RESULT={"success":false,"error":"rejected"}'],
    ["noise without marker"],
    ["LIGHTVELA_CRON_CONTEXT_RESULT={not-json}"],
  ])("rejects unsuccessful or invalid tool output", (output) => {
    expect(() => parseCronjobToolOutput(output)).toThrow();
  });
});

describe("cronjob structured create and update", () => {
  it("uses the official top-level job_id result and pins that exact id", async () => {
    const commands: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const command = String((JSON.parse(String(init?.body ?? "{}")) as { command?: string }).command ?? "");
      commands.push(command);
      if (command.includes("from tools.cronjob_tools import cronjob")) {
        return okExec('LIGHTVELA_CRON_CONTEXT_RESULT={"success":true,"job_id":"job-official","name":"daily digest"}');
      }
      if (command.includes("cat ~/.hermes/cron/jobs.json")) {
        return okExec(JSON.stringify([{ id: "job-official", provider: "openrouter", model: "deepseek-chat" }]));
      }
      if (command === "hermes cron edit 'job-official' --model 'openrouter/deepseek-chat'") return okExec("");
      if (command.includes("lightvela-jobs-meta.json")) return okExec("");
      return failedExec(`unexpected command: ${command}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(createCronJobWithContextAndScriptRollback("bot-1", {
      schedule: "0 8 * * *",
      prompt: "write digest",
      name: "daily digest",
      pinCurrentModel: true,
    }, "job-a")).resolves.toBe("job-official");

    expect(commands).toContain("hermes cron edit 'job-official' --model 'openrouter/deepseek-chat'");
  });

  it("creates a related job and pins the returned job id without forwarding pinCurrentModel", async () => {
    const commands: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const command = String((JSON.parse(String(init?.body ?? "{}")) as { command?: string }).command ?? "");
      commands.push(command);
      if (command.includes("from tools.cronjob_tools import cronjob")) {
        return okExec('LIGHTVELA_CRON_CONTEXT_RESULT={"success":true,"job":{"id":"job-new"}}');
      }
      if (command.includes("cat ~/.hermes/cron/jobs.json")) {
        return okExec(JSON.stringify([{ id: "job-new", provider: "openrouter", model: "deepseek-chat" }]));
      }
      if (command === "hermes cron edit 'job-new' --model 'openrouter/deepseek-chat'") return okExec("");
      if (command.includes("lightvela-jobs-meta.json")) return okExec("");
      return failedExec(`unexpected command: ${command}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(createCronJobWithContextAndScriptRollback("bot-1", {
      schedule: "0 8 * * *",
      prompt: "write digest",
      name: "daily digest",
      skills: ["news"],
      deliver: "local",
      pinCurrentModel: true,
    }, "job-a")).resolves.toBe("job-new");

    const createCommand = commands.find((command) => command.includes("from tools.cronjob_tools import cronjob"));
    expect(createCommand).toContain('\\"action\\":\\"create\\"');
    expect(createCommand).toContain('\\"context_from\\":[\\"job-a\\"]');
    expect(createCommand).toContain('\\"skills\\":[\\"news\\"]');
    expect(createCommand).not.toContain("pinCurrentModel");
    expect(commands).toContain("hermes cron edit 'job-new' --model 'openrouter/deepseek-chat'");
  });

  it.each([
    ['LIGHTVELA_CRON_CONTEXT_RESULT={"success":true}'],
    ['LIGHTVELA_CRON_CONTEXT_RESULT={"success":true,"job_id":"   "}'],
    ['LIGHTVELA_CRON_CONTEXT_RESULT={"success":true,"job_id":123}'],
  ])("rejects a missing or invalid created job id without leaking output", async (output) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(okExec(output)));

    await expect(createCronJobWithContextAndScriptRollback("bot-1", {
      schedule: "0 8 * * *",
      prompt: "private prompt",
      name: "daily digest",
    }, "job-a")).rejects.toThrow("missing created job id");
  });

  it("keeps undefined context on CLI and uses structured update for replace and clear", async () => {
    const commands: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const command = String((JSON.parse(String(init?.body ?? "{}")) as { command?: string }).command ?? "");
      commands.push(command);
      return command.includes("from tools.cronjob_tools import cronjob")
        ? okExec('LIGHTVELA_CRON_CONTEXT_RESULT={"success":true,"job":{"id":"job-b"}}')
        : okExec("");
    });
    vi.stubGlobal("fetch", fetchMock);

    await editCronJobWithContext("bot-1", "job-b", { name: "B2" }, undefined);
    await editCronJobWithContext("bot-1", "job-b", { prompt: "new prompt", skills: ["news"] }, ["job-a"]);
    await editCronJobWithContext("bot-1", "job-b", { deliver: "local" }, []);

    expect(commands[0]).toBe("hermes cron edit 'job-b' --name 'B2'");
    expect(commands[1]).toContain('\\"action\\":\\"update\\"');
    expect(commands[1]).toContain('\\"job_id\\":\\"job-b\\"');
    expect(commands[1]).toContain('\\"context_from\\":[\\"job-a\\"]');
    expect(commands[1]).toContain('\\"prompt\\":\\"new prompt\\"');
    expect(commands[1]).toContain('\\"skills\\":[\\"news\\"]');
    expect(commands[2]).toContain('\\"context_from\\":[]');
  });

  it("removes a prepared LightVela script when related create fails", async () => {
    const script = "lightvela-effective-window-job-2.py";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(okExec('LIGHTVELA_CRON_CONTEXT_RESULT={"success":false,"error":"rejected"}'))
      .mockResolvedValueOnce(okExec(""));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createCronJobWithContextAndScriptRollback("bot-1", {
      schedule: "0 8 * * *",
      prompt: "private prompt",
      name: "daily digest",
      script,
    }, "job-a", script)).rejects.toThrow("cronjob operation failed");

    const cleanupBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as { command: string };
    expect(cleanupBody.command).toBe("rm -f ~/.hermes/scripts/lightvela-effective-window-job-2.py");
  });

  it("sanitizes structured exec failures without exposing prompts or command output", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(failedExec("PRIVATE OUTPUT: private prompt")));

    const error = await createCronJobWithContextAndScriptRollback("bot-1", {
      schedule: "0 8 * * *",
      prompt: "private prompt",
      name: "daily digest",
    }, "job-a").then(() => null, (reason: unknown) => reason);

    expect(error).toBeInstanceOf(Error);
    const record = error as { message?: string; command?: string; output?: string };
    expect(record.message).not.toContain("private prompt");
    expect(record.command).not.toContain("private prompt");
    expect(record.output).not.toContain("PRIVATE OUTPUT");
  });
});

describe("cronjob dependent removal compensation", () => {
  const dependents = [
    { id: "job-b", name: "B", contextFrom: ["job-a"] },
    { id: "job-c", name: "C", contextFrom: ["job-x", "job-a"] },
  ] as const;

  it("detaches every direct dependent before removing the target", async () => {
    const commands: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const command = String((JSON.parse(String(init?.body ?? "{}")) as { command?: string }).command ?? "");
      commands.push(command);
      return okExec('LIGHTVELA_CRON_CONTEXT_RESULT={"success":true}');
    }));

    await removeCronJobWithDependentRollback("bot-1", "job-a", dependents);

    expect(commands).toHaveLength(3);
    expect(commands[0]).toContain('\\"job_id\\":\\"job-b\\"');
    expect(commands[0]).toContain('\\"context_from\\":[]');
    expect(commands[1]).toContain('\\"job_id\\":\\"job-c\\"');
    expect(commands[1]).toContain('\\"context_from\\":[\\"job-x\\"]');
    expect(commands[2]).toContain('\\"action\\":\\"remove\\"');
    expect(commands[2]).toContain('\\"job_id\\":\\"job-a\\"');
  });

  it("restores earlier dependents in reverse order when a later detach fails", async () => {
    const commands: string[] = [];
    const responses = [
      okExec('LIGHTVELA_CRON_CONTEXT_RESULT={"success":true}'),
      okExec('LIGHTVELA_CRON_CONTEXT_RESULT={"success":false,"error":"detach failed"}'),
      okExec('LIGHTVELA_CRON_CONTEXT_RESULT={"success":true}'),
    ];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const command = String((JSON.parse(String(init?.body ?? "{}")) as { command?: string }).command ?? "");
      commands.push(command);
      return responses[commands.length - 1];
    }));

    await expect(removeCronJobWithDependentRollback("bot-1", "job-a", dependents))
      .rejects.toThrow("job-c");

    expect(commands).toHaveLength(3);
    expect(commands[2]).toContain('\\"job_id\\":\\"job-b\\"');
    expect(commands[2]).toContain('\\"context_from\\":[\\"job-a\\"]');
    expect(commands.some((command) => command.includes('\\"action\\":\\"remove\\"'))).toBe(false);
  });

  it("restores every dependent in reverse order when target removal fails", async () => {
    const commands: string[] = [];
    const responses = [
      okExec('LIGHTVELA_CRON_CONTEXT_RESULT={"success":true}'),
      okExec('LIGHTVELA_CRON_CONTEXT_RESULT={"success":true}'),
      okExec('LIGHTVELA_CRON_CONTEXT_RESULT={"success":false,"error":"remove failed"}'),
      okExec('LIGHTVELA_CRON_CONTEXT_RESULT={"success":true}'),
      okExec('LIGHTVELA_CRON_CONTEXT_RESULT={"success":true}'),
    ];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const command = String((JSON.parse(String(init?.body ?? "{}")) as { command?: string }).command ?? "");
      commands.push(command);
      return responses[commands.length - 1];
    }));

    await expect(removeCronJobWithDependentRollback("bot-1", "job-a", dependents))
      .rejects.toThrow("job-a");

    expect(commands).toHaveLength(5);
    expect(commands[3]).toContain('\\"job_id\\":\\"job-c\\"');
    expect(commands[3]).toContain('\\"context_from\\":[\\"job-x\\",\\"job-a\\"]');
    expect(commands[4]).toContain('\\"job_id\\":\\"job-b\\"');
    expect(commands[4]).toContain('\\"context_from\\":[\\"job-a\\"]');
  });

  it("reports rollback task ids without including task names or tool output", async () => {
    const responses = [
      okExec('LIGHTVELA_CRON_CONTEXT_RESULT={"success":true}'),
      okExec('LIGHTVELA_CRON_CONTEXT_RESULT={"success":false,"error":"PRIVATE OUTPUT"}'),
      okExec('LIGHTVELA_CRON_CONTEXT_RESULT={"success":false,"error":"PRIVATE ROLLBACK OUTPUT"}'),
    ];
    let index = 0;
    vi.stubGlobal("fetch", vi.fn(async () => responses[index++]));

    const error = await removeCronJobWithDependentRollback("bot-1", "job-a", dependents)
      .then(() => null, (reason: unknown) => reason);

    expect(error).toBeInstanceOf(Error);
    const message = error instanceof Error ? error.message : "";
    expect(message).toContain("job-b");
    expect(message).toContain("job-c");
    expect(message).not.toContain("PRIVATE");
    expect(message).not.toContain("B");
    expect(message).not.toContain("C");
  });
});

describe("shellQuote", () => {
  it("wraps regular arguments in single quotes", () => {
    expect(shellQuote("hello world")).toBe("'hello world'");
  });

  it("escapes embedded single quotes for shell safety", () => {
    expect(shellQuote("it's ok")).toBe("'it'\\''s ok'");
  });
});

describe("splitLastRunValue", () => {
  it("splits ISO timestamp and status", () => {
    expect(splitLastRunValue("2026-05-26T22:25:31.471081+08:00 ok")).toEqual({
      lastRunAt: "2026-05-26T22:25:31.471081+08:00",
      lastStatus: "ok",
    });
  });

  it("returns null status when there is no inline status", () => {
    expect(splitLastRunValue("2026-05-26T22:25:31Z")).toEqual({
      lastRunAt: "2026-05-26T22:25:31Z",
      lastStatus: null,
    });
  });
});

describe("parseCronRunFilesOutput", () => {
  it("maps recent output files to cron job names", () => {
    const runs = parseCronRunFilesOutput(JSON.stringify([{
      job_id: "job-1",
      run_at: "2026-06-06T01:00:00+00:00",
      output_path: "/home/agentuser/.hermes/cron/output/job-1/2026-06-06T01-00-00.md",
      mtime_ms: 1780707600000,
    }]), [{
      id: "job-1",
      name: "Morning sync",
      prompt: "Check overnight alerts.",
      schedule: { kind: "cron", expr: "0 9 * * *", display: "0 9 * * *" },
      skills: ["builder-radar"],
      enabled: true,
      state: "scheduled",
      deliver: "local",
      next_run_at: null,
      last_run_at: "2026-06-06T01:00:00+00:00",
      last_status: "ok",
      created_at: null,
      script: "",
      effective_window: null,
      lightvela_schedule: null,
      context_from: null,
      inference_config: null,
    }]);

    expect(runs).toEqual([{
      id: "job-1:/home/agentuser/.hermes/cron/output/job-1/2026-06-06T01-00-00.md",
      job_id: "job-1",
      job_name: "Morning sync",
      job_prompt: "Check overnight alerts.",
      skills: ["builder-radar"],
      schedule: { kind: "cron", expr: "0 9 * * *", display: "0 9 * * *" },
      deliver: "local",
      run_at: "2026-06-06T01:00:00+00:00",
      status: "ok",
      output_path: "/home/agentuser/.hermes/cron/output/job-1/2026-06-06T01-00-00.md",
    }]);
  });

  it("uses historical job metadata for completed one-shot jobs", () => {
    const runs = parseCronRunFilesOutput(JSON.stringify([{
      job_id: "once-1",
      run_at: "2026-06-06T02:20:16+00:00",
      output_path: "/home/agentuser/.hermes/cron/output/once-1/2026-06-06T02-20-16.md",
      mtime_ms: 1780712416000,
      job_name: "One shot reminder",
      job_prompt: "Remind me once.",
      job_skills: ["reminder"],
      job_schedule: "once at 2026-06-06 10:20",
      job_deliver: "local",
      job_last_run_at: "2026-06-06T02:20:16+00:00",
      job_last_status: "ok",
    }]), []);

    expect(runs[0]).toMatchObject({
      job_id: "once-1",
      job_name: "One shot reminder",
      job_prompt: "Remind me once.",
      skills: ["reminder"],
      schedule: { kind: "once", expr: "once at 2026-06-06 10:20", display: "once at 2026-06-06 10:20" },
      deliver: "local",
      status: "ok",
    });
  });

  it("carries the 0 Token subtype into recent runs", () => {
    const zeroTokenConfig = {
      kind: "fixed_notification" as const,
      language: "python" as const,
      content: "该喝水了",
      managed: true,
      editable: true,
    };
    const runs = parseCronRunFilesOutput(JSON.stringify([{
      job_id: "water-1",
      run_at: "2026-06-06T01:00:00+00:00",
      output_path: "/home/agentuser/.hermes/cron/output/water-1/run.md",
      mtime_ms: 1780707600000,
    }]), [{
      id: "water-1",
      name: "喝水提醒",
      prompt: "",
      schedule: { kind: "cron", expr: "0 9 * * *", display: "0 9 * * *" },
      skills: [],
      enabled: true,
      state: "scheduled",
      deliver: "local",
      next_run_at: null,
      last_run_at: "2026-06-06T01:00:00+00:00",
      last_status: "ok",
      created_at: null,
      script: "lightvela-zero-token-water.py",
      effective_window: null,
      lightvela_schedule: null,
      context_from: null,
      inference_config: { provider: null, model: null, no_agent: true },
      zero_token_config: zeroTokenConfig,
    }]);

    expect(runs[0]?.zero_token_config).toEqual(zeroTokenConfig);
  });

  it("restores an archived 0 Token subtype without storing its content", () => {
    const runs = parseCronRunFilesOutput(JSON.stringify([{
      job_id: "archived-water",
      run_at: "2026-06-06T01:00:00+00:00",
      output_path: "/home/agentuser/.hermes/cron/output/archived-water/run.md",
      mtime_ms: 1780707600000,
      job_no_agent: true,
      job_script: "lightvela-zero-token-water.py",
      job_zero_token_kind: "fixed_notification",
      job_zero_token_language: "python",
    }]), []);

    expect(runs[0]?.zero_token_config).toEqual({
      kind: "fixed_notification",
      language: "python",
      content: null,
      managed: false,
      editable: false,
    });
  });

  it("uses output status when a completed one-shot job no longer has last_status", () => {
    const runs = parseCronRunFilesOutput(JSON.stringify([{
      job_id: "once-2",
      run_at: "2026-06-06T04:45:14+00:00",
      output_path: "/home/agentuser/.hermes/cron/output/once-2/2026-06-06T04-45-14.md",
      mtime_ms: 1780721114000,
      job_name: "One shot nap",
      job_schedule: "once at 2026-06-06 12:45",
      output_status: "ok",
    }]), []);

    expect(runs[0]?.status).toBe("ok");
  });

  it("preserves failed output status for removed one-shot jobs", () => {
    const runs = parseCronRunFilesOutput(JSON.stringify([{
      job_id: "once-failed",
      run_at: "2026-06-06T04:45:14+00:00",
      output_path: "/home/agentuser/.hermes/cron/output/once-failed/2026-06-06T04-45-14.md",
      mtime_ms: 1780721114000,
      output_status: "failed",
    }]), []);

    expect(runs[0]?.status).toBe("failed");
  });

  it("presents inference config drift as an unexecuted run while preserving the task name", () => {
    const modelDriftError = "error: RuntimeError: Skipped to prevent unintended spend: global inference config drifted since this job was created (model 'kimi-k2.5' -> 'glm-5-turbo'), and this job is unpinned. No inference call was made.";
    const runs = parseCronRunFilesOutput(JSON.stringify([{
      job_id: "hourly-summary",
      run_at: "2026-07-16T03:29:33+00:00",
      output_path: "/home/agentuser/.hermes/cron/output/hourly-summary/2026-07-16T03-29-33.md",
      mtime_ms: 1784172573000,
      job_name: "每日工作小结",
      job_prompt: "请帮我回顾今天的工作进展。",
      job_last_run_at: "2026-07-16T03:29:33+00:00",
      job_last_status: modelDriftError,
      output_status: "ok",
    }]), []);

    expect(runs[0]).toMatchObject({
      job_name: "每日工作小结",
      job_prompt: "请帮我回顾今天的工作进展。",
      status: "not_executed",
      skip_reason: "model_changed",
    });
  });

  it("does not relabel older successful runs when only the latest run hit model drift", () => {
    const modelDriftError = "error: RuntimeError: Skipped to prevent unintended spend: global inference config drifted since this job was created.";
    const runs = parseCronRunFilesOutput(JSON.stringify([{
      job_id: "hourly-summary",
      run_at: "2026-07-16T02:29:24+00:00",
      output_path: "/home/agentuser/.hermes/cron/output/hourly-summary/2026-07-16T02-29-24.md",
      mtime_ms: 1784168964000,
      output_status: "ok",
    }]), [{
      id: "hourly-summary",
      name: "每日工作小结",
      prompt: "请帮我回顾今天的工作进展。",
      schedule: { kind: "cron", expr: "0 * * * *", display: "0 * * * *" },
      skills: [],
      enabled: true,
      state: "scheduled",
      deliver: "local",
      next_run_at: null,
      last_run_at: "2026-07-16T03:29:33+00:00",
      last_status: modelDriftError,
      created_at: null,
      script: "",
      effective_window: null,
      lightvela_schedule: null,
      context_from: null,
      inference_config: null,
    }]);

    expect(runs[0]).toMatchObject({
      job_name: "每日工作小结",
      status: "ok",
    });
    expect(runs[0]).not.toHaveProperty("skip_reason");
  });

  it("filters scheduler attempts skipped before waking the Agent", () => {
    const runs = parseCronRunFilesOutput(JSON.stringify([
      {
        job_id: "skipped-window",
        run_at: "2026-06-06T14:20:37+00:00",
        output_path: "/home/agentuser/.hermes/cron/output/skipped-window/2026-06-06T14-20-37.md",
        mtime_ms: 1780755637000,
        output_status: "ok",
        agent_skipped: true,
      },
      {
        job_id: "agent-ran",
        run_at: "2026-06-06T14:10:37+00:00",
        output_path: "/home/agentuser/.hermes/cron/output/agent-ran/2026-06-06T14-10-37.md",
        mtime_ms: 1780755037000,
        output_status: "ok",
      },
    ]), []);

    expect(runs.map((run) => run.job_id)).toEqual(["agent-ran"]);
  });

  it("returns an empty list for missing or invalid output", () => {
    expect(parseCronRunFilesOutput("", [])).toEqual([]);
    expect(parseCronRunFilesOutput("not json", [])).toEqual([]);
  });
});

describe("buildCreateCommand", () => {
  it("quotes schedule, prompt, name and deliver target", () => {
    expect(buildCreateCommand({
      schedule: "every 5m",
      prompt: "remind me it's time",
      name: "drink water",
      deliver: "feishu:oc_123",
    })).toBe("hermes cron create 'every 5m' 'remind me it'\\''s time' --name 'drink water' --deliver 'feishu:oc_123'");
  });

  it("omits local deliver because Hermes treats it as the default", () => {
    expect(buildCreateCommand({
      schedule: "0 9 * * *",
      prompt: "hello",
      name: "morning",
      deliver: "local",
    })).toBe("hermes cron create '0 9 * * *' 'hello' --name 'morning'");
  });

  it("attaches an official cron pre-run script when provided", () => {
    expect(buildCreateCommand({
      schedule: "0 9 * * *",
      prompt: "hello",
      name: "morning",
      script: "lightvela-effective-window-job-1.py",
    })).toBe("hermes cron create '0 9 * * *' 'hello' --name 'morning' --script 'lightvela-effective-window-job-1.py'");
  });

  it("attaches one selected Skill slug", () => {
    expect(buildCreateCommand({
      schedule: "0 9 * * *",
      prompt: "summarize news",
      name: "morning news",
      skills: ["finance-news"],
    })).toBe("hermes cron create '0 9 * * *' 'summarize news' --name 'morning news' --skill 'finance-news'");
  });

  it("creates a script-only job without prompt, Skill, or model flags", () => {
    expect(buildCreateCommand({
      schedule: "every 30m",
      name: "disk watchdog",
      script: "lightvela-zero-token-job-1.py",
      noAgent: true,
      skills: ["must-not-leak"],
      pinCurrentModel: true,
      deliver: "wecom",
    })).toBe(
      "hermes cron create 'every 30m' --no-agent --script 'lightvela-zero-token-job-1.py' --name 'disk watchdog' --deliver 'wecom'",
    );
  });

  it("does not inspect or pin a model after creating a no-agent job", async () => {
    const commands: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const command = String((JSON.parse(String(init?.body ?? "{}")) as { command?: string }).command ?? "");
      commands.push(command);
      return okExec(command.startsWith("hermes cron create") ? "Created job" : "");
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(createCronJob("bot-1", {
      schedule: "every 30m",
      name: "disk watchdog",
      script: "lightvela-zero-token-job-1.py",
      noAgent: true,
      pinCurrentModel: true,
    })).resolves.toBeUndefined();

    expect(commands[0]).toBe(
      "hermes cron create 'every 30m' --no-agent --script 'lightvela-zero-token-job-1.py' --name 'disk watchdog'",
    );
    expect(commands).not.toContain("cat ~/.hermes/cron/jobs.json 2>/dev/null || echo ''");
    expect(commands.some((command) => command.startsWith("hermes cron edit") && command.includes("--model")))
      .toBe(false);
  });

  it("rejects a no-agent job without a script", () => {
    expect(() => buildCreateCommand({
      schedule: "every 30m",
      name: "broken watchdog",
      noAgent: true,
    })).toThrow("no-agent cron job requires a script");
  });
});

describe("buildEditCommand", () => {
  it("leaves the Skill list untouched when the patch omits skills", () => {
    expect(buildEditCommand("job-1", { name: "daily" })).toBe(
      "hermes cron edit 'job-1' --name 'daily'",
    );
  });

  it("replaces the Skill list and shell-quotes every slug", () => {
    expect(buildEditCommand("job-1", { skills: ["report's-helper"] })).toBe(
      "hermes cron edit 'job-1' --skill 'report'\\''s-helper'",
    );
  });

  it("keeps Hermes repeated --skill compatibility", () => {
    expect(buildEditCommand("job-1", { skills: ["first", "second"] })).toBe(
      "hermes cron edit 'job-1' --skill 'first' --skill 'second'",
    );
  });

  it("clears the Skill list only when an empty array is explicit", () => {
    expect(buildEditCommand("job-1", { skills: [] })).toBe(
      "hermes cron edit 'job-1' --clear-skills",
    );
  });
});

describe("effective window script", () => {
  it("round-trips LightVela window metadata", () => {
    const script = buildEffectiveWindowScript({
      start_at: "2026-06-10T00:00",
      end_at: "2026-06-19T23:59",
      weekdays: [1, 5, 0],
    });

    expect(script).toContain("lightvela-effective-window");
    expect(script).toContain("# weekdays=0,1,5");
    expect(script).toContain("current_weekday = now.isoweekday() % 7");
    expect(parseEffectiveWindowScript(script)).toEqual({
      start_at: "2026-06-10T00:00",
      end_at: "2026-06-19T23:59",
      weekdays: [0, 1, 5],
    });
  });

  it("keeps weekday-only LightVela gates editable", () => {
    const script = buildEffectiveWindowScript({
      start_at: null,
      end_at: null,
      weekdays: [5, 6, 0],
    });

    expect(parseEffectiveWindowScript(script)).toEqual({
      start_at: null,
      end_at: null,
      weekdays: [0, 5, 6],
    });
  });

  it("round-trips LightVela daily time metadata", () => {
    const script = buildEffectiveWindowScript({
      start_at: null,
      end_at: null,
      daily_times: ["12:30", "09:00", "09:00"],
    });

    expect(script).toContain("# daily_times=09:00,12:30");
    expect(parseLightVelaCronScript(script)).toEqual({
      effectiveWindow: null,
      lightvelaSchedule: { kind: "daily_times", times: ["09:00", "12:30"] },
    });
    expect(parseEffectiveWindowScript(script)).toBeNull();
  });

  it("ignores non-LightVela scripts", () => {
    expect(parseEffectiveWindowScript("print('hello')")).toBeNull();
  });

  it("hydrates previous effective window from the listed pre-run script", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(okExec(`
  6e8b6fc74896 [active]
    Name:      生效区间任务
    Schedule:  every 5m
    Script:    lightvela-effective-window-job-1.py
`))
	      .mockResolvedValueOnce(okExec(""))
	      .mockResolvedValueOnce(okExec(buildEffectiveWindowScript({
	        start_at: "2026-06-10T00:00",
	        end_at: "2026-06-19T23:59",
	      })))
	      .mockResolvedValueOnce(okExec(""));
    vi.stubGlobal("fetch", fetchMock);

    const jobs = await listCronJobs("bot-1");

    expect(jobs[0]?.effective_window).toEqual({
      start_at: "2026-06-10T00:00",
      end_at: "2026-06-19T23:59",
    });
	    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("hydrates LightVela daily time metadata from the listed pre-run script", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(okExec(`
  a1b2c3d4e5f6 [active]
    Name:      多时间点任务
    Schedule:  * * * * *
    Script:    lightvela-effective-window-daily.py
`))
	      .mockResolvedValueOnce(okExec(""))
	      .mockResolvedValueOnce(okExec(buildEffectiveWindowScript({
	        start_at: null,
	        end_at: null,
	        daily_times: ["09:00", "12:30"],
	      })))
	      .mockResolvedValueOnce(okExec(""));
    vi.stubGlobal("fetch", fetchMock);

    const jobs = await listCronJobs("bot-1");

    expect(jobs[0]?.lightvela_schedule).toEqual({
      kind: "daily_times",
      times: ["09:00", "12:30"],
    });
	    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});

describe("zero-token managed script", () => {
  it("round-trips fixed notification text and shared schedule gates as data", () => {
    const notification = "该喝水啦 '$(touch /tmp/nope)'\n休息一下 💧";
    const script = buildZeroTokenScript({
      kind: "fixed_notification",
      language: "python",
      content: notification,
      start_at: "2026-09-07T09:00",
      end_at: "2026-09-30T18:00",
      weekdays: [1, 5, 1],
      daily_times: ["15:30", "09:00"],
    });

    expect(script).toContain("lightvela-zero-token-v1");
    expect(script).not.toContain(notification);
    expect(script).not.toContain("touch /tmp/nope");
    expect(parseZeroTokenScript(script)).toEqual({
      zeroTokenConfig: {
        kind: "fixed_notification",
        language: "python",
        content: notification,
        managed: true,
        editable: true,
      },
      effectiveWindow: {
        start_at: "2026-09-07T09:00",
        end_at: "2026-09-30T18:00",
        weekdays: [1, 5],
      },
      lightvelaSchedule: { kind: "daily_times", times: ["09:00", "15:30"] },
    });
  });

  it("uses an argv subprocess without shell interpolation for user scripts", () => {
    const script = buildZeroTokenScript({
      kind: "script",
      language: "bash",
      content: "echo hello",
      start_at: null,
      end_at: null,
    });

    expect(script).toContain("command = ['bash']");
    expect(script).toContain("subprocess.run(command, input=meta['content'], text=True, check=False)");
    expect(script).not.toContain("shell=True");
  });

  it("executes only when the current weekday passes the wrapper gate", () => {
    const taskTempDir = mkdtempSync(join(tmpdir(), "lightvela-zero-token-gate-"));
    const currentWeekday = new Date().getDay();
    const otherWeekday = (currentWeekday + 1) % 7;
    const run = (weekdays: number[]) => {
      const scriptPath = join(taskTempDir, `gate-${weekdays.join("-")}.py`);
      writeFileSync(scriptPath, buildZeroTokenScript({
        kind: "fixed_notification",
        language: "python",
        content: "gate passed",
        start_at: "2000-01-01T00:00",
        end_at: "2100-01-01T00:00",
        weekdays,
      }), "utf8");
      return execFileSync("python3", [scriptPath], { encoding: "utf8" });
    };

    try {
      expect(run([0, 1, 2, 3, 4, 5, 6])).toBe("gate passed");
      expect(run([otherWeekday])).toBe("");
    } finally {
      rmSync(taskTempDir, { recursive: true, force: true });
    }
  });

  it("ignores unowned or malformed scripts", () => {
    expect(parseZeroTokenScript("print('hello')")).toBeNull();
    expect(parseZeroTokenScript("# lightvela-zero-token-v1\nMETA_B64 = \"invalid!\""))
      .toBeNull();
  });

  it("does not delete an external script that only resembles a managed filename", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const externalJob = {
      id: "external-job",
      script: "lightvela-zero-token-user-owned.py",
      zero_token_config: {
        kind: "script",
        language: "python",
        content: null,
        managed: false,
        editable: false,
      },
    } as CronJob;

    await removeManagedCronScriptIfUnreferenced("bot-1", externalJob, [externalJob]);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("deletes an unreferenced zero-token script only when ownership is proven", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(okExec(""));
    vi.stubGlobal("fetch", fetchMock);
    const managedJob = {
      id: "managed-job",
      script: "lightvela-zero-token-owned.py",
      zero_token_config: {
        kind: "fixed_notification",
        language: "python",
        content: "喝水",
        managed: true,
        editable: true,
      },
    } as CronJob;

    await removeManagedCronScriptIfUnreferenced("bot-1", managedJob, [managedJob]);

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { command: string };
    expect(body.command).toBe("rm -f ~/.hermes/scripts/lightvela-zero-token-owned.py");
  });
});

describe("listCronJobs", () => {
  it("hydrates a managed fixed notification from its zero-token wrapper", async () => {
    const script = buildZeroTokenScript({
      kind: "fixed_notification",
      language: "python",
      content: "记得喝水 💧",
      start_at: null,
      end_at: null,
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(okExec(`
  6e8b6fc74896 [active]
    Name:      喝水提醒
    Schedule:  every 2h
    Script:    lightvela-zero-token-water.py
    Deliver:   wecom
`))
      .mockResolvedValueOnce(okExec(JSON.stringify([{
        id: "6e8b6fc74896",
        no_agent: true,
        script: "lightvela-zero-token-water.py",
      }])))
      .mockResolvedValueOnce(okExec(script))
      .mockResolvedValueOnce(okExec(""));
    vi.stubGlobal("fetch", fetchMock);

    const jobs = await listCronJobs("bot-1");

    expect(jobs[0]?.inference_config?.no_agent).toBe(true);
    expect(jobs[0]?.zero_token_config).toMatchObject({
      kind: "fixed_notification",
      content: "记得喝水 💧",
      managed: true,
      editable: true,
    });
  });

  it("classifies an external no-agent script as read-only", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(okExec(`
  a1b2c3d4e5f6 [active]
    Name:      External watchdog
    Schedule:  every 5m
    Script:    watchdog.sh
`))
      .mockResolvedValueOnce(okExec(JSON.stringify([{
        id: "a1b2c3d4e5f6",
        no_agent: true,
        script: "watchdog.sh",
      }])))
      .mockResolvedValueOnce(okExec(""));
    vi.stubGlobal("fetch", fetchMock);

    const jobs = await listCronJobs("bot-1");

    expect(jobs[0]?.zero_token_config).toEqual({
      kind: "script",
      language: "bash",
      content: null,
      managed: false,
      editable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("hydrates context_from from jobs.json and defaults missing values to null", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(okExec(`
  6e8b6fc74896 [active]
    Name:      下游任务
    Schedule:  every 2h
    Deliver:   local

  a1b2c3d4e5f6 [active]
    Name:      独立任务
    Schedule:  every 3h
    Deliver:   local
`))
      .mockResolvedValueOnce(okExec(JSON.stringify([
        { id: "6e8b6fc74896", context_from: ["job-a"] },
        { id: "a1b2c3d4e5f6" },
      ])))
      .mockResolvedValueOnce(okExec(""));
    vi.stubGlobal("fetch", fetchMock);

    const jobs = await listCronJobs("bot-1");

    expect(jobs[0]?.context_from).toEqual(["job-a"]);
    expect(jobs[1]?.context_from).toBeNull();
    expect(jobs[0]?.context_from_hydrated).toBe(true);
    expect(jobs[1]?.context_from_hydrated).toBe(true);
  });

  it("can skip context_from hydration while preserving other jobs.json metadata", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(okExec(`
  6e8b6fc74896 [active]
    Name:      Global task
    Schedule:  every 2h
    Deliver:   local
`))
      .mockResolvedValueOnce(okExec(JSON.stringify([{
        id: "6e8b6fc74896",
        prompt: "Keep this prompt",
        context_from: ["job-a"],
      }])))
      .mockResolvedValueOnce(okExec(""));
    vi.stubGlobal("fetch", fetchMock);

    const jobs = await listCronJobs("bot-1", { hydrateContextFrom: false });

    expect(jobs[0]?.prompt).toBe("Keep this prompt");
    expect(jobs[0]?.context_from).toBeNull();
    expect(jobs[0]?.context_from_hydrated).toBe(false);
  });

  it("keeps the ordinary list usable but marks relationships untrusted when jobs.json cannot be parsed", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(okExec(`
  6e8b6fc74896 [active]
    Name:      普通任务
    Schedule:  every 2h
    Deliver:   local
`))
      .mockResolvedValueOnce(okExec("not-json"))
      .mockResolvedValueOnce(okExec(""));
    vi.stubGlobal("fetch", fetchMock);

    const jobs = await listCronJobs("bot-1");

    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.name).toBe("普通任务");
    expect(jobs[0]?.context_from).toBeNull();
    expect(jobs[0]?.context_from_hydrated).toBe(false);
  });

  it("hydrates task-level inference bindings from jobs.json", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(okExec(`
  6e8b6fc74896 [active]
    Name:      模型任务
    Schedule:  every 2h
    Deliver:   local
`))
      .mockResolvedValueOnce(okExec(JSON.stringify([{
        id: "6e8b6fc74896",
        provider: "openrouter",
        model: null,
        no_agent: false,
      }])))
      .mockResolvedValueOnce(okExec(""));
    vi.stubGlobal("fetch", fetchMock);

    const jobs = await listCronJobs("bot-1");

    expect(jobs[0]?.inference_config).toEqual({
      provider: "openrouter",
      model: null,
      no_agent: false,
    });
  });

  it("filters out disposable test-run temp jobs by their hidden zero-width marker", async () => {
    const tempName = buildTestRunMarker("6e8b6fc74896", "喝水提醒");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(okExec(`
  6e8b6fc74896 [active]
    Name:      喝水提醒
    Schedule:  every 2h
    Deliver:   local

  aa11bb22cc33 [active]
    Name:      ${tempName}
    Schedule:  once at 2026-07-03T12:00
    Deliver:   local
`))
      .mockResolvedValueOnce(okExec(""))
      .mockResolvedValueOnce(okExec(""));
    vi.stubGlobal("fetch", fetchMock);

    const jobs = await listCronJobs("bot-1");

    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.name).toBe("喝水提醒");
  });

  it("does not mistake a real task literally named like a test run for a temp job", async () => {
    // 真实任务名恰好是「XX测试运行」（无隐藏零宽 marker）时，绝不能被当成临时任务过滤掉
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(okExec(`
  6e8b6fc74896 [active]
    Name:      喝水提醒测试运行
    Schedule:  every 2h
    Deliver:   local
`))
      .mockResolvedValueOnce(okExec(""))
      .mockResolvedValueOnce(okExec(""));
    vi.stubGlobal("fetch", fetchMock);

    const jobs = await listCronJobs("bot-1");

    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.name).toBe("喝水提醒测试运行");
  });
});

describe("createCronJob auth handling", () => {
  it("surfaces debug exec failure details from HTTP error bodies", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({
        code: "DEBUG_EXEC_FAILED",
        message: "command execution failed",
        details: {
          status: "FAILED",
          exit_code: 1,
          stderr: "Unknown platform: telegram",
          detail: "status=FAILED exit_code=1 stderr=Unknown platform: telegram",
        },
      }),
    }));

    await expect(execCommand("bot-1", "hermes send --to 'telegram' 'hello'"))
      .rejects.toThrow("Unknown platform: telegram");
  });

  it("loads recent cron output files through debug exec", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(okExec(JSON.stringify([{
      job_id: "job-1",
      run_at: "2026-06-06T01:00:00+00:00",
      output_path: "/home/agentuser/.hermes/cron/output/job-1/2026-06-06T01-00-00.md",
      mtime_ms: 1780707600000,
    }])));
    vi.stubGlobal("fetch", fetchMock);

    const runs = await listRecentCronRuns("bot-1", [], 10);

    expect(runs[0]?.job_id).toBe("job-1");
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { command: string };
	    expect(body.command).toContain(".hermes");
    expect(body.command).toContain("cron");
	    expect(body.command).toContain("output");
	    expect(body.command).toContain("lightvela-jobs-meta.json");
    expect(body.command.toLowerCase()).toContain("wakeagent");
    expect(body.command).toContain("agent_skipped");
    expect(body.command).toContain("global inference config drifted since this job was created");
    expect(body.command).toContain("model_changed");
	  });

  it("streams debug exec stdout chunks before the command finishes", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(streamExec([
      "event: stdout\ndata: {\"chunk\":\"QR: https://qr.example.com/abc\"}\n\n",
      "event: finished\ndata: {\"response\":{\"status\":\"SUCCESS\",\"exit_code\":0,\"output\":\"connected\"}}\n\n",
    ]));
    vi.stubGlobal("fetch", fetchMock);
    const outputs: string[] = [];

    const payload = await execCommandStream("bot-1", "acli gateway qr-url --platform weixin --wait true", {
      onOutput: (output) => outputs.push(output),
    });

    expect(outputs).toEqual(["QR: https://qr.example.com/abc"]);
    expect(payload).toMatchObject({ status: "SUCCESS", exit_code: 0, output: "connected" });
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get("Accept")).toBe("text/event-stream");
  });

  it("removes a prepared LightVela script when cron create fails", async () => {
    const script = "lightvela-effective-window-job-1.py";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(failedExec("invalid cron expression"))
      .mockResolvedValueOnce(okExec(""));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createCronJobWithScriptRollback("bot-1", {
      schedule: "bad schedule",
      prompt: "hello",
      name: "test",
      script,
    }, script)).rejects.toThrow("invalid cron expression");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const cleanupBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as { command: string };
    expect(cleanupBody.command).toBe("rm -f ~/.hermes/scripts/lightvela-effective-window-job-1.py");
  });

  it("broadcasts the shared unauthorized event on 401", async () => {
    writeStoredAuthToken("expired-token");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ message: "unauthorized" }),
    }));
    const listener = vi.fn();
    window.addEventListener(AUTH_UNAUTHORIZED_EVENT, listener);

    await expect(createCronJob("bot-1", {
      schedule: "every 5m",
      prompt: "hello",
      name: "test",
    })).rejects.toThrow("登录已过期，请重新登录");

    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener(AUTH_UNAUTHORIZED_EVENT, listener);
  });
});

describe("runCronJob", () => {
  it("issues a single `hermes cron run <id>` command and returns its result on success", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(okExec("Run triggered."));
    vi.stubGlobal("fetch", fetchMock);

    const payload = await runCronJob("bot-1", "job-1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { command: string };
    expect(body.command).toBe("hermes cron run 'job-1'");
    // 不应再拼接不存在的 `hermes cron tick` 子命令
    expect(body.command).not.toContain("tick");
    expect(payload.output).toBe("Run triggered.");
  });

  it("propagates a CronCommandError when the underlying `cron run` fails, without any extra tick call", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(failedExec("job not found"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(runCronJob("bot-1", "missing-job")).rejects.toThrow("job not found");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("buildTestRunMarker", () => {
  it("shows a clean human-readable title 「{原任务名}测试运行」 while hiding the marker in zero-width chars", () => {
    const marker = buildTestRunMarker("dcb4fee9e45f1234", "喝水提醒");

    // 去掉所有零宽字符后，用户可见的就是干净的「喝水提醒测试运行」
    const visible = marker.replace(/[\u200B\u200C\u2063]/g, "");
    expect(visible).toBe("喝水提醒测试运行");
    // 原始 name 里确实含隐藏零宽 marker（否则程序无法识别/反查）
    expect(marker).not.toBe(visible);
    expect(marker).toMatch(/[\u2063]/);
  });

  it("falls back to a bare 「测试运行」 when the origin name is missing", () => {
    const marker = buildTestRunMarker("dcb4fee9e45f1234");
    const visible = marker.replace(/[\u200B\u200C\u2063]/g, "");
    expect(visible).toBe("测试运行");
  });

  it("never collides across consecutive calls for the same job", () => {
    const markers = new Set(Array.from({ length: 20 }, () => buildTestRunMarker("job-1", "提醒")));

    expect(markers.size).toBe(20);
  });
});

describe("parseCronRunFilesOutput filters test-run temp jobs", () => {
  it("drops a test-run temp job from run history instead of surfacing it (CR P2)", () => {
    const tempName = buildTestRunMarker("abc12345ffff", "喝水提醒");
    const runs = parseCronRunFilesOutput(JSON.stringify([{
      job_id: "temp-xyz",
      run_at: "2026-07-03T02:20:16+00:00",
      output_path: "/home/agentuser/.hermes/cron/output/temp-xyz/2026-07-03T02-20-16.md",
      mtime_ms: 1780712416000,
      job_name: tempName,
    }]), []);

    expect(runs).toEqual([]);
  });

  it("keeps normal jobs while dropping interleaved test-run temp jobs", () => {
    const tempName = buildTestRunMarker("abc12345ffff", "喝水提醒");
    const runs = parseCronRunFilesOutput(JSON.stringify([
      {
        job_id: "real-1",
        run_at: "2026-07-03T02:00:00+00:00",
        output_path: "/home/agentuser/.hermes/cron/output/real-1/a.md",
        mtime_ms: 1780711200000,
        job_name: "喝水提醒",
      },
      {
        job_id: "temp-xyz",
        run_at: "2026-07-03T02:20:16+00:00",
        output_path: "/home/agentuser/.hermes/cron/output/temp-xyz/b.md",
        mtime_ms: 1780712416000,
        job_name: tempName,
      },
    ]), []);

    expect(runs.map((r) => r.job_id)).toEqual(["real-1"]);
    expect(runs[0]?.job_name).toBe("喝水提醒");
  });
});

describe("runCronJobAsTest", () => {
  const baseJob: CronJob = {
    id: "job-1",
    name: "喝水提醒",
    prompt: "提醒我喝水",
    schedule: { kind: "interval", expr: "every 2h", display: "every 2h" },
    skills: ["health"],
    enabled: true,
    state: "scheduled",
    deliver: "wecom",
    next_run_at: "2026-07-02T20:00:00+08:00",
    last_run_at: "2026-07-02T18:00:00+08:00",
    last_status: "ok",
    created_at: null,
    script: "",
    effective_window: null,
    lightvela_schedule: null,
    context_from: null,
    inference_config: null,
  };

  function extractCommand(fetchMock: ReturnType<typeof vi.fn>, callIndex: number): string {
    const body = JSON.parse(String(fetchMock.mock.calls[callIndex]?.[1]?.body)) as { command: string };
    return body.command;
  }

  function extractMarkerFromCreateCommand(command: string): string {
    return /--name '([^']+)'/.exec(command)?.[1] ?? "";
  }

  it("tests a managed zero-token task without sending an Agent acknowledgement and cleans its wrapper", async () => {
    let marker = "";
    const commands: string[] = [];
    const fetchMock = vi.fn(async (_url: unknown, init: { body?: string }) => {
      const command = JSON.parse(String(init?.body)) as { command: string };
      const cmd = command.command;
      commands.push(cmd);
      if (cmd.includes("hermes cron create")) {
        marker = extractMarkerFromCreateCommand(cmd);
        return okExec("Job created.");
      }
      if (cmd.includes("lightvela-jobs-meta.json") && cmd.startsWith("python3")) return okExec("");
      if (cmd.includes("cat ~/.hermes/cron/jobs.json")) {
        return okExec(JSON.stringify([{
          id: "temp-zero",
          name: marker,
          last_run_at: "2026-09-07T00:00:00+08:00",
          last_status: "ok",
          last_delivery_error: null,
        }]));
      }
      if (cmd.startsWith("mkdir -p ~/.hermes/scripts")) return okExec("");
      if (cmd === "hermes cron remove 'temp-zero'") return okExec("Removed.");
      if (cmd.startsWith("rm -f ~/.hermes/scripts/lightvela-zero-token-test-")) return okExec("");
      throw new Error(`unexpected command in test: ${cmd}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const job: CronJob = {
      ...baseJob,
      id: "zero-1",
      name: "固定喝水提醒",
      prompt: "",
      script: "lightvela-zero-token-water.py",
      skills: [],
      context_from: null,
      inference_config: { provider: null, model: null, no_agent: true },
      zero_token_config: {
        kind: "fixed_notification",
        language: "python",
        content: "该喝水啦 💧",
        managed: true,
        editable: true,
      },
    };

    const result = await runCronJobAsTest("bot-1", job);

    expect(result).toEqual({ output: "ok", deliveryError: null });
    expect(commands.some((command) => command.startsWith("hermes send "))).toBe(false);
    const createCommand = commands.find((command) => command.includes("hermes cron create")) ?? "";
    expect(createCommand).toContain("--no-agent");
    expect(createCommand).not.toContain("该喝水啦");
    expect(createCommand).not.toContain("lightvela-zero-token-water.py");
    expect(commands).toContain("hermes cron remove 'temp-zero'");
    expect(commands.some((command) => command.startsWith(
      "rm -f ~/.hermes/scripts/lightvela-zero-token-test-",
    ))).toBe(true);
    expect(commands).not.toContain("rm -f ~/.hermes/scripts/lightvela-zero-token-water.py");
  });

  /**
   * `runCronJobAsTest` 现在不再调用 `hermes cron run` 强制触发，而是完全依赖
   * 临时任务按自己的 schedule 被调度器自然 tick 到执行——`waitForCronJobExecuted`
   * 轮询 `last_run_at` 直到非空或超时（见 `TEST_RUN_POLL_INTERVAL_MS` /
   * `TEST_RUN_POLL_TIMEOUT_MS`）。测试里用假时钟把轮询间隔瞬间推进掉，不必真的
   * 等待；`advanceMs` 允许超时场景传入更大的推进量。
   */
  async function runWithAdvancedTimers<T>(work: Promise<T>, advanceMs = 60_000): Promise<T> {
    vi.useFakeTimers();
    const [result] = await Promise.all([work, vi.advanceTimersByTimeAsync(advanceMs)]);
    return result;
  }

  it("runs the disposable test job with the draft upstream context", async () => {
    const commands: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const command = String((JSON.parse(String(init?.body ?? "{}")) as { command?: string }).command ?? "");
      commands.push(command);
      if (command.startsWith("hermes send ")) return okExec("Sent.");
      if (command.includes("from tools.cronjob_tools import cronjob")) {
        return okExec('LIGHTVELA_CRON_CONTEXT_RESULT={"success":true,"job_id":"temp-context"}');
      }
      if (command.includes("lightvela-jobs-meta.json")) return okExec("");
      if (command.includes("cat ~/.hermes/cron/jobs.json")) {
        return okExec(JSON.stringify([{
          id: "temp-context",
          last_run_at: "2026-08-28T10:00:00+08:00",
          last_status: "ok",
          last_delivery_error: null,
        }]));
      }
      if (command === "hermes cron remove 'temp-context'") return okExec("Removed.");
      return failedExec(`unexpected command: ${command}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const started = await startCronTestRun("bot-1", {
      ...baseJob,
      name: "未保存名称",
      prompt: "未保存任务说明",
      skills: ["news"],
      deliver: "wecom",
      context_from: ["upstream-current"],
    });
    await expect(started.completion).resolves.toMatchObject({ output: "ok", deliveryError: null });

    const createCommand = commands.find((command) => command.includes("from tools.cronjob_tools import cronjob")) ?? "";
    expect(createCommand).toContain('\\"context_from\\":[\\"upstream-current\\"]');
    expect(createCommand).toContain('\\"prompt\\":\\"未保存任务说明\\"');
    expect(commands).toContain("hermes cron remove 'temp-context'");
  });

  it("retries cleanup when structured create succeeds without returning a job id", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_788_000_000_000);
    vi.spyOn(Math, "random").mockReturnValue(0.25);
    const marker = buildTestRunMarker(baseJob.id, baseJob.name);
    const commands: string[] = [];
    let jobsReadCount = 0;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const command = String((JSON.parse(String(init?.body ?? "{}")) as { command?: string }).command ?? "");
      commands.push(command);
      if (command.startsWith("hermes send ")) return okExec("Sent.");
      if (command.includes("from tools.cronjob_tools import cronjob")) {
        return okExec('LIGHTVELA_CRON_CONTEXT_RESULT={"success":true}');
      }
      if (command.includes("cat ~/.hermes/cron/jobs.json")) {
        jobsReadCount += 1;
        return okExec(JSON.stringify(jobsReadCount >= 2 ? [{ id: "temp-context", name: marker }] : []));
      }
      if (command === "hermes cron remove 'temp-context'") return okExec("Removed.");
      return failedExec(`unexpected command: ${command}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const start = startCronTestRun("bot-1", {
      ...baseJob,
      context_from: ["upstream-current"],
    });

    await expect(runWithAdvancedTimers(start, 2_000)).rejects.toThrow(
      "临时测试任务创建异常，已尝试清理，请稍后重试",
    );
    expect(jobsReadCount).toBe(2);
    expect(commands).toContain("hermes cron remove 'temp-context'");
  });

  it("clones a disposable once-off job, waits for it to run naturally, and cleans it up without touching the original job id", async () => {
    let capturedMarker = "";
    let catCallCount = 0;
    const fetchMock = vi.fn(async (_url: unknown, init: { body?: string }) => {
      const command = JSON.parse(String(init?.body)) as { command: string };
      const cmd = command.command;
      if (cmd.startsWith("hermes send ")) {
        return okExec("Sent.");
      }
      if (cmd.includes("hermes cron create")) {
        capturedMarker = extractMarkerFromCreateCommand(cmd);
        return okExec("Job created.");
      }
      if (cmd.includes("lightvela-jobs-meta.json") && cmd.startsWith("python3")) {
        return okExec("");
      }
      if (cmd.includes("cat ~/.hermes/cron/jobs.json")) {
        catCallCount += 1;
        // 前两次读取模拟"调度器还没到点执行"；第三次开始视为已被 tick 自然执行完
        const executed = catCallCount >= 3;
        const record = executed
          ? { id: "temp-1", name: capturedMarker, last_run_at: "2026-07-02T21:55:03+08:00", last_status: "ok", last_delivery_error: null }
          : { id: "temp-1", name: capturedMarker, last_run_at: null, last_status: null, last_delivery_error: null };
        return okExec(JSON.stringify([record]));
      }
      if (cmd === `hermes cron remove 'temp-1'`) {
        return okExec("Removed.");
      }
      throw new Error(`unexpected command in test: ${cmd}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await runWithAdvancedTimers(runCronJobAsTest("bot-1", baseJob));

    expect(result.deliveryError).toBeNull();
    expect(result.output).toBe("ok");
    const allCommands = fetchMock.mock.calls.map((_, i) => extractCommand(fetchMock, i));
    // 不应再强制触发：既不催原任务，也不催临时任务
    expect(allCommands.some((c) => c.startsWith("hermes cron run"))).toBe(false);
    // 原任务 id 全程不应出现在任何 `cron remove` 命令里
    expect(allCommands.some((c) => c === `hermes cron remove 'job-1'`)).toBe(false);
    expect(allCommands.some((c) => c === `hermes cron remove 'temp-1'`)).toBe(true);
    // 临时任务的 schedule 必须是具体的一次性时间点（once 语义），而不是原任务的 interval
    const createCommand = allCommands.find((c) => c.includes("hermes cron create")) ?? "";
    expect(createCommand).not.toContain("every 2h");
  });

  it("immediately pushes an acknowledgement to the job's IM channel before the long wait, without blocking on send failure", async () => {
    let capturedMarker = "";
    let catCallCount = 0;
    const fetchMock = vi.fn(async (_url: unknown, init: { body?: string }) => {
      const command = JSON.parse(String(init?.body)) as { command: string };
      const cmd = command.command;
      if (cmd.startsWith("hermes send ")) {
        // 即使即时回执发送失败，也不能影响后续真正的测试运行
        return failedExec("delivery flaked");
      }
      if (cmd.includes("hermes cron create")) {
        capturedMarker = extractMarkerFromCreateCommand(cmd);
        return okExec("Job created.");
      }
      if (cmd.includes("lightvela-jobs-meta.json") && cmd.startsWith("python3")) {
        return okExec("");
      }
      if (cmd.includes("cat ~/.hermes/cron/jobs.json")) {
        catCallCount += 1;
        const executed = catCallCount >= 2;
        return okExec(JSON.stringify([executed
          ? { id: "temp-1", name: capturedMarker, last_run_at: "2026-07-02T21:55:03+08:00", last_status: "ok", last_delivery_error: null }
          : { id: "temp-1", name: capturedMarker, last_run_at: null, last_status: null, last_delivery_error: null }]));
      }
      if (cmd === `hermes cron remove 'temp-1'`) {
        return okExec("Removed.");
      }
      throw new Error(`unexpected command in test: ${cmd}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    // 回执发送失败被吞掉，主流程仍然正常跑完
    const result = await runWithAdvancedTimers(runCronJobAsTest("bot-1", baseJob));
    expect(result.deliveryError).toBeNull();

    const allCommands = fetchMock.mock.calls.map((_, i) => extractCommand(fetchMock, i));
    const sendIndex = allCommands.findIndex((c) => c.startsWith("hermes send "));
    const createIndex = allCommands.findIndex((c) => c.includes("hermes cron create"));
    // 即时回执确实发出，发到该任务的 IM 通道（deliver=wecom），且带约定文案
    expect(sendIndex).toBeGreaterThanOrEqual(0);
    expect(allCommands[sendIndex]).toContain("--to 'wecom'");
    expect(allCommands[sendIndex]).toContain("已收到测试请求");
    // 回执必须发生在创建临时任务（开始漫长等待）之前
    expect(sendIndex).toBeLessThan(createIndex);
  });

  it("sends one `hermes send` per target for a comma-separated multi-IM deliver (send --to only accepts a single platform)", async () => {
    // `hermes send --to` 只接受单个目标：把 'wecom,qqbot' 整串传进去会报
    // `Unknown platform: wecom,qqbot` 并 exit 1。所以多选 IM 的即时回执必须按逗号
    // 拆开、对每个目标各发一条 `hermes send`，用户勾选的每个 IM 才都能收到。
    let capturedMarker = "";
    let catCallCount = 0;
    const fetchMock = vi.fn(async (_url: unknown, init: { body?: string }) => {
      const command = JSON.parse(String(init?.body)) as { command: string };
      const cmd = command.command;
      if (cmd.startsWith("hermes send ")) {
        return okExec("Sent.");
      }
      if (cmd.includes("hermes cron create")) {
        capturedMarker = extractMarkerFromCreateCommand(cmd);
        return okExec("Job created.");
      }
      if (cmd.includes("lightvela-jobs-meta.json") && cmd.startsWith("python3")) {
        return okExec("");
      }
      if (cmd.includes("cat ~/.hermes/cron/jobs.json")) {
        catCallCount += 1;
        const executed = catCallCount >= 3;
        const record = executed
          ? { id: "temp-1", name: capturedMarker, last_run_at: "2026-07-02T21:55:03+08:00", last_status: "ok", last_delivery_error: null }
          : { id: "temp-1", name: capturedMarker, last_run_at: null, last_status: null, last_delivery_error: null };
        return okExec(JSON.stringify([record]));
      }
      if (cmd === `hermes cron remove 'temp-1'`) {
        return okExec("Removed.");
      }
      throw new Error(`unexpected command in test: ${cmd}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const multiJob: CronJob = { ...baseJob, deliver: "wecom,qqbot" };
    const result = await runWithAdvancedTimers(runCronJobAsTest("bot-1", multiJob));
    expect(result.deliveryError).toBeNull();

    const allCommands = fetchMock.mock.calls.map((_, i) => extractCommand(fetchMock, i));
    const sendCommands = allCommands.filter((c) => c.startsWith("hermes send "));
    // 关键：两个 IM 各一条独立的 send，且都不能出现被拒的整串多目标 'wecom,qqbot'
    expect(sendCommands.some((c) => c.includes("--to 'wecom'"))).toBe(true);
    expect(sendCommands.some((c) => c.includes("--to 'qqbot'"))).toBe(true);
    expect(sendCommands.every((c) => !c.includes("--to 'wecom,qqbot'"))).toBe(true);
    // 每条都带约定文案
    expect(sendCommands.every((c) => c.includes("已收到测试请求"))).toBe(true);
    // 临时任务的 deliver 仍是完整多目标（cron create --deliver 支持逗号多目标，不拆）
    const createCommand = allCommands.find((c) => c.includes("hermes cron create"));
    expect(createCommand).toContain("--deliver 'wecom,qqbot'");
  });

  it("keeps delivering to the remaining targets even if one target's `hermes send` fails", async () => {
    // 每个目标独立 best-effort：wecom 发失败不影响 qqbot，也不影响主流程。
    let capturedMarker = "";
    let catCallCount = 0;
    const fetchMock = vi.fn(async (_url: unknown, init: { body?: string }) => {
      const command = JSON.parse(String(init?.body)) as { command: string };
      const cmd = command.command;
      if (cmd.startsWith("hermes send ")) {
        if (cmd.includes("--to 'wecom'")) return failedExec("wecom flaked");
        return okExec("Sent.");
      }
      if (cmd.includes("hermes cron create")) {
        capturedMarker = extractMarkerFromCreateCommand(cmd);
        return okExec("Job created.");
      }
      if (cmd.includes("lightvela-jobs-meta.json") && cmd.startsWith("python3")) {
        return okExec("");
      }
      if (cmd.includes("cat ~/.hermes/cron/jobs.json")) {
        catCallCount += 1;
        const executed = catCallCount >= 3;
        const record = executed
          ? { id: "temp-1", name: capturedMarker, last_run_at: "2026-07-02T21:55:03+08:00", last_status: "ok", last_delivery_error: null }
          : { id: "temp-1", name: capturedMarker, last_run_at: null, last_status: null, last_delivery_error: null };
        return okExec(JSON.stringify([record]));
      }
      if (cmd === `hermes cron remove 'temp-1'`) {
        return okExec("Removed.");
      }
      throw new Error(`unexpected command in test: ${cmd}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const multiJob: CronJob = { ...baseJob, deliver: "wecom,qqbot" };
    // wecom 那条失败被吞掉，主流程仍正常跑完
    const result = await runWithAdvancedTimers(runCronJobAsTest("bot-1", multiJob));
    expect(result.deliveryError).toBeNull();

    const allCommands = fetchMock.mock.calls.map((_, i) => extractCommand(fetchMock, i));
    const sendCommands = allCommands.filter((c) => c.startsWith("hermes send "));
    // 两个目标都尝试发过（wecom 虽失败也发起了请求）
    expect(sendCommands.some((c) => c.includes("--to 'wecom'"))).toBe(true);
    expect(sendCommands.some((c) => c.includes("--to 'qqbot'"))).toBe(true);
  });

  it("surfaces a non-null deliveryError when the agent ran but delivery failed", async () => {
    let capturedMarker = "";
    let catCallCount = 0;
    const fetchMock = vi.fn(async (_url: unknown, init: { body?: string }) => {
      const command = JSON.parse(String(init?.body)) as { command: string };
      const cmd = command.command;
      if (cmd.startsWith("hermes send ")) {
        return okExec("Sent.");
      }
      if (cmd.includes("hermes cron create")) {
        capturedMarker = extractMarkerFromCreateCommand(cmd);
        return okExec("Job created.");
      }
      if (cmd.includes("lightvela-jobs-meta.json") && cmd.startsWith("python3")) {
        return okExec("");
      }
      if (cmd.includes("cat ~/.hermes/cron/jobs.json")) {
        catCallCount += 1;
        const executed = catCallCount >= 3;
        const record = executed
          ? {
              id: "temp-1",
              name: capturedMarker,
              last_run_at: "2026-07-02T21:55:03+08:00",
              last_status: "ok",
              last_delivery_error: "wecom home channel not set; run /sethome",
            }
          : { id: "temp-1", name: capturedMarker, last_run_at: null, last_status: null, last_delivery_error: null };
        return okExec(JSON.stringify([record]));
      }
      if (cmd === `hermes cron remove 'temp-1'`) {
        return okExec("Removed.");
      }
      throw new Error(`unexpected command in test: ${cmd}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await runWithAdvancedTimers(runCronJobAsTest("bot-1", baseJob));

    expect(result.deliveryError).toBe("wecom home channel not set; run /sethome");
  });

  it("still removes the temporary job when the scheduler never executes it in time, and reports a timeout error", async () => {
    let capturedMarker = "";
    const fetchMock = vi.fn(async (_url: unknown, init: { body?: string }) => {
      const command = JSON.parse(String(init?.body)) as { command: string };
      const cmd = command.command;
      if (cmd.startsWith("hermes send ")) {
        return okExec("Sent.");
      }
      if (cmd.includes("hermes cron create")) {
        capturedMarker = extractMarkerFromCreateCommand(cmd);
        return okExec("Job created.");
      }
      if (cmd.includes("lightvela-jobs-meta.json") && cmd.startsWith("python3")) {
        return okExec("");
      }
      if (cmd.includes("cat ~/.hermes/cron/jobs.json")) {
        // last_run_at 一直是空：模拟调度器一直没有自然执行这个临时任务
        return okExec(JSON.stringify([
          { id: "temp-1", name: capturedMarker, last_run_at: null, last_status: null, last_delivery_error: null },
        ]));
      }
      if (cmd === `hermes cron remove 'temp-1'`) {
        return okExec("Removed.");
      }
      throw new Error(`unexpected command in test: ${cmd}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    // 推进量要越过 TEST_RUN_POLL_TIMEOUT_MS（现为 300s，见 hermes-cron-client）才能触发超时。
    await expect(runWithAdvancedTimers(runCronJobAsTest("bot-1", baseJob), 305_000))
      .rejects.toThrow("测试运行超时");

    const allCommands = fetchMock.mock.calls.map((_, i) => extractCommand(fetchMock, i));
    expect(allCommands.some((c) => c === `hermes cron remove 'temp-1'`)).toBe(true);
  }, 15_000);

  it("retries locating the temp job when jobs.json is momentarily stale after create (CR P1)", async () => {
    // create 已成功，但 jobs.json 有写入延迟：前两次反查读不到该 marker，第三次才出现。
    // 应靠重试拿到 tempId 正常继续，而不是直接判「未能定位」而报错。
    let capturedMarker = "";
    let lookupCatCount = 0;
    const fetchMock = vi.fn(async (_url: unknown, init: { body?: string }) => {
      const command = JSON.parse(String(init?.body)) as { command: string };
      const cmd = command.command;
      if (cmd.startsWith("hermes send ")) return okExec("Sent.");
      if (cmd.includes("hermes cron create")) {
        capturedMarker = extractMarkerFromCreateCommand(cmd);
        return okExec("Job created.");
      }
      if (cmd.includes("lightvela-jobs-meta.json") && cmd.startsWith("python3")) {
        return okExec("");
      }
      if (cmd.includes("cat ~/.hermes/cron/jobs.json")) {
        lookupCatCount += 1;
        // 前两次：jobs.json 尚未写入该临时任务（模拟写入延迟）→ 空数组
        if (lookupCatCount <= 2) return okExec("[]");
        // 第三次起：该 marker 记录出现，且已执行完，可直接返回结果
        return okExec(JSON.stringify([
          { id: "temp-1", name: capturedMarker, last_run_at: "2026-07-02T21:55:03+08:00", last_status: "ok", last_delivery_error: null },
        ]));
      }
      if (cmd === `hermes cron remove 'temp-1'`) return okExec("Removed.");
      throw new Error(`unexpected command in test: ${cmd}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await runWithAdvancedTimers(runCronJobAsTest("bot-1", baseJob));
    expect(result.output).toBe("ok");
    const allCommands = fetchMock.mock.calls.map((_, i) => extractCommand(fetchMock, i));
    // 临时任务最终被定位并清理
    expect(allCommands.some((c) => c === `hermes cron remove 'temp-1'`)).toBe(true);
  }, 15_000);

  it("attempts a name-based cleanup and throws when the temp job can never be located after create (CR P1)", async () => {
    // create 成功但 jobs.json 始终读不到该 marker（写入丢失/解析不到）：重试耗尽后，
    // 必须走兜底清理路径（按 marker 名再反查一次去删），不能直接裸抛而留下残留任务。
    let capturedMarker = "";
    let removeByNameLookupSeen = false;
    let catCount = 0;
    const fetchMock = vi.fn(async (_url: unknown, init: { body?: string }) => {
      const command = JSON.parse(String(init?.body)) as { command: string };
      const cmd = command.command;
      if (cmd.startsWith("hermes send ")) return okExec("Sent.");
      if (cmd.includes("hermes cron create")) {
        capturedMarker = extractMarkerFromCreateCommand(cmd);
        return okExec("Job created.");
      }
      if (cmd.includes("lightvela-jobs-meta.json") && cmd.startsWith("python3")) {
        return okExec("");
      }
      if (cmd.includes("cat ~/.hermes/cron/jobs.json")) {
        catCount += 1;
        // 前几次是 lookup 重试；最后一次（重试耗尽后）是兜底清理的反查——都读不到该 marker
        void capturedMarker;
        if (catCount > 4) removeByNameLookupSeen = true;
        return okExec("[]");
      }
      throw new Error(`unexpected command in test: ${cmd}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(runWithAdvancedTimers(runCronJobAsTest("bot-1", baseJob)))
      .rejects.toThrow("未能定位临时任务");
    // 兜底清理确实尝试过再反查一次（catCount 超过纯 lookup 的重试次数）
    expect(removeByNameLookupSeen).toBe(true);
    const allCommands = fetchMock.mock.calls.map((_, i) => extractCommand(fetchMock, i));
    // 反查不到 id，不会误删任何任务；但也绝不会残留一个已 run 的临时任务
    expect(allCommands.some((c) => c.startsWith("hermes cron remove"))).toBe(false);
  }, 15_000);

  it("resolves a bare `origin` deliver token into the original job's concrete platform:chat_id before cloning", async () => {
    let capturedMarker = "";
    let catCallCount = 0;
    const fetchMock = vi.fn(async (_url: unknown, init: { body?: string }) => {
      const command = JSON.parse(String(init?.body)) as { command: string };
      const cmd = command.command;
      if (cmd.startsWith("hermes send ")) {
        return okExec("Sent.");
      }
      if (cmd.includes("hermes cron create")) {
        capturedMarker = extractMarkerFromCreateCommand(cmd);
        return okExec("Job created.");
      }
      if (cmd.includes("lightvela-jobs-meta.json") && cmd.startsWith("python3")) {
        return okExec("");
      }
      if (cmd.includes("cat ~/.hermes/cron/jobs.json")) {
        catCallCount += 1;
        if (catCallCount === 1) {
          // 第一次读取：resolveConcreteDeliverForTestRun 查询原任务的 origin 字段
          return okExec(JSON.stringify([
            { id: "job-1", origin: { platform: "wecom", chat_id: "wecom-chat-abc" } },
          ]));
        }
        // 后续读取：findCronJobIdByExactName / waitForCronJobExecuted 轮询临时任务，
        // 这里直接给出已执行完的记录，跳过多轮轮询
        return okExec(JSON.stringify([{
          id: "temp-1",
          name: capturedMarker,
          last_run_at: "2026-07-02T21:55:03+08:00",
          last_status: "ok",
          last_delivery_error: null,
        }]));
      }
      if (cmd === `hermes cron remove 'temp-1'`) {
        return okExec("Removed.");
      }
      throw new Error(`unexpected command in test: ${cmd}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await runWithAdvancedTimers(runCronJobAsTest("bot-1", { ...baseJob, deliver: "origin" }));

    const allCommands = fetchMock.mock.calls.map((_, i) => extractCommand(fetchMock, i));
    const createCommand = allCommands.find((c) => c.includes("hermes cron create")) ?? "";
    expect(createCommand).toContain("--deliver 'wecom:wecom-chat-abc'");
    // 即时回执也必须发到解析后的具体 origin 目标，而不是裸 `origin`
    const sendCommand = allCommands.find((c) => c.startsWith("hermes send ")) ?? "";
    expect(sendCommand).toContain("--to 'wecom:wecom-chat-abc'");
  });

  it("falls back to a connected home channel when deliver is `origin` but the origin context is null", async () => {
    // 复现线上真实故障：在网页「定时任务」面板/无会话上下文下创建的任务，
    // deliver 存成 `origin` 但 origin 落库为 null。若原样保留 `origin`，临时
    // 任务投递会静默丢弃（任务照记 ok，用户啥也收不到）。修复后应兜底到该
    // bot 已连接的 home channel（此处 wecom）。
    let capturedMarker = "";
    let catCallCount = 0;
    const fetchMock = vi.fn(async (_url: unknown, init: { body?: string }) => {
      const command = JSON.parse(String(init?.body)) as { command: string };
      const cmd = command.command;
      if (cmd.startsWith("hermes send ")) {
        return okExec("Sent to wecom home channel (chat_id: WangHao)");
      }
      if (cmd === "acli channel status") {
        // wecom / weixin / qqbot 已连接，feishu 断开；按优先级应选 wecom
        return okExec(JSON.stringify({
          success: true,
          data: {
            platforms: [
              { name: "feishu", status: "disconnected" },
              { name: "wecom", status: "connected" },
              { name: "weixin", status: "connected" },
              { name: "qqbot", status: "connected" },
            ],
          },
        }));
      }
      if (cmd.includes("hermes cron create")) {
        capturedMarker = extractMarkerFromCreateCommand(cmd);
        return okExec("Job created.");
      }
      if (cmd.includes("lightvela-jobs-meta.json") && cmd.startsWith("python3")) {
        return okExec("");
      }
      if (cmd.includes("cat ~/.hermes/cron/jobs.json")) {
        catCallCount += 1;
        if (catCallCount === 1) {
          // resolveConcreteDeliverForTestRun 查询原任务 origin —— 线上真实结构：null
          return okExec(JSON.stringify([{ id: "job-1", origin: null }]));
        }
        return okExec(JSON.stringify([{
          id: "temp-1",
          name: capturedMarker,
          last_run_at: "2026-07-02T21:55:03+08:00",
          last_status: "ok",
          last_delivery_error: null,
        }]));
      }
      if (cmd === `hermes cron remove 'temp-1'`) {
        return okExec("Removed.");
      }
      throw new Error(`unexpected command in test: ${cmd}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await runWithAdvancedTimers(runCronJobAsTest("bot-1", { ...baseJob, deliver: "origin" }));

    const allCommands = fetchMock.mock.calls.map((_, i) => extractCommand(fetchMock, i));
    // 临时任务不再带裸 `origin`，而是兜底到已连接的 wecom home channel
    const createCommand = allCommands.find((c) => c.includes("hermes cron create")) ?? "";
    expect(createCommand).toContain("--deliver 'wecom'");
    expect(createCommand).not.toContain("--deliver 'origin'");
    // 即时回执也发到 wecom（而不是无处可投的裸 origin）
    const sendCommand = allCommands.find((c) => c.startsWith("hermes send ")) ?? "";
    expect(sendCommand).toContain("--to 'wecom'");
  });

  it("keeps the bare `origin` deliver when no channel is connected (nothing to fall back to)", async () => {
    let capturedMarker = "";
    let catCallCount = 0;
    const fetchMock = vi.fn(async (_url: unknown, init: { body?: string }) => {
      const command = JSON.parse(String(init?.body)) as { command: string };
      const cmd = command.command;
      if (cmd.startsWith("hermes send ")) {
        return okExec("Sent.");
      }
      if (cmd === "acli channel status") {
        // 所有通道都断开：兜底选不出目标，只能原样保留 origin
        return okExec(JSON.stringify({
          success: true,
          data: { platforms: [{ name: "wecom", status: "disconnected" }] },
        }));
      }
      if (cmd.includes("hermes cron create")) {
        capturedMarker = extractMarkerFromCreateCommand(cmd);
        return okExec("Job created.");
      }
      if (cmd.includes("lightvela-jobs-meta.json") && cmd.startsWith("python3")) {
        return okExec("");
      }
      if (cmd.includes("cat ~/.hermes/cron/jobs.json")) {
        catCallCount += 1;
        if (catCallCount === 1) {
          return okExec(JSON.stringify([{ id: "job-1", origin: null }]));
        }
        return okExec(JSON.stringify([{
          id: "temp-1",
          name: capturedMarker,
          last_run_at: "2026-07-02T21:55:03+08:00",
          last_status: "ok",
          last_delivery_error: null,
        }]));
      }
      if (cmd === `hermes cron remove 'temp-1'`) {
        return okExec("Removed.");
      }
      throw new Error(`unexpected command in test: ${cmd}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await runWithAdvancedTimers(runCronJobAsTest("bot-1", { ...baseJob, deliver: "origin" }));

    const allCommands = fetchMock.mock.calls.map((_, i) => extractCommand(fetchMock, i));
    const createCommand = allCommands.find((c) => c.includes("hermes cron create")) ?? "";
    expect(createCommand).toContain("--deliver 'origin'");
  });
});

describe("pickFallbackChannelFromStatusOutput", () => {
  const buildStatus = (platforms: Array<{ name: string; status: string }>) =>
    JSON.stringify({ success: true, data: { platforms } });

  it("picks wecom first when multiple channels are connected", () => {
    expect(pickFallbackChannelFromStatusOutput(buildStatus([
      { name: "feishu", status: "disconnected" },
      { name: "wecom", status: "connected" },
      { name: "weixin", status: "connected" },
      { name: "qqbot", status: "connected" },
    ]))).toBe("wecom");
  });

  it("respects priority order: weixin before qqbot before feishu", () => {
    expect(pickFallbackChannelFromStatusOutput(buildStatus([
      { name: "qqbot", status: "connected" },
      { name: "feishu", status: "connected" },
      { name: "weixin", status: "connected" },
    ]))).toBe("weixin");
    expect(pickFallbackChannelFromStatusOutput(buildStatus([
      { name: "feishu", status: "connected" },
      { name: "qqbot", status: "connected" },
    ]))).toBe("qqbot");
  });

  it("normalizes aliases (openclaw-wecom / lark) to notification keys", () => {
    expect(pickFallbackChannelFromStatusOutput(buildStatus([
      { name: "openclaw-lark", status: "running" },
    ]))).toBe("feishu");
    expect(pickFallbackChannelFromStatusOutput(buildStatus([
      { name: "openclaw-wecom", status: "ready" },
    ]))).toBe("wecom");
    expect(pickFallbackChannelFromStatusOutput(buildStatus([
      { name: "openclaw-slack", status: "connected" },
    ]))).toBe("slack");
  });

  it("normalizes OpenClaw DingTalk and prefers it over international fallback channels", () => {
    expect(pickFallbackChannelFromStatusOutput(buildStatus([
      { name: "telegram", status: "connected" },
      { name: "openclaw-dingtalk", status: "connected" },
    ]))).toBe("dingtalk");
  });

  it("falls back to Slack after Telegram, WhatsApp, and Discord", () => {
    expect(pickFallbackChannelFromStatusOutput(buildStatus([
      { name: "slack", status: "connected" },
      { name: "discord", status: "connected" },
    ]))).toBe("discord");
    expect(pickFallbackChannelFromStatusOutput(buildStatus([
      { name: "slack", status: "connected" },
    ]))).toBe("slack");
  });

  it("returns null when no channel is connected", () => {
    expect(pickFallbackChannelFromStatusOutput(buildStatus([
      { name: "wecom", status: "disconnected" },
      { name: "weixin", status: "disconnected" },
    ]))).toBeNull();
  });

  it("returns null for empty / unparseable output", () => {
    expect(pickFallbackChannelFromStatusOutput("")).toBeNull();
    expect(pickFallbackChannelFromStatusOutput("not json at all")).toBeNull();
  });

  it("tolerates leading log noise before the JSON body", () => {
    const noisy = `some log line\n${buildStatus([{ name: "telegram", status: "connected" }])}\ntrailing`;
    expect(pickFallbackChannelFromStatusOutput(noisy)).toBe("telegram");
  });
});

function okExec(output: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      data: {
        status: "SUCCESS",
        exit_code: 0,
        output,
      },
    }),
  };
}

function failedExec(output: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      data: {
        status: "FAILED",
        exit_code: 1,
        output,
      },
    }),
  };
}

function streamExec(chunks: string[]) {
  const encoder = new TextEncoder();
  return {
    ok: true,
    status: 200,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
  };
}

describe("parseCronListOutput execution status", () => {
  it("parses the current execution status from Hermes output", () => {
    const jobs = parseCronListOutput(`
  b87da865766e [active]
    Name:      cron-3
    Schedule:  once at 2026-08-25 19:45
    Next run:  2026-08-25T19:45:00+08:00
    Deliver:   qqbot
    Execution: RUNNING  8e441aecfe934d36a840d8eb6f02771c
`);

    expect(jobs[0]?.execution_status).toBe("running");
  });
});

describe("sendHermesChatNotice", () => {
  it("reports per-target results while continuing after one immediate notice fails", async () => {
    const client = await import("../hermes-cron-client") as unknown as {
      sendHermesChatNotice?: (
        botId: string,
        deliver: string,
        message: string,
      ) => Promise<{ sent: number; failed: number }>;
    };
    expect(client.sendHermesChatNotice).toBeTypeOf("function");
    if (!client.sendHermesChatNotice) return;

    const fetchMock = vi.fn(async (_url: unknown, init: { body?: string }) => {
      const command = JSON.parse(String(init.body)) as { command: string };
      if (command.command.includes("--to 'wecom'")) return failedExec("wecom unavailable");
      if (command.command.includes("--to 'qqbot:chat-1'")) return okExec("Sent.");
      throw new Error(`unexpected command in test: ${command.command}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(client.sendHermesChatNotice(
      "bot-1",
      "wecom,qqbot:chat-1",
      "LightVela 已添加新的定时任务。",
    )).resolves.toEqual({ sent: 1, failed: 1 });

    const commands = fetchMock.mock.calls.map((call) => {
      const init = call[1] as { body?: string };
      return (JSON.parse(String(init.body)) as { command: string }).command;
    });
    expect(commands).toHaveLength(2);
    expect(commands.some((command) => command.includes("--to 'wecom'"))).toBe(true);
    expect(commands.some((command) => command.includes("--to 'qqbot:chat-1'"))).toBe(true);
    expect(commands.every((command) => command.includes("LightVela 已添加新的定时任务。"))).toBe(true);
  });
});
