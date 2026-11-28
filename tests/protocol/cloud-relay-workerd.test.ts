import { testScenariosOnMiniflare } from "../cloudflare/node-test.ts";
import { CLOUD_RELAY_SCENARIOS } from "./workerd/cloud-relay.scenarios.ts";

testScenariosOnMiniflare("cloud-relay-workerd", CLOUD_RELAY_SCENARIOS);
