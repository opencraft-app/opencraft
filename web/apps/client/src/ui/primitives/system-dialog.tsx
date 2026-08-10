// Metro resolves .web/.native first. Tests and non-DOM tooling use the
// Native adapter while sharing exactly the same controlled contract.
export {SystemDialog} from "./system-dialog.native";
export type {
  DialogCloseReason,
  SystemDialogAction,
  SystemDialogProps,
} from "./system-dialog.types";
