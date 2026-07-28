import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/region", () => ({
  isGlobal: true,
}));

import { createDebugExecRequestBody } from "@/lib/debug-exec-request";

describe("createDebugExecRequestBody for the global site", () => {
  it("selects the TAT PTY execution backend", () => {
    expect(createDebugExecRequestBody("acli status")).toEqual({
      command: "acli status",
      run_as_user: "agentuser",
      execution_backend: "tat",
    });
  });
});
