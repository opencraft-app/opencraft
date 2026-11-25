import { WorkerEntrypoint } from "cloudflare:workers";
import { WORKSPACE_HOST_HEADER, workspaceHostObjectName } from "../workspace-host-routes.ts";
import { WORKSPACE_MODEL_INTERCEPT_HEADER } from "./workspace-host.ts";

export { default } from "./worker.ts";
export * from "./worker.ts";

/** A private container intercept with a route bound to one WorkspaceHost. */
export class WorkspaceCodexModelEgress extends WorkerEntrypoint {
  fetch(request) {
    const props = this.ctx.props;
    const workspaces = this.env.WORKSPACE_HOST;
    if (!props || !workspaces) return new Response(null, { status: 404 });
    const headers = new Headers(request.headers);
    headers.set(WORKSPACE_HOST_HEADER, props.workspace);
    headers.set(WORKSPACE_MODEL_INTERCEPT_HEADER, props.nonce);
    const id = workspaces.idFromName(workspaceHostObjectName(props.workspace));
    return workspaces.get(id).fetch(new Request(request, { headers }));
  }
}
