// RelayHub prototype in workerd (Miniflare, no Cloudflare account). The
// scenarios are shared with the real-Cloudflare rehearsal (`npm run cf:rehearsal`);
// see tests/protocol/workerd/relay-hub.scenarios.ts and
// docs/architecture/platform/cloudflare-deployment.md ("RelayHub 原型结果").
import { testScenariosOnMiniflare } from "../cloudflare/node-test.ts";
import { RELAY_HUB_SCENARIOS } from "./workerd/relay-hub.scenarios.ts";

testScenariosOnMiniflare("relay-hub-workerd", RELAY_HUB_SCENARIOS);
