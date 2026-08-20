import { describe, expect, it } from "vitest";

import { createDebugExecRequestBody } from "@/lib/debug-exec-request";

describe("createDebugExecRequestBody for the China site", () => {
  it("lets the server select the execution backend", () => {
    expect(createDebugExecRequestBody("acli status")).toEqual({
      command: "acli status",
      run_as_user: "agentuser",
    });
  });
});
