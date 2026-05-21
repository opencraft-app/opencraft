import type { ComponentProps, ReactNode } from "react";
import type { Components } from "streamdown";

export type LinkHookPayload = {
  href?: string;
  text: string;
};

export type ImageHookPayload = {
  alt?: string;
  src?: string;
  status: "load" | "error";
};

type AnchorRendererProps = Record<string, unknown> & {
  children?: ReactNode;
  href?: string;
  onClick?: ComponentProps<"a">["onClick"];
};

type ImageRendererProps = Record<string, unknown> & {
  alt?: string;
  onError?: ComponentProps<"img">["onError"];
  onLoad?: ComponentProps<"img">["onLoad"];
  src?: string;
};

export function createMarkdownComponents(
  onImage: (payload: ImageHookPayload) => void,
  onLink: (payload: LinkHookPayload) => void,
): Components {
  return {
    a: (rawProps) => {
      const { children, href, onClick, ...props } =
        rawProps as AnchorRendererProps;
      return (
        <a
          {...(props as Omit<
            ComponentProps<"a">,
            "children" | "href" | "onClick"
          >)}
          href={href}
          onClick={(event) => {
            onLink({ href, text: getTextContent(children) });
            onClick?.(event);
          }}
        >
          {children}
        </a>
      );
    },
    img: (rawProps) => {
      const { alt, onError, onLoad, src, ...props } =
        rawProps as ImageRendererProps;
      return (
        <img
          {...(props as Omit<
            ComponentProps<"img">,
            "alt" | "onError" | "onLoad" | "src"
          >)}
          alt={alt}
          src={src}
          onError={(event) => {
            onImage({ alt, src, status: "error" });
            onError?.(event);
          }}
          onLoad={(event) => {
            onImage({ alt, src, status: "load" });
            onLoad?.(event);
          }}
        />
      );
    },
  };
}

function getTextContent(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(getTextContent).join("");
  }
  return "";
}
