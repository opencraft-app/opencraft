import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deploymentPaths } from "./paths.mjs";
import { provisionedWorkspaces } from "./gateway-workspace.mjs";

// Operator entry for provisioned workspaces, run in the Gateway's image, mounts and
// environment while the Gateway is stopped (one WorkspaceHost writer at a time):
//   workspace-admin.mjs open|sleep|discard <workspace id>
// `open` places the workspace (create or re-attach) and prints its incarnation; `sleep`
// stops its container keeping the volume; `discard` removes container, volume and link.
const [operation, workspaceId] = process.argv.slice(2);
if (!["open", "sleep", "discard"].includes(operation) || !workspaceId) {
  console.error("Usage: workspace-admin.mjs open|sleep|discard <workspace id>");
  process.exit(2);
}
const local = await mkdtemp(join(tmpdir(), "opencraft-workspace-admin-"));
const workspaces = provisionedWorkspaces({
  dataDirectory: deploymentPaths().dataDirectory,
  credentialsRoot: local,
});
try {
  if (operation === "open") {
    const entry = await workspaces.open(workspaceId);
    console.log(JSON.stringify({ workspace: workspaceId, environments: await entry.observe() }));
  } else
    console.log(
      JSON.stringify({ workspace: workspaceId, [operation]: (await workspaces[operation](workspaceId)) ?? true }),
    );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await workspaces.close().catch(() => {});
  await rm(local, { recursive: true, force: true });
}
