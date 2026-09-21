import assert from "node:assert/strict";
import test from "node:test";
import { AppServerRpcError } from "@opencraft/appserver-client";
import { connectorDefinition, type ConnectorInstance } from "@opencraft/connector-core";
import { connectorErrorMessage } from "../packages/workbench-runtime/src/connectors/feedback";
import { connectorCheckLabel, connectorCredentialHelp, connectorOAuthStatus } from "../apps/workbench-web/src/components/connectors/connector-setup-copy";

test("configuration checks are not described as connection tests", () => {
  assert.equal(connectorCheckLabel(connectorDefinition("tencent-ima")), "检查配置");
  assert.equal(connectorCheckLabel(connectorDefinition("meituan-travel")), "检查配置");
  assert.equal(connectorCheckLabel(connectorDefinition("notion")), "测试连接");
  assert.equal(connectorCheckLabel(connectorDefinition("tencent-docs")), "测试连接");
});

test("credential help names only identity fields actually edited", () => {
  const definition = connectorDefinition("tencent-ima"), field = definition.fields.find(field => field.secret)!;
  const saved: ConnectorInstance = { id: "i", definitionId: definition.id, title: "IMA", revision: 1, enabled: true, values: { client_id: "first" }, configuredFields: ["api_key"], authorization: "configured", updatedAt: 0 };
  assert.equal(connectorCredentialHelp(definition, field, saved, { client_id: "first" }), "已保存，留空保留原值。");
  const changed = connectorCredentialHelp(definition, field, saved, { client_id: "second" })!;
  assert.match(changed, /Client ID/); assert.match(changed, /API Key/); assert.ok(!changed.includes("服务地址"));
  assert.equal(connectorCredentialHelp(definition, field, null, {}), undefined);
});

test("operation-specific feedback never exposes provider errors or assumes an unconfirmed mutation failed", () => {
  const raw = new Error("https://private.invalid/callback?token=synthetic-credential");
  assert.match(connectorErrorMessage("save", raw), /未能确认配置是否保存/);
  assert.match(connectorErrorMessage("remove", raw), /未能确认是否已删除/);
  assert.match(connectorErrorMessage("check", raw), /配置检查/);
  assert.match(connectorErrorMessage("test", raw), /连接测试/);
  for (const operation of ["save", "test", "authorize", "remove"] as const) assert.ok(!connectorErrorMessage(operation, raw).includes("synthetic-credential"));
  assert.match(connectorErrorMessage("load", new AppServerRpcError({ code: -32601, message: "method unavailable" })), /暂不支持/);
  assert.match(connectorErrorMessage("save", new Error("Connector conflict")), /配置已发生变化/);
  assert.match(connectorErrorMessage("connect", new Error("Connector authorization-pending")), /上一次授权尚未结束/);
  assert.ok(!connectorErrorMessage("save", new Error("Connector conflict token=secret")).includes("配置已发生变化"), "only exact safe codes are classified");
});

test("OAuth progress copy distinguishes completion, cancellation and expiry", () => {
  assert.match(connectorOAuthStatus("pending"), /保持此窗口打开/);
  assert.match(connectorOAuthStatus("expired"), /超时/);
  assert.match(connectorOAuthStatus("cancelled"), /停止等待/);
  assert.match(connectorOAuthStatus("complete"), /授权已完成/);
});
