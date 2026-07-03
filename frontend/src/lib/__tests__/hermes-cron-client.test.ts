import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildEffectiveWindowScript,
  buildCreateCommand,
  buildTestRunMarker,
  createCronJob,
  createCronJobWithScriptRollback,
  execCommand,
  listCronJobs,
  listRecentCronRuns,
  parseCronRunFilesOutput,
  parseEffectiveWindowScript,
  parseLightVelaCronScript,
  parseCronListOutput,
  pickFallbackChannelFromStatusOutput,
  runCronJob,
  runCronJobAsTest,
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
      skills: [],
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
    }]);

    expect(runs).toEqual([{
      id: "job-1:/home/agentuser/.hermes/cron/output/job-1/2026-06-06T01-00-00.md",
      job_id: "job-1",
      job_name: "Morning sync",
      job_prompt: "Check overnight alerts.",
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
      job_schedule: "once at 2026-06-06 10:20",
      job_deliver: "local",
      job_last_run_at: "2026-06-06T02:20:16+00:00",
      job_last_status: "ok",
    }]), []);

    expect(runs[0]).toMatchObject({
      job_id: "once-1",
      job_name: "One shot reminder",
      job_prompt: "Remind me once.",
      schedule: { kind: "once", expr: "once at 2026-06-06 10:20", display: "once at 2026-06-06 10:20" },
      deliver: "local",
      status: "ok",
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

describe("listCronJobs", () => {
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

describe("parseCronRunFilesOutput display name", () => {
  it("renders a test-run temp job as its clean 「{原任务名}测试运行」 in run history", () => {
    const tempName = buildTestRunMarker("abc12345ffff", "喝水提醒");
    const runs = parseCronRunFilesOutput(JSON.stringify([{
      job_id: "temp-xyz",
      run_at: "2026-07-03T02:20:16+00:00",
      output_path: "/home/agentuser/.hermes/cron/output/temp-xyz/2026-07-03T02-20-16.md",
      mtime_ms: 1780712416000,
      job_name: tempName,
    }]), []);

    expect(runs[0]?.job_name).toBe("喝水提醒测试运行");
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
  };

  function extractCommand(fetchMock: ReturnType<typeof vi.fn>, callIndex: number): string {
    const body = JSON.parse(String(fetchMock.mock.calls[callIndex]?.[1]?.body)) as { command: string };
    return body.command;
  }

  function extractMarkerFromCreateCommand(command: string): string {
    return /--name '([^']+)'/.exec(command)?.[1] ?? "";
  }

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
    // 复现线上真实故障：在网页「自动任务」面板/无会话上下文下创建的任务，
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
