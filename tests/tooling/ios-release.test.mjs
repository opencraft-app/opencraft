import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

test("the unsigned IPA workflow builds without any Apple credential", () => {
  const unsigned = read(".github/workflows/ios-unsigned-ipa.yml");
  assert.match(unsigned, /^ {2}workflow_dispatch:\n {2}workflow_call:\n/mu);
  // No secrets and no environment: any branch may run it, and nothing can leak.
  assert.doesNotMatch(unsigned, /secrets\.|environment:/u);
  assert.match(unsigned, /OPENCRAFT_IOS_EXPORT_METHOD: unsigned/u);
  assert.match(unsigned, /package-manager-cache: false/u);
  assert.match(unsigned, /test ! -e "\$application\/_CodeSignature"/u);
  assert.match(unsigned, /test ! -e "\$application\/embedded\.mobileprovision"/u);
  assert.match(unsigned, /name: opencraft-ios-unsigned-\$\{\{ github\.sha \}\}/u);
});

test("an app release uploads to TestFlight without waiting for beta review", () => {
  const testflight = read(".github/workflows/ios-testflight.yml");
  const call = testflight.match(/^ {2}workflow_call:\n([\s\S]*?)\n\npermissions:/mu)?.[1];
  assert.ok(call, "callable from the app release");
  assert.match(call, /check_availability:\n {8}type: boolean\n {8}default: false/u);
  for (const name of [
    "ASC_API_KEY_ID",
    "ASC_API_ISSUER_ID",
    "ASC_API_PRIVATE_KEY_BASE64",
    "APPLE_TEAM_ID",
    "IOS_CERTIFICATE_P12_BASE64",
    "IOS_CERTIFICATE_PASSWORD",
    "IOS_PROVISIONING_PROFILE_BASE64",
  ]) {
    assert.ok(call.includes(`      ${name}:\n        required: true`), name);
  }
  assert.match(call, /number:\n[^\n]*\n {8}value: \$\{\{ jobs\.build\.outputs\.number \}\}/u);
  // A manual run still waits for availability by default; a release call does not.
  assert.match(testflight, /check_availability:\n[^\n]*\n {8}type: boolean\n {8}default: true/u);
  assert.match(
    testflight,
    /\(inputs\.check_build \|\| \(inputs\.check_availability && needs\.build\.result == 'success'\)\)/u,
  );
  assert.match(testflight, /environment: ios-testflight/u);
  assert.match(testflight, /github\.ref == 'refs\/heads\/main'/u);
});
