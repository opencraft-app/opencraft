import { describe, expect, it } from "vitest";

import {
  QQBOT_GROUP_POLICY_OPEN_COMMAND,
  buildQqbotGroupPolicyInjectedCommand,
  isQqbotConnectCommand,
  isQqbotGroupPolicyOpenCommand,
} from "@/pages/marketing/agent-qqbot-group-policy";

describe("QQ bot group policy command helpers", () => {
  it("recognizes QQ bot manual and QR connect commands", () => {
    expect(isQqbotConnectCommand("acli configure gateway qqbot --app-id '123' --client-secret 'secret'")).toBe(true);
    expect(isQqbotConnectCommand("acli gateway qr-url --platform qqbot --wait true")).toBe(true);
    expect(isQqbotConnectCommand("acli gateway qr-url --wait true --platform=qqbot")).toBe(true);
  });

  it("does not treat unrelated commands as QQ bot connect commands", () => {
    expect(isQqbotConnectCommand("acli gateway qr-url --platform feishu --wait true")).toBe(false);
    expect(isQqbotConnectCommand("acli model switch --model 'openai/gpt-4o'")).toBe(false);
    expect(isQqbotConnectCommand(QQBOT_GROUP_POLICY_OPEN_COMMAND)).toBe(false);
  });

  it("identifies the exact group policy open command", () => {
    expect(isQqbotGroupPolicyOpenCommand(QQBOT_GROUP_POLICY_OPEN_COMMAND)).toBe(true);
    expect(isQqbotGroupPolicyOpenCommand(`${QQBOT_GROUP_POLICY_OPEN_COMMAND}\nacli configure gateway qqbot`)).toBe(false);
  });

  it("injects group policy before the original QQ bind command", () => {
    const original = "acli configure gateway qqbot --app-id '123' --client-secret 'secret'";
    const injected = buildQqbotGroupPolicyInjectedCommand(original);

    expect(injected.split("\n")).toEqual([
      "set -e",
      QQBOT_GROUP_POLICY_OPEN_COMMAND,
      original,
    ]);
  });

  it("does not inject group policy twice", () => {
    const original = "acli gateway qr-url --platform qqbot --wait true";
    const once = buildQqbotGroupPolicyInjectedCommand(original);
    const twice = buildQqbotGroupPolicyInjectedCommand(once);

    expect(twice).toBe(once);
    expect(twice.match(new RegExp(QQBOT_GROUP_POLICY_OPEN_COMMAND, "g"))).toHaveLength(1);
  });
});
