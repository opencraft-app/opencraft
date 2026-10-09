// Metro resolves .web/.native first. Tests and non-DOM tooling use the
// Native adapter while sharing exactly the same controlled contract.
export {SystemActionMenu} from "./system-action-menu.native";
export type {
  SystemActionMenuItem,
  SystemActionMenuProps,
} from "./system-action-menu.types";
