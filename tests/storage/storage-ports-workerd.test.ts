// Runs the shared storage-port conformance suites against the Cloudflare
// adapters inside workerd (Miniflare, in-memory storage, no network or
// Cloudflare account). The scenarios are shared with the real-Cloudflare
// rehearsal (`npm run cf:rehearsal`). See docs/architecture/platform/storage-ports.md.
import { testScenariosOnMiniflare } from "../cloudflare/node-test.ts";
import { STORAGE_PORTS_SCENARIOS } from "./workerd/storage-ports.scenarios.ts";

testScenariosOnMiniflare("storage-ports-workerd", STORAGE_PORTS_SCENARIOS);
