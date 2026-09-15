import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const workspace = fileURLToPath(new URL("../", import.meta.url));
const reference = resolve(workspace, process.argv[2] ?? "../ref/hypernode/policy/src/services");
const local = resolve(workspace, "apps/local-agent-host/src/hypernode");
function findClass(file, name) {
  const ast = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  let found;
  function visit(node) {
    if ((ts.isClassDeclaration(node) || ts.isClassExpression(node)) && node.name?.text === name) found = node;
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(found, name);
  return { ast, node: found };
}
function methods(value) {
  return new Map(value.node.members.filter(ts.isMethodDeclaration).map(method => [
    method.name.getText(value.ast),
    ts.transpileModule("class Check { " + method.getText(value.ast) + " }", {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText,
  ]));
}
let count = 0;
for (const [source, sourceName, target, targetName] of [
  ["turn-manager.ts", "TurnManagerService", "turn-manager.js", "TurnManagerService"],
  ["dsh-appserver-projection.ts", "DshAppServerProjectionService", "tool-projection.js", "DshAppServerProjectionService"],
  ["dsh-engine-adapter.js", "DshEngineAdapterService", "engine-core.js", "HypernodeDshEngineCore"],
  ["thread-execution.js", "ThreadExecutionTable", "execution-authority.js", "ThreadExecutionTable"],
  ["thread-execution.js", "ThreadExecutionJournal", "execution-authority.js", "ThreadExecutionJournal"],
  ["thread-write-lease.js", "ThreadWriteLeaseTable", "write-lease.js", "ThreadWriteLeaseTable"],
  ["transparent-thread-queue.ts", "ThreadQueueStore", "thread-queue.js", "ThreadQueueStore"],
  ["text-delta-pacer.js", "TextDeltaPacerController", "text-delta-pacer.js", "TextDeltaPacerController"],
  ["shell-command-classifier.js", "ShellCommandClassifierService", "shell-command-classifier.js", "ShellCommandClassifierService"],
]) {
  const original = methods(findClass(resolve(reference, source), sourceName));
  const copied = methods(findClass(resolve(local, target), targetName));
  for (const [name, implementation] of copied) {
    if (target === "engine-core.js" && name === "stopWorker") continue; // Local shared-process ownership port.
    assert.equal(implementation, original.get(name), source + ":" + name);
    count++;
  }
}
console.log(`Verified ${count} imported HyperNode methods against reference source.`);
