import type { ComponentProps, ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { streamdownProps } = vi.hoisted(() => ({
  streamdownProps: [] as Array<{
    animated?: boolean;
    children: ReactNode;
    isAnimating?: boolean;
    mode?: string;
    plugins?: Record<string, unknown>;
  }>,
}));

vi.mock("streamdown", () => ({
  Streamdown: (props: {
    animated?: boolean;
    children: ReactNode;
    isAnimating?: boolean;
    mode?: string;
    plugins?: Record<string, unknown>;
  }) => {
    streamdownProps.push(props);
    return <div data-mode={props.mode}>{props.children}</div>;
  },
}));

import { MarkdownContent } from "./MarkdownContent";
import { createMarkdownComponents } from "./markdownComponents";

describe("MarkdownContent", () => {
  beforeEach(() => {
    streamdownProps.length = 0;
  });

  it("passes streaming state and the default Streamdown plugin set", () => {
    renderToStaticMarkup(
      <MarkdownContent isAnimating text="```ts\nconst ok = true\n```" />,
    );

    expect(streamdownProps).toHaveLength(1);
    expect(streamdownProps[0]).toMatchObject({
      animated: false,
      isAnimating: true,
      mode: "streaming",
    });
    expect(Object.keys(streamdownProps[0].plugins ?? {}).sort()).toEqual([
      "cjk",
      "math",
    ]);
  });

  it("renders static mode when the message is not streaming", () => {
    const html = renderToStaticMarkup(
      <MarkdownContent isAnimating={false} text="[Open](https://example.com)" />,
    );

    expect(streamdownProps[0]).toMatchObject({
      isAnimating: false,
      mode: "static",
    });
    expect(html).toContain("[Open](https://example.com)");
  });

  it("reports link and image hook payloads from renderer components", () => {
    const links: unknown[] = [];
    const images: unknown[] = [];
    const components = createMarkdownComponents(
      (payload) => images.push(payload),
      (payload) => links.push(payload),
    );
    const renderAnchor = components.a as (
      props: ComponentProps<"a">,
    ) => ReactElement<ComponentProps<"a">>;
    const renderImage = components.img as (
      props: ComponentProps<"img">,
    ) => ReactElement<ComponentProps<"img">>;
    const anchor = renderAnchor({
      children: ["Open"],
      href: "https://example.com",
    });
    const image = renderImage({
      alt: "diagram",
      src: "https://example.com/a.png",
    });

    anchor.props.onClick?.(
      {} as Parameters<NonNullable<typeof anchor.props.onClick>>[0],
    );
    image.props.onLoad?.(
      {} as Parameters<NonNullable<typeof image.props.onLoad>>[0],
    );
    image.props.onError?.(
      {} as Parameters<NonNullable<typeof image.props.onError>>[0],
    );

    expect(links).toEqual([{ href: "https://example.com", text: "Open" }]);
    expect(images).toEqual([
      { alt: "diagram", src: "https://example.com/a.png", status: "load" },
      { alt: "diagram", src: "https://example.com/a.png", status: "error" },
    ]);
  });
});
