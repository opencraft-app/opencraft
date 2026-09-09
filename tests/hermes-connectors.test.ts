import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isConnectorVisible, prototypeUnsupported, validateRelease, readConnectorBootstrap, SidecarNotInstalled } from "../plugins/lightvela-hermes/src/connectors/connector-client";

test("bootstrap accepts actual TAT bracketed-paste CSI and bare CR without accepting command echo", () => {
  const payload = btoa('{"test":true}');
  assert.equal(readConnectorBootstrap(`echoed command\r\n\x1b[?2004l\rOVERMIND_INFO=${payload}\r\n\r\n`), payload);
  assert.equal(readConnectorBootstrap(`OVERMIND_INFO=${payload}\n`), payload);
  assert.throws(() => readConnectorBootstrap("echo 'OVERMIND_INFO=abc'\r\n"));
  assert.throws(() => readConnectorBootstrap("\x1b[?2004l\rOVERMIND_MISSING\r\n"), SidecarNotInstalled);
});

test("connector prototype rejects unsafe or unpinned releases", () => {
  const sha256 = "a".repeat(64);
  assert.throws(() => validateRelease({ url: "http://example.com/a", sha256 }));
  assert.throws(() => validateRelease({ url: "https://example.com/a", sha256: "latest" }));
  assert.throws(() => validateRelease({ url: "https://user:secret@example.com/a", sha256 }));
  assert.equal(validateRelease({ url: "https://example.com/a", sha256 }).sha256, sha256);
});
test("catalog does not promise WorkBuddy account, remote OAuth or CLI authorization support", () => {
  const card = { id: "test", name: "test", description: "", type: "mcp", authMode: "token", status: "disconnected", tools: [], hasTokenSchema: true };
  assert.equal(prototypeUnsupported(card), null);
  for (const authMode of ["oneid-token", "server-side", "gateway", "oauth", "mcp"]) {
    assert.ok(prototypeUnsupported({ ...card, authMode }));
  }
  assert.equal(prototypeUnsupported({ ...card, type: "cli" }), null);
});
test("catalog hides browser OAuth including missing metadata but preserves CLI and tokens", () => {
  const card = {id:"test",name:"test",description:"",type:"mcp",authMode:"native",status:"disconnected",tools:[],hasTokenSchema:false};
  for (const id of ["canva", "canva-ai", "westock-mcp"]) {
    assert.equal(isConnectorVisible({...card,id}),false);
    assert.ok(prototypeUnsupported({...card,id}));
  }
  for (const authMode of ["oauth","mcp","server-side","gateway","oneid-token"]) assert.equal(isConnectorVisible({...card,authMode}),false);
  assert.equal(isConnectorVisible({...card,type:"cli"}),true);
  assert.equal(isConnectorVisible({...card,authMode:"token",hasTokenSchema:true}),true);
  assert.equal(isConnectorVisible(card),true);
});
test("connector integration remains inside the Hermes plugin", () => {
  const source = readFileSync(new URL("../plugins/lightvela-hermes/src/extension.ts", import.meta.url), "utf8");
  assert.ok(source.includes('id: "lightvela.hermes.connectors"'));
  assert.ok(source.includes('api.settings.registerPage'));
});
