import { createContext, useContext } from "react";
import type { PlatformStandardPageProps } from "@opencraft/extension-react";
import { AppShellRouteHeaderRegion } from "./app-shell-route-regions";
import "./app-shell-standard-page.scss";

/** A retained collection pane does not compete with its containing route for chrome. */
export const AppShellPageHeaderContext = createContext(true);

/** The existing Shell owns the only top bar. Features keep their own scrollports,
 * editor and actions; this frame never reparents content on capacity changes. */
export function AppShellStandardPage({ header, children, className }: PlatformStandardPageProps) {
  const ownsHeader = useContext(AppShellPageHeaderContext);
  return <div className={["app-shell-standard-page", className].filter(Boolean).join(" ")}>
    {ownsHeader && header !== undefined ? <AppShellRouteHeaderRegion>{header}</AppShellRouteHeaderRegion> : null}
    {children}
  </div>;
}
