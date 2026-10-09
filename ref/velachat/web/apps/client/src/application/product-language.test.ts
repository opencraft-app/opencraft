import {PlatformError} from "@vela/client-core";

import {
  normalizeProductError,
  productErrorMessage,
  productErrorPresentation,
} from "./product-language";

describe("product error language", () => {
  it("turns HTTP 405 protocol failures into an actionable stable error", () => {
    const error = new PlatformError(
      "PROTOCOL",
      "平台返回了未预期的 HTTP 405",
    );

    expect(normalizeProductError(error, "invite.create")).toEqual({
      code: "method_not_allowed",
      detail: "平台返回了未预期的 HTTP 405",
      scope: "invite.create",
    });
    expect(productErrorMessage(error)).toBe(
      "当前服务版本暂不支持此操作，请刷新页面后重试",
    );
  });

  it("keeps technical detail out of the default user-facing title", () => {
    const error = normalizeProductError(
      new PlatformError("NETWORK", "fetch failed: ECONNRESET"),
      "server.load",
    );

    expect(productErrorPresentation(error).message).toBe("网络连接不可用");
    expect(productErrorPresentation(error).nextStep).toBe("检查网络后重试");
    expect(productErrorPresentation(error).message).not.toContain("ECONNRESET");
  });
});
