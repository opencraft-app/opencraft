import { describe, expect, it, vi } from "vitest";

import zhToKey from "../generated/zh-to-key.json";
import {
  DEFAULT_HERMES_AGENT_NAME_FALLBACK,
  DEFAULT_HERMES_AGENT_NAME_I18N_KEY,
  resolveDefaultHermesAgentName,
} from "../default-agent-name";

describe("default Hermes agent name", () => {
  it("keeps the lightweight key aligned with the generated dictionary map", () => {
    expect(DEFAULT_HERMES_AGENT_NAME_I18N_KEY).toBe(zhToKey["我的Hermes"]);
  });

  it("translates the fixed key without importing the full Chinese lookup map", () => {
    const translate = vi.fn(() => "My Hermes");

    expect(resolveDefaultHermesAgentName(translate)).toBe("My Hermes");
    expect(translate).toHaveBeenCalledWith(DEFAULT_HERMES_AGENT_NAME_I18N_KEY, {
      defaultValue: DEFAULT_HERMES_AGENT_NAME_FALLBACK,
    });
  });

  it("falls back to the Chinese source copy when i18n is unavailable", () => {
    expect(resolveDefaultHermesAgentName()).toBe("我的Hermes");
    expect(resolveDefaultHermesAgentName(() => "")).toBe("我的Hermes");
  });
});
