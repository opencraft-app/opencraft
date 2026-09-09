import assert from "node:assert/strict";
import test from "node:test";

import {
  buildHermesQrUrlCommand,
  parseHermesQrStream,
} from "../plugins/lightvela-hermes/src/management/channels/hermes-channel-client.ts";
import {
  getEligibleCronUpstreams,
  wouldCreateCronContextCycle,
} from "../plugins/lightvela-hermes/src/management/schedules/cron-context-policy.ts";
import type { CronJob } from "../plugins/lightvela-hermes/src/management/schedules/hermes-cron-client.ts";
import {
  buildClawhubInstallCommand,
  buildSkillsshInstallCommand,
  skillIdentity,
} from "../plugins/lightvela-hermes/src/management/skills/skill-registries.ts";

function cron(id: string, contextFrom: string[] = [], overrides: Partial<CronJob> = {}): CronJob {
  return {
    id,
    name: id,
    prompt: "",
    schedule: { kind: "cron", expr: "0 9 * * *", display: "0 9 * * *" },
    skills: [],
    enabled: true,
    state: "active",
    deliver: "local",
    next_run_at: null,
    last_run_at: null,
    last_status: null,
    created_at: null,
    script: "",
    effective_window: null,
    lightvela_schedule: null,
    context_from: contextFrom,
    context_from_hydrated: true,
    inference_config: null,
    ...overrides,
  };
}

test("Hermes QR command and parser preserve the mono2 acli protocol", () => {
  assert.equal(
    buildHermesQrUrlCommand({ platform: "feishu", isI18n: false }),
    "acli gateway qr-url --platform feishu --wait true --greeting 'Hi，我是你刚刚使用LightVela创建的机器人，你现在可以跟我聊天了！'",
  );
  assert.deepEqual(parseHermesQrStream([
    "starting",
    '{"platform":"weixin","status":"pending","url":"https://example/qr"}',
    '{"platform":"weixin","status":"success"}',
  ].join("\n")), { platform: "weixin", status: "success" });
  assert.deepEqual(parseHermesQrStream('{"platform":"weixin","error_code":"QR_CONFIG_FAILED"}'), {
    platform: "weixin",
    error_code: "QR_CONFIG_FAILED",
    status: "failed",
  });
});

test("cron upstream policy rejects paused, ended and cyclic dependencies", () => {
  const jobs = [
    cron("a", ["b"]),
    cron("b", ["c"]),
    cron("c"),
    cron("paused", [], { enabled: false, state: "paused" }),
    cron("ended", [], { state: "completed" }),
  ];
  assert.equal(wouldCreateCronContextCycle(jobs, "c", "a"), true);
  assert.deepEqual(getEligibleCronUpstreams(jobs, "c", Date.now()).map((job) => job.id), []);
  assert.deepEqual(getEligibleCronUpstreams(jobs, null, Date.now()).map((job) => job.id), ["a", "b", "c"]);
});

test("skill registry identity and install commands remain registry-specific", () => {
  assert.notEqual(
    skillIdentity({ registry: "clawhub", rawId: "frontend-design" }),
    skillIdentity({ registry: "skills-sh", rawId: "anthropics/skills/frontend-design" }),
  );
  assert.equal(buildClawhubInstallCommand("frontend-design"), "acli clawhub install 'frontend-design'");
  assert.equal(
    buildSkillsshInstallCommand("anthropics/skills/frontend-design"),
    "bash -lc 'cd \"$HOME\" && acli skills-sh install anthropics/skills/frontend-design'",
  );
});
