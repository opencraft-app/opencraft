// InstallationCore Durable Object prototype in workerd (Miniflare, no
// Cloudflare account). The scenarios are shared with the real-Cloudflare
// rehearsal (`npm run cf:rehearsal`); see
// tests/storage/workerd/installation-core.scenarios.ts and
// docs/architecture/platform/cloudflare-deployment.md ("InstallationCore prototype status").
import { testScenariosOnMiniflare } from "../cloudflare/node-test.ts";
import { INSTALLATION_CORE_SCENARIOS } from "./workerd/installation-core.scenarios.ts";

testScenariosOnMiniflare("installation-core-workerd", INSTALLATION_CORE_SCENARIOS);
