import {
  browserHostname,
  browserSearch,
} from "../../runtime/browser-location";
import {withCanonicalRouteSearch} from "../workspace/section-navigation";

export function currentBrowserHref(href: string): string {
  return withCanonicalRouteSearch(
    href,
    browserSearch(),
    browserHostname(),
  );
}
