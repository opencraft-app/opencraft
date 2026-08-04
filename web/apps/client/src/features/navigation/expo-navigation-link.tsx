import {Link, type Href} from "expo-router";
import type {ComponentProps} from "react";
import type {NavigationLinkProps} from "@/ui";
import {currentBrowserHref} from "./browser-navigation";

type LinkStyle = ComponentProps<typeof Link>["style"];
type PressableStyleCallback = (state: {
  hovered: boolean;
  pressed: boolean;
}) => LinkStyle;

export function ExpoNavigationLink({
  children,
  href,
}: NavigationLinkProps) {
  const canonicalHref = currentBrowserHref(href);
  const childStyle = (children.props as {style?: unknown}).style;
  // Expo Router's web Link lays out the outer anchor from its own style.
  // Forwarding a Pressable callback unchanged makes the anchor collapse to
  // the icon's intrinsic size while the child still paints its full surface.
  // Resolve the resting state so navigation rows keep their intended hit area
  // and do not overlap each other in flex layouts.
  const linkStyle =
    typeof childStyle === "function"
      ? (childStyle as PressableStyleCallback)({
          hovered: false,
          pressed: false,
        })
      : (childStyle as LinkStyle);
  return (
    <Link
      asChild
      href={canonicalHref as Href}
      style={linkStyle}
    >
      {children}
    </Link>
  );
}
