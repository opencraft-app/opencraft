import { describe, expect, it } from "vitest";

import { composeDebugExecCommandLifecycles } from "@/pages/marketing/agent-debug-exec-lifecycle";
import type { DebugExecCommandLifecycle } from "@/pages/marketing/agent-tat-adapter";

describe("composeDebugExecCommandLifecycles", () => {
  it("applies command transforms in order", async () => {
    const first: DebugExecCommandLifecycle = {
      transformCommand: ({ command }) => `${command}\nfirst`,
    };
    const second: DebugExecCommandLifecycle = {
      transformCommand: ({ command }) => `${command}\nsecond`,
    };

    const lifecycle = composeDebugExecCommandLifecycles(first, second);

    await expect(lifecycle.transformCommand?.({ botId: "bot-1", command: "base" }))
      .resolves.toBe("base\nfirst\nsecond");
  });

  it("preserves per-lifecycle metadata between before and after hooks", async () => {
    const calls: string[] = [];
    const first: DebugExecCommandLifecycle = {
      beforeExecute: async ({ command }) => ({ name: "first", command }),
      afterExecute: async ({ metadata }) => {
        calls.push(`first:${String((metadata as { name?: string })?.name)}`);
      },
    };
    const second: DebugExecCommandLifecycle = {
      beforeExecute: async ({ command }) => ({ name: "second", command }),
      afterExecute: async ({ metadata }) => {
        calls.push(`second:${String((metadata as { name?: string })?.name)}`);
      },
    };

    const lifecycle = composeDebugExecCommandLifecycles(first, second);
    const metadata = await lifecycle.beforeExecute?.({ botId: "bot-1", command: "cmd" });
    await lifecycle.afterExecute?.({
      botId: "bot-1",
      command: "cmd",
      metadata,
      result: { status: "SUCCESS", exitCode: 0, output: "" },
    });

    expect(calls).toEqual(["first:first", "second:second"]);
  });
});
