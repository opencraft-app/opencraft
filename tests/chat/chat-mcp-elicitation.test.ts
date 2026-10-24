import assert from "node:assert/strict";
import test from "node:test";
import { createMcpElicitationDraft, normalizeMcpElicitationMetadata as metadata,
  normalizeMcpElicitationSchema as schema, presentMcpElicitationDisplayValue as display,
  validateMcpElicitationDraft as validate } from "../../packages/chat-core/src/mcp-elicitation";

test("metadata routing respects mode, typed identities and persistence order", () => {
  const source = { codex_approval_kind: "mcp_tool_call", connector_id: "issues", tool_params: { title: "Hi" },
    tool_params_display: [{ name: "title", display_name: "Title", value: "Hi" }, { name: 3 }], persist: ["always", "session", "always", "bad"] };
  const result = metadata("form", source);
  assert.equal(result.interactionKind, "tool-approval");
  assert.deepEqual(result.persist, ["always", "session"]);
  assert.deepEqual(result.toolApproval?.toolParamsDisplay, [{ name: "title", displayName: "Title", value: "Hi" }]);
  assert.equal(metadata("url", source).interactionKind, "url-action");
  assert.equal(metadata("form", { riskLevel: "critical" }).riskLevel, null);
});

test("connector auth and suggestions require their complete typed metadata", () => {
  const auth = { _codex_apps: { connector_auth_failure: { is_auth_failure: true, connector_id: "drive", connector_name: "Drive",
    install_url: "https://example.test/auth", requested_scopes: ["read", 3] } } };
  assert.equal(metadata("url", auth, { serverName: "other" }).connectorAuth, null);
  assert.deepEqual(metadata("url", auth, { serverName: "codex_apps" }).connectorAuth?.requestedScopes, ["read"]);
  const suggestion = { codex_approval_kind: "tool_suggestion", suggest_type: "install", suggest_reason: "Use issues", tool_type: "connector", tool_id: "issues", tool_name: "Issues", persist: "always" };
  assert.equal(metadata("form", suggestion).toolSuggestion?.persistAlways, true);
  assert.equal(metadata("form", { ...suggestion, persist: ["always"] }).toolSuggestion?.persistAlways, false);
  assert.equal(metadata("form", { ...suggestion, suggest_reason: 3 }).toolSuggestion, null);
});

test("computer-use fallback is an exact engine contract and does not create authorization", () => {
  const context = { serverName: "computer-use", message: "Allow Codex to use Notes?", requestedSchema: { properties: {} } };
  const input = { codex_approval_kind: "mcp_tool_call", persist: "always", tool_params: { old: true } };
  assert.deepEqual(metadata("form", input, context).toolApproval?.toolParams, { app: "Notes" });
  assert.equal(metadata("form", {}, context).interactionKind, "form");
  const explicit = metadata("form", { ...input, connector_id: "desktop", tool_name: "open_app", tool_title: "Open", connector_name: "Desktop" }, context).toolApproval;
  assert.equal(explicit?.connectorId, "desktop");
  assert.equal(explicit?.toolName, "open_app");
  assert.equal(explicit?.connectorName, "Desktop");
  assert.equal(metadata("form", { persist: "always" }, { ...context, message: "Allow Codex to use Notes\nNow?" }).interactionKind, "form");
  assert.equal(metadata("form", { persist: "always" }, { ...context, message: "Use Notes" }).interactionKind, "form");
  assert.equal(metadata("form", { persist: "always" }, { ...context, requestedSchema: { properties: { name: { type: "string" } } } }).interactionKind, "form");
});

test("schema choices, defaults and typed validation retain ordered data", () => {
  const fields = schema({ required: ["name", "count", "tags"], properties: {
    name: { type: "string", minLength: 2, maxLength: 4 }, count: { type: "integer", minimum: 1, maximum: 3 },
    enabled: { type: "boolean", default: true }, tags: { type: "array", items: { enum: ["safe", "fast"] } },
    choice: { type: "integer", items: { enum: ["a"] } },
  } });
  assert.equal(fields[4].integer, true);
  assert.equal(fields[4].kind, "select");
  const draft = createMcpElicitationDraft(fields);
  assert.deepEqual(validate(fields, draft).errors, { name: "This field is required", count: "This field is required", tags: "Select at least one option" });
  assert.deepEqual(validate(fields, { ...draft, name: " good ", count: "2", tags: ["fast", "safe"] }), {
    content: { name: "good", count: 2, enabled: true, tags: ["fast", "safe"], choice: "a" }, errors: {},
  });
  for (const [value, error] of [["1.5", "Enter a whole number"], ["0", "Must be at least 1"], ["4", "Must be at most 3"]]) {
    assert.equal(validate(fields, { ...draft, count: value }).errors.count, error);
  }
});

test("array item anyOf preserves titled choices and supports required form submission", () => {
  const alternatives = [{ const: "safe", title: "Safe mode" }, { const: "fast", title: "Fast mode" }, { const: 7 }];
  const fields = schema({ required: ["tags"], properties: {
    tags: { type: "array", items: { anyOf: alternatives } },
    withDefault: { type: "array", items: { anyOf: alternatives }, default: ["safe"] },
    precedence: { type: "array", enum: ["outer"], items: { anyOf: alternatives } },
    explicit: { type: "array", oneOf: [{ const: "explicit", title: "Explicit" }], items: { anyOf: alternatives } },
  } });
  const choices = [{ value: "safe", label: "Safe mode" }, { value: "fast", label: "Fast mode" }];
  assert.deepEqual(fields[0].options, choices);
  assert.deepEqual(fields[1].options, choices);
  assert.deepEqual(fields[2].options, choices);
  assert.deepEqual(fields[3].options, [{ value: "explicit", label: "Explicit" }]);
  const draft = createMcpElicitationDraft(fields);
  assert.equal(validate(fields, draft).errors.tags, "Select at least one option");
  assert.deepEqual(validate(fields, { ...draft, tags: ["fast"] }), {
    content: { tags: ["fast"], withDefault: ["safe"] }, errors: {},
  });
});

test("browser origin approvals retain offered persistence with bounded fallback routing", () => {
  const request = { origin: "https://example.test", persist: ["session", "always"] };
  const context = { serverName: "browser", requestedSchema: { type: "object", properties: {} } };
  for (const serverName of ["browser", "browser-use"]) {
    const result = metadata("form", request, { ...context, serverName });
    assert.equal(result.interactionKind, "tool-approval");
    assert.deepEqual(result.persist, ["session", "always"]);
    assert.equal(result.toolApproval?.connectorId, serverName);
    assert.deepEqual(result.toolApproval?.toolParams, {});
  }
  assert.equal(metadata("openai/form", { ...request, persist: "session" }, context).interactionKind, "tool-approval");
  for (const origin of [undefined, "", "  ", 3]) assert.equal(metadata("form", { ...request, origin }, context).interactionKind, "form");
  assert.equal(metadata("form", { ...request, persist: [] }, context).interactionKind, "form");
  assert.equal(metadata("form", request, { ...context, serverName: "other" }).interactionKind, "form");
  assert.equal(metadata("form", request, { ...context, requestedSchema: { properties: { name: { type: "string" } } } }).interactionKind, "form");
  assert.equal(metadata("url", request, context).interactionKind, "url-action");
  const explicit = metadata("form", { ...request, codex_approval_kind: "mcp_tool_call", connector_id: "custom", tool_name: "open", tool_params: { target: "page" } }, context);
  assert.equal(explicit.toolApproval?.connectorId, "custom");
  assert.deepEqual(explicit.toolApproval?.toolParams, { target: "page" });
  const suggestion = { ...request, codex_approval_kind: "tool_suggestion", suggest_type: "enable", suggest_reason: "Browse", tool_type: "connector", tool_id: "web", tool_name: "Web" };
  assert.equal(metadata("form", suggestion, context).interactionKind, "tool-suggestion");
  assert.equal(metadata("form", { ...suggestion, tool_id: 3 }, context).interactionKind, "tool-approval");
});

test("display boundaries preserve complete values and tolerate circular input", () => {
  assert.equal(display("x".repeat(120)).isExpandable, false);
  assert.equal(display("x".repeat(121)).isExpandable, true);
  const result = display({ text: "x".repeat(100) });
  assert.equal(result.previewText.length, 48);
  assert.equal(result.previewText.endsWith("…"), true);
  assert.match(result.expandedText, /x{100}/u);
  const circular: Record<string, unknown> = {}; circular.self = circular;
  assert.equal(display(circular).expandedText, "[object Object]");
  assert.equal(display(undefined).expandedText, "");
});

test("prototype-like field names stay own data properties without prototype mutation", () => {
  const fields = schema(JSON.parse('{"properties":{"__proto__":{"type":"string","default":"safe"},"constructor":{"type":"string","default":"value"}}}'));
  const draft = createMcpElicitationDraft(fields);
  assert.equal(Object.hasOwn(draft, "__proto__"), true);
  assert.equal(Object.getPrototypeOf(draft), Object.prototype);
  const content = validate(fields, draft).content!;
  assert.equal(Object.hasOwn(content, "__proto__"), true);
  assert.equal(content.__proto__, "safe");
  assert.equal(Object.getPrototypeOf(content), Object.prototype);
});


test("short multiline approval parameters retain four-line disclosure", () => {
  for (const value of ["a\nb\nc\nd", "a\r\nb\r\nc\r\nd", "x".repeat(120)]) {
    assert.equal(display(value).isExpandable, false);
  }
  for (const value of ["a\nb\nc\nd\ne", "a\nb\nc\nd\n", "a\r\nb\r\nc\r\nd\r\ne",
    Array.from({ length: 35 }, (_, index) => String(index + 1)).join("\n")]) {
    assert.ok(value.length < 120);
    assert.deepEqual(display(value), { expandedText: value, previewText: value, kind: "text", isExpandable: true });
  }
  assert.equal(display("x".repeat(121)).isExpandable, true);
  for (const value of [null, true, 35]) assert.equal(display(value).isExpandable, false);
});
