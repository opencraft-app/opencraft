/** Workspace endpoint and environment URIs: one grammar for every provider. Parsing
 * happens only at configuration/client boundaries; owners pass the typed values. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  SANDBOX_ENDPOINT_NAMES,
  SandboxFault,
  formatSandboxEnvironmentUri,
  formatWorkspaceEndpointUri,
  parseSandboxEnvironmentUri,
  parseSandboxEnvironmentUris,
  parseWorkspaceEndpointUri,
} from "@opencraft/sandbox";
import { createSandboxProviderRegistry } from "@opencraft/sandbox/providers";
import { staticDockerSandboxProvider, type StaticDockerInstallation } from "@opencraft/sandbox-node/static-docker";
import { e2bSandboxProvider, type E2BInstallation } from "../../packages/sandbox-e2b/src/index";

const policy = (e: unknown) => e instanceof SandboxFault && e.code === "SANDBOX_POLICY";

test("workspace endpoint URIs round-trip for every allow-listed name", () => {
  for (const name of SANDBOX_ENDPOINT_NAMES) {
    const uri = `workspace://default/endpoints/${name}`;
    const parsed = parseWorkspaceEndpointUri(uri);
    assert.deepEqual(parsed, { workspaceId: "default", name });
    assert.equal(formatWorkspaceEndpointUri(parsed), uri);
  }
  assert.deepEqual(parseWorkspaceEndpointUri("workspace://ws-0a1b/endpoints/pi"), {
    workspaceId: "ws-0a1b",
    name: "pi",
  });
});

test("workspace endpoint URIs reject other schemes, unknown names and extra components", () => {
  for (const value of [
    "workspaces://default/endpoints/pi",
    "Workspace://default/endpoints/pi",
    "unix:///run/opencraft-agent/endpoints/pi",
    "workspace://default/endpoints/unknown",
    "workspace://default/endpoints/Pi",
    "workspace://default/endpoints/",
    "workspace://default/endpoint/pi",
    "workspace://default/endpoints/pi/extra",
    "workspace://default/endpoints/pi?token=x",
    "workspace://default/endpoints/pi#x",
    "workspace://user:secret@default/endpoints/pi",
    "workspace://default:8080/endpoints/pi",
    "workspace://Default/endpoints/pi",
    "workspace://-default/endpoints/pi",
    "workspace:///endpoints/pi",
    "workspace://default/endpoints/%70i",
    "workspace://default/../endpoints/pi",
    "workspace://default//endpoints/pi",
    "",
    42,
    undefined,
  ])
    assert.throws(() => parseWorkspaceEndpointUri(value), policy, String(value));
  assert.throws(() => formatWorkspaceEndpointUri({ workspaceId: "default", name: "nope" as never }), policy);
});

test("environment URIs round-trip and carry only provider and target", () => {
  for (const uri of [
    "static-docker://brain",
    "static-docker://hands",
    "e2b://opencraft-workspace",
    "e2b://team/workspace:v2",
    "docker-provisioner://opencraft-workspace",
    "cloudflare://workspace-container",
  ]) {
    const parsed = parseSandboxEnvironmentUri(uri);
    assert.equal(formatSandboxEnvironmentUri(parsed), uri);
    assert.deepEqual(Object.keys(parsed).sort(), ["provider", "target"]);
  }
  assert.deepEqual(
    parseSandboxEnvironmentUris("static-docker://brain, static-docker://hands").map(formatSandboxEnvironmentUri),
    ["static-docker://brain", "static-docker://hands"],
  );
});

test("environment URIs reject credentials, queries, reserved schemes and malformed targets", () => {
  for (const value of [
    "static-docker://user:pw@brain",
    "static-docker://brain?token=x",
    "static-docker://brain#x",
    "static-docker://",
    "static-docker:brain",
    "Static-Docker://brain",
    "static_docker://brain",
    "unix:///run/x.sock",
    "stdio://",
    "workspace://default",
    "https://e2b.example",
    "ws://127.0.0.1:1/rpc",
    "human://a/b",
    "e2b://../etc",
    "e2b://a/../b",
    "e2b://a//b",
    "e2b://a/",
    "e2b:///a",
    "e2b://a b",
    "e2b://a%2fb",
    "e2b://" + "a".repeat(201),
    "",
    null,
  ])
    assert.throws(() => parseSandboxEnvironmentUri(value), policy, String(value));
  for (const value of ["", "static-docker://brain static-docker://brain", 7])
    assert.throws(() => parseSandboxEnvironmentUris(value), policy);
});

test("each provider accepts only its own scheme and target grammar", () => {
  const registry = createSandboxProviderRegistry<StaticDockerInstallation | E2BInstallation>({
    "static-docker": staticDockerSandboxProvider(),
    e2b: e2bSandboxProvider(),
  });
  const docker: StaticDockerInstallation = { backend: "static-docker", linkRoot: "/run/opencraft-links" };
  const e2b: E2BInstallation = {
    backend: "e2b",
    apiUrl: "https://api.example.test",
    sandboxUrl: "https://proxy.example.test",
  };
  assert.equal(registry.environment(docker, parseSandboxEnvironmentUri("static-docker://brain")).templateId, "brain");
  assert.equal(
    registry.environment(e2b, parseSandboxEnvironmentUri("e2b://team/workspace:v2")).templateId,
    "team/workspace:v2",
  );
  // Changing deployment form is changing the URI; a URI never selects another installation's provider.
  assert.throws(() => registry.environment(docker, parseSandboxEnvironmentUri("e2b://brain")), policy);
  assert.throws(() => registry.environment(e2b, parseSandboxEnvironmentUri("static-docker://brain")), policy);
  // Provider-specific target grammar on top of the shared one.
  assert.throws(() => registry.environment(docker, parseSandboxEnvironmentUri("static-docker://team/brain")), policy);
  assert.throws(() => registry.environment(docker, parseSandboxEnvironmentUri("static-docker://Brain")), policy);
  assert.throws(
    () => registry.environment({ backend: "cloudflare" } as never, parseSandboxEnvironmentUri("cloudflare://x")),
    (e: unknown) => e instanceof SandboxFault && e.code === "SANDBOX_UNAVAILABLE",
  );
});
