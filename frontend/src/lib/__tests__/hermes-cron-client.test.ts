import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildCreateCommand,
  createCronJob,
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
});

describe("createCronJob auth handling", () => {
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
