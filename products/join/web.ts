import { serverWorkbenchExtensions as coreExtensions, type ServerWorkbenchExtension } from "../../apps/workbench-web/src/runtime/server-product-extensions";
import { identityWorkbenchExtension } from './identity-web';

export const serverWorkbenchExtensions: readonly ServerWorkbenchExtension[] = [...coreExtensions, identityWorkbenchExtension];
