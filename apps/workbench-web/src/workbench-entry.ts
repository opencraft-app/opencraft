import {
  createWebWorkbenchApplication,
  type WebWorkbenchApplication,
} from "./runtime/web-workbench-application";
import { WorkbenchRoot } from "./workbench-root";

// Public names on a dynamic ESM boundary survive every standards-compliant
// minifier. Keep the semantic implementations internal and expose only the
// smallest opaque loader ABI.
export const a = createWebWorkbenchApplication;
export const b = WorkbenchRoot;
export type { WebWorkbenchApplication };
