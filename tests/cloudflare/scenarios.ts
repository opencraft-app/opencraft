// Every shared Cloudflare prototype scenario group, in rehearsal order. The
// Miniflare tests import their group directly; the real-Cloudflare rehearsal
// (scripts/cloudflare/rehearsal.ts) runs all of them.
import type { WorkerScenario } from "./worker-runtime.ts";
import { STORAGE_PORTS_SCENARIOS } from "../storage/workerd/storage-ports.scenarios.ts";
import { INSTALLATION_CORE_SCENARIOS } from "../storage/workerd/installation-core.scenarios.ts";
import { INSTALLATION_CORE_DO_SCENARIOS } from "../storage/workerd/installation-core-do.scenarios.ts";
import { ACCOUNT_CORE_DO_SCENARIOS } from "../storage/workerd/account-core-do.scenarios.ts";
import { WORKSPACE_HOST_SCENARIOS } from "../storage/workerd/workspace-host.scenarios.ts";
import { DEPLOYMENT_STORE_SCENARIOS } from "../storage/workerd/deployment-stores.scenarios.ts";
import { INSTALLATION_STORE_SCENARIOS } from "../storage/workerd/installation-stores.scenarios.ts";
import { WORKSPACE_STORE_SCENARIOS } from "../storage/workerd/workspace-stores.scenarios.ts";
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
    id: "installation-core-do",
    label: "InstallationCore Durable Object (installation module, front door, Node parity, eviction, alarm watches)",
    scenarios: INSTALLATION_CORE_DO_SCENARIOS,
  },
  {
    id: "account-core-do",
    label: "AccountCore Durable Object (account module, policy front door behind the installation gate, sealed credentials, leases, Node parity)",
    scenarios: ACCOUNT_CORE_DO_SCENARIOS,
  },
  {
    id: "workspace-host",
    label: "WorkspaceHost stores (five migration chains, domain operations, alarm owners)",
    scenarios: WORKSPACE_HOST_SCENARIOS,
  },
  {
    id: "deployment-stores",
    label: "Deployment stores (push, MCP apps, connectors on DO SQL)",
    scenarios: DEPLOYMENT_STORE_SCENARIOS,
  },
  {
    id: "installation-stores",
    label: "InstallationCore stores (admission projection, Server spaces, orchestration runtime on DO SQL)",
    scenarios: INSTALLATION_STORE_SCENARIOS,
  },
  {
    id: "workspace-stores",
    label: "WorkspaceHost stores (thread directory, employee Git vault on DO SQL)",
    scenarios: WORKSPACE_STORE_SCENARIOS,
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
