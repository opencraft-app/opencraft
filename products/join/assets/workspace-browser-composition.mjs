import { createWorkspaceBrowserRouting } from './workspace-browser-routing.mjs';
import { createWorkspaceBrowserRouter } from './workspace-browser-router.mjs';

/** Install once before central browser startup. Keep a single local physical owner
 * and central page store; all nonlocal routes require explicit admitted leases. */
export function installWorkspaceBrowserRouting({service, resolveConversation}) {
  const localConnector = service.ownerConnector;
  if (typeof localConnector !== 'function' || typeof resolveConversation !== 'function')
    throw Error('Workspace browser routing requires an explicit local browser owner');
  service.ownerConnector = options => {
    let peer;
    const local = {
      assertCurrent() { if (service.closed) throw Error('Browser service closed'); },
      connect() { return peer ??= localConnector(options); },
    };
    const routing = createWorkspaceBrowserRouting({service,
      resolveConversation: descriptor => resolveConversation(descriptor, local),
    });
    return createWorkspaceBrowserRouter(routing);
  };
}
