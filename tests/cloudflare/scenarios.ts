// Every shared Cloudflare prototype scenario group, in rehearsal order. The
// Miniflare tests import their group directly; the real-Cloudflare rehearsal
// (scripts/cloudflare/rehearsal.ts) runs all of them.
import type { WorkerScenario } from "./worker-runtime.ts";
import { STORAGE_PORTS_SCENARIOS } from "../storage/workerd/storage-ports.scenarios.ts";
import { INSTALLATION_CORE_SCENARIOS } from "../storage/workerd/installation-core.scenarios.ts";
import { WORKSPACE_HOST_SCENARIOS } from "../storage/workerd/workspace-host.scenarios.ts";
import { LOGIN_ENTRY_SCENARIOS } from "../identity/workerd/login-entry.scenarios.ts";
import { HTTP_EXCHANGE_SCENARIOS } from "../server/workerd/http-exchange.scenarios.ts";
import { CLIENT_DO_SCENARIOS } from "../protocol/workerd/client-do.scenarios.ts";
import { RELAY_HUB_SCENARIOS } from "../protocol/workerd/relay-hub.scenarios.ts";

export interface ScenarioGroup {
  readonly id: string;
  readonly label: string;
  readonly scenarios: readonly WorkerScenario[];
}

export const SCENARIO_GROUPS: readonly ScenarioGroup[] = [
  { id: "storage-ports", label: "Storage ports (DO SQL / state / secrets, R2)", scenarios: STORAGE_PORTS_SCENARIOS },
  {
    id: "installation-core",
    label: "InstallationCore (Server migrations and access-control domain on DO SQL)",
    scenarios: INSTALLATION_CORE_SCENARIOS,
  },
  {
    id: "workspace-host",
    label: "WorkspaceHost stores (five migration chains, domain operations, alarm owners)",
    scenarios: WORKSPACE_HOST_SCENARIOS,
  },
  { id: "login-entry", label: "Login entry (Argon2id, HumanAuth on DO SQL)", scenarios: LOGIN_ENTRY_SCENARIOS },
  {
    id: "http-exchange",
    label: "HTTP exchange services (server information on DO state, streamed bodies)",
    scenarios: HTTP_EXCHANGE_SCENARIOS,
  },
  {
    id: "client-do",
    label: "Client DO (hibernatable sockets, resume cursors, alarms)",
    scenarios: CLIENT_DO_SCENARIOS,
  },
  { id: "relay-hub", label: "RelayHub (control link, stream budget, reservations)", scenarios: RELAY_HUB_SCENARIOS },
];
