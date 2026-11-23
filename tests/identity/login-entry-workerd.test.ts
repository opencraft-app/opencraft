// Login entry prototype for the Cloudflare InstallationCore, in workerd
// (Miniflare, nodejs_compat, no Cloudflare account). The scenarios are shared
// with the real-Cloudflare rehearsal (`npm run cf:rehearsal`); see
// tests/identity/workerd/login-entry.scenarios.ts and
// docs/architecture/platform/gateway-split.md ("登录入口原型结果").
import { testScenariosOnMiniflare } from "../cloudflare/node-test.ts";
import { LOGIN_ENTRY_SCENARIOS } from "./workerd/login-entry.scenarios.ts";

testScenariosOnMiniflare("login-entry-workerd", LOGIN_ENTRY_SCENARIOS);
