#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMPDIR="$(mktemp -d)"
trap 'rm -rf -- "${TMPDIR}"' EXIT
export LIGHTVELA_DSH_TEST_MODE=1
export LIGHTVELA_DSH_TEST_ROOT="${TMPDIR}/root"
source "${ROOT_DIR}/images/helpers/install-deepseek-harness.sh"

runtime="${TMPDIR}/runtime"
entry="${runtime}/node_modules/@deepseek-ai/dsh-client-connection/lib/index.js"
mkdir -p "$(dirname "${entry}")"
cat >"${entry}" <<'JS'
const AUTH_RECORD_KEY = "native-auth";
const TOKEN_QUERY = "token";
const COOKIE_PAYLOAD_VERSION = 1;
const header = (headers, name) => headers[name];
const requestAuthority = (headers) => headers.host;
const isTrustedApiRequest = (req) => req.nativeTrusted === true;
const encodeCookie = (value) => JSON.stringify(value);
const cookieName = () => "native-session";
const sessionCookie = (name, value) => `${name}=${value}`;
class BrowserAuth {
    constructor(authenticated = false) {
        this.authenticated = authenticated;
        this.maxAgeMilliseconds = 60000;
        this.secret = "fixture";
    }
    isAuthenticated() { return this.authenticated; }

	authorizeIndex(req, res) {
        return "native-auth";
    }
}
module.exports = BrowserAuth;
JS
printf '%s\n' '{"browserTrustPatch":{"version":3,"hostname":"ins-0123456789abcdef0123456789abcdef.dsh.lightvela.site"}}' >"${TMPDIR}/manifest.json"
patch_gateway_browser_bootstrap "${runtime}" "${TMPDIR}/manifest.json" >/dev/null
first_hash="$(sha256sum "${entry}" | cut -d' ' -f1)"
patch_gateway_browser_bootstrap "${runtime}" "${TMPDIR}/manifest.json" >/dev/null
test "${first_hash}" = "$(sha256sum "${entry}" | cut -d' ' -f1)"

node - "${entry}" <<'JS'
const assert = require("node:assert/strict");
const BrowserAuth = require(process.argv[2]);
const trustedHost = "ins-0123456789abcdef0123456789abcdef.dsh.lightvela.site";
const base = {
    method: "GET", url: "/", socket: { remoteAddress: "127.0.0.1" },
    headers: {
        host: "127.0.0.1:3080", "x-forwarded-host": trustedHost,
        "x-forwarded-proto": "https", "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "document",
    },
};
function invoke(request, authenticated = false) {
    const headers = {};
    const result = new BrowserAuth(authenticated).authorizeIndex(request, {
        setHeader: (name, value) => { headers[name] = value; },
    });
    return { result, headers };
}
const accepted = invoke(base);
assert.equal(accepted.result, true);
assert.ok(accepted.headers["set-cookie"].endsWith("; Secure"));
assert.equal(accepted.headers["cache-control"], "no-store");
for (const change of [
    { method: "POST" },
    { url: "/api/private" },
    { url: "/?token=fixture" },
    { socket: { remoteAddress: "203.0.113.1" } },
    { headers: { ...base.headers, host: "example.invalid:3080" } },
    { headers: { ...base.headers, "x-forwarded-host": "attacker.invalid" } },
    { headers: { ...base.headers, "x-forwarded-proto": "http" } },
    { headers: { ...base.headers, origin: "https://attacker.invalid" } },
    { headers: { ...base.headers, "sec-fetch-mode": "cors" } },
    { headers: { ...base.headers, "sec-fetch-dest": "iframe" } },
]) {
    const denied = invoke({ ...base, ...change });
    assert.equal(denied.result, "native-auth", JSON.stringify(change));
    assert.equal(denied.headers["set-cookie"], undefined);
}
assert.equal(invoke(base, true).result, "native-auth");
const probe = { ...base, nativeTrusted: true, headers: { host: "127.0.0.1:3080" } };
assert.equal(invoke(probe).result, true);
assert.equal(invoke({ ...probe, nativeTrusted: false }).result, "native-auth");
JS

echo "deepseek harness browser bootstrap tests passed"
