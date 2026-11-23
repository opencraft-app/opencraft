// WorkspaceHost stores in workerd (Miniflare, no Cloudflare account). The
// scenarios are shared with the real-Cloudflare rehearsal (`npm run cf:rehearsal`);
// see tests/storage/workerd/workspace-host.scenarios.ts and
// workspace-host-split.md §4.1 and §4.3.
import { testScenariosOnMiniflare } from "../cloudflare/node-test.ts";
import { WORKSPACE_HOST_SCENARIOS } from "./workerd/workspace-host.scenarios.ts";

testScenariosOnMiniflare("workspace-host-workerd", WORKSPACE_HOST_SCENARIOS);
