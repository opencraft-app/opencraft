// Headless HTTP services on the runtime-neutral exchange port, in workerd
// (Miniflare, no Cloudflare account). Scenarios are shared with the
// real-Cloudflare rehearsal; see tests/server/workerd/http-exchange.scenarios.ts
// and docs/architecture/platform/gateway-split.md §4.2 (G4).
import { testScenariosOnMiniflare } from "../cloudflare/node-test.ts";
import { HTTP_EXCHANGE_SCENARIOS } from "./workerd/http-exchange.scenarios.ts";

testScenariosOnMiniflare("http-exchange-workerd", HTTP_EXCHANGE_SCENARIOS);
