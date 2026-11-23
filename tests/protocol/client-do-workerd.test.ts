// Client DO prototype in workerd (Miniflare, no Cloudflare account). The
// scenarios are shared with the real-Cloudflare rehearsal (`npm run cf:rehearsal`);
// see tests/protocol/workerd/client-do.scenarios.ts and
// docs/architecture/platform/gateway-split.md ("Client DO 原型结果").
import { testScenariosOnMiniflare } from "../cloudflare/node-test.ts";
import { CLIENT_DO_SCENARIOS } from "./workerd/client-do.scenarios.ts";

testScenariosOnMiniflare("client-do-workerd", CLIENT_DO_SCENARIOS);
