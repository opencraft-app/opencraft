import { cleanup, render } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it } from "vitest";

import { getMDXComponents } from "./mdx-components";

afterEach(cleanup);

describe("LightVela docs callouts", () => {
  it("keeps a bold warning label separate from wrapping callout body text", () => {
    const Blockquote = getMDXComponents().blockquote!;
    const { container } = render(
      <Blockquote>
        <p>
          <strong>注意：</strong>
          只有在准备好重新配置可用模型时才重置模型配置。提供商临时故障或网络波动，不应作为第一次处理就直接重置。
        </p>
      </Blockquote>,
    );

    expect(container.querySelector(".lv-docs-callout__title")).toHaveTextContent(/^注意：$/);
    expect(container.querySelector(".lv-docs-callout__body")).toHaveTextContent(
      "只有在准备好重新配置可用模型时才重置模型配置。提供商临时故障或网络波动，不应作为第一次处理就直接重置。",
    );
  });
});
