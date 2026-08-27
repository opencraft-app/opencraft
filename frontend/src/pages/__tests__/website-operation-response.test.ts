import { describe, expect, it } from "vitest";

import { readWebsiteOperation } from "@/pages/marketing/agent-website-panel";

describe("website operation response compatibility", () => {
  it("reads the new snake_case DTO", () => {
    expect(readWebsiteOperation({
      operation_id: "wo-new",
      status: "success",
      error_message: "",
    })).toEqual({ operationID: "wo-new", status: "success", errorMessage: "" });
  });

  it("keeps compatibility with the legacy Go field names and normalizes status case", () => {
    expect(readWebsiteOperation({
      OperationID: "wo-old",
      Status: "SUCCESS",
      ErrorMessage: "legacy error",
    })).toEqual({ operationID: "wo-old", status: "success", errorMessage: "legacy error" });
  });
});
