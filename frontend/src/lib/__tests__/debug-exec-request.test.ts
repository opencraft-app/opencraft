import { describe, expect, it } from "vitest";

import { createDebugExecRequestBody } from "@/lib/debug-exec-request";

describe("createDebugExecRequestBody for the China site", () => {
  it("keeps the existing envd backend by omitting execution_backend", () => {
    expect(createDebugExecRequestBody("acli status")).toEqual({
      command: "acli status",
      run_as_user: "agentuser",
    });
  });
});
