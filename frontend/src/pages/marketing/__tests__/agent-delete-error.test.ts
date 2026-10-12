import { describe, expect, it } from "vitest";
import { getAgentDeleteErrorMessage } from "@/pages/marketing/agent-delete-error";

const t = (message: string) => message;

describe("Bot deletion errors", () => {
  it.each([false, true])("explains the Weixin disconnect step (embedded=%s)", (embedded) => {
    const error = Object.assign(new Error("channel is already connected to another bot（CHANNEL_OCCUPIED）"), {
      code: "CHANNEL_OCCUPIED",
      occupiedChannel: "weixin",
    });
    expect(getAgentDeleteErrorMessage(error, embedded, t)).toBe("请先断开该 Bot 的微信，再删除 Bot。");
  });

  it("explains WhatsApp independently", () => {
    const error = { code: "CHANNEL_OCCUPIED", occupiedChannel: "whatsapp" };
    expect(getAgentDeleteErrorMessage(error, false, t)).toBe("请先断开该 Bot 的 WhatsApp，再删除 Bot。");
  });

  it("does not guess a channel from unstructured server text", () => {
    const error = Object.assign(new Error("disconnect weixin before deleting bot sales"), { code: "CHANNEL_OCCUPIED" });
    expect(getAgentDeleteErrorMessage(error, false, t)).toBe(error.message);
  });

  it("keeps the remaining-Bot explanation", () => {
    expect(getAgentDeleteErrorMessage({ code: "INSTANCE_BOTS_REMAIN" }, true, t))
      .toBe("请先删除其他 Bot，再删除整个 Agent。");
  });

  it("keeps embedded unknown errors generic", () => {
    expect(getAgentDeleteErrorMessage(new Error("internal failure"), true, t))
      .toBe("删除失败，请稍后重试。");
  });

  it("preserves readable standalone errors", () => {
    expect(getAgentDeleteErrorMessage(new Error("permission denied"), false, t)).toBe("permission denied");
  });
});
