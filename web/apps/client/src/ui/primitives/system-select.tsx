// Metro resolves .web/.native first. This generic module is the non-DOM
// fallback used by type-checking and test renderers.
export {SystemSelect} from "./system-select.native";
export type {
  ControlledOverlayProps,
  FocusableHandle,
  OverlayCloseReason,
  OverlayTriggerProps,
  SystemSelectOption,
  SystemSelectProps,
} from "./system-select.types";
