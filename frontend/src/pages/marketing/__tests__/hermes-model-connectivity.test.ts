import { describe, expect, it } from "vitest";
import {
  buildModelConnectivityTestResult,
  parseAcliModelTestOutput,
} from "@/pages/marketing/hermes-model-connectivity";

describe("parseAcliModelTestOutput", () => {
  it("parses the JSON returned by acli model probe", () => {
    const parsed = parseAcliModelTestOutput(JSON.stringify({
      data: {
        model: "deepseek-v4-flash",
        provider: "deepseek",
        success: true,
        time_ms: 758,
        results: [{ model: "deepseek-v4-flash", success: true, time_ms: 757 }],
      },
      success: true,
    }));

    expect(parsed?.success).toBe(true);
    expect(parsed?.data?.provider).toBe("deepseek");
    expect(parsed?.data?.results?.[0]?.success).toBe(true);
  });

  it("ignores shell prompts and ANSI output around the JSON", () => {
    const output = "agentuser@VM:~$ acli model probe\n\u001b[32m{\"success\":true,\"data\":{\"message\":\"ok\"}}\u001b[0m\nagentuser@VM:~$";
    expect(parseAcliModelTestOutput(output)?.data?.message).toBe("ok");
  });

  it("returns null when the command did not produce JSON", () => {
    expect(parseAcliModelTestOutput("acli: command not found")).toBeNull();
  });
});

describe("buildModelConnectivityTestResult", () => {
  it("requires both a successful command and successful ACLI payload", () => {
    const result = buildModelConnectivityTestResult({
      status: "SUCCESS",
      exitCode: 0,
      output: JSON.stringify({ data: { success: true }, success: true }),
      stdout: JSON.stringify({ data: { success: true }, success: true }),
      stderr: "",
    });
    expect(result.success).toBe(true);
    expect(result.outcome).toBe("connected");
  });

  it("distinguishes configured credentials from an actual model test", () => {
    const result = buildModelConnectivityTestResult({
      status: "SUCCESS",
      exitCode: 0,
      output: JSON.stringify({
        data: { agent: "default", configured: true, message: "API Key 已配置", provider: "custom" },
        success: true,
      }),
    });
    expect(result.success).toBe(false);
    expect(result.outcome).toBe("configured");
  });

  it("keeps the command failure visible even when output contains JSON", () => {
    const result = buildModelConnectivityTestResult({
      status: "FAILED",
      exitCode: 1,
      output: JSON.stringify({ data: { success: false }, success: false }),
    });
    expect(result.success).toBe(false);
    expect(result.outcome).toBe("failed");
    expect(result.parsed?.success).toBe(false);
  });
});
