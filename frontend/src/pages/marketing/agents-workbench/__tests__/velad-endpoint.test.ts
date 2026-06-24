import { describe, expect, it } from "vitest";

import {
  isUsableVeladBaseUrl,
  LOCAL_VELAD_BASE_URL,
  resolveInitialVeladBaseUrl,
} from "@/pages/marketing/agents-workbench/velad-endpoint";

describe("agents workbench velad endpoint", () => {
  it("does not inherit the velalink demo proxy path in mono2", () => {
    expect(resolveInitialVeladBaseUrl({})).toBe("");
    expect(
      resolveInitialVeladBaseUrl({
        NEXT_PUBLIC_VELA_VELAD_BASE_URL: "/chat/api/velad/api/v1",
      }),
    ).toBe("");
    expect(isUsableVeladBaseUrl("/chat/api/velad/api/v1")).toBe(false);
  });

  it("accepts explicit local or remote velad endpoints", () => {
    expect(
      resolveInitialVeladBaseUrl({
        NEXT_PUBLIC_VELA_VELAD_BASE_URL: `${LOCAL_VELAD_BASE_URL}/`,
      }),
    ).toBe(LOCAL_VELAD_BASE_URL);
    expect(isUsableVeladBaseUrl(LOCAL_VELAD_BASE_URL)).toBe(true);
  });
});
