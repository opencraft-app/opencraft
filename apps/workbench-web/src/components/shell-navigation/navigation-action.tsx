export interface NavigationAction {
  readonly id: string;
  readonly title: string;
  readonly icon?: string;
  readonly active?: boolean;
  readonly onInvoke: () => void;
}

/** Shared by contributed catalogs, application lists and their entrance preview. */
export { WorkbenchIcon as NavigationIcon } from "../ui/workbench-icon";
