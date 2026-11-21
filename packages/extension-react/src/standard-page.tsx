import type { ReactNode } from "react";
import type { PlatformStandardPageProps, PlatformViewRegions } from "./index";

/** Use the host's standard frame without importing Shell implementation details.
 * Unhosted consumers retain a visible, in-flow header. */
export function StandardPage({ regions, ...props }: PlatformStandardPageProps & {
  readonly regions?: PlatformViewRegions;
}) {
  const Page = regions?.Page;
  if (Page) return <Page {...props} />;
  const Header = regions?.Header;
  return <div className={props.className}>
    {props.header === undefined ? null : Header
      ? <Header>{props.header}</Header> : <header>{props.header}</header>}
    {props.children}
  </div>;
}

/** Shared compact page title for the platform Header or standalone fallback. */
export function StandardPageTitle({ children }: { readonly children: ReactNode }) {
  return <h2 className="standard-page-title">{children}</h2>;
}
