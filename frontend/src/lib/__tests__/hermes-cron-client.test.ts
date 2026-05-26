import { describe, expect, it } from "vitest";

import { parseCronListOutput } from "../hermes-cron-client";

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
});
