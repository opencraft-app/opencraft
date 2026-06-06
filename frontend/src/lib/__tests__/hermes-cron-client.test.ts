import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildEffectiveWindowScript,
  buildCreateCommand,
  createCronJob,
  createCronJobWithScriptRollback,
  listCronJobs,
  listRecentCronRuns,
  parseCronRunFilesOutput,
  parseEffectiveWindowScript,
  parseCronListOutput,
  shellQuote,
  splitLastRunValue,
} from "../hermes-cron-client";
import { AUTH_UNAUTHORIZED_EVENT, writeStoredAuthToken } from "@/repositories/http-repositories";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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
    });

    expect(script).toContain("lightvela-effective-window");
    expect(parseEffectiveWindowScript(script)).toEqual({
      start_at: "2026-06-10T00:00",
      end_at: "2026-06-19T23:59",
    });
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
});

describe("createCronJob auth handling", () => {
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
