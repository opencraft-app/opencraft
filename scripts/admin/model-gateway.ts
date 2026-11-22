import { readFile } from "node:fs/promises";
import { ModelGatewayStore } from "../../packages/account-pool-host/src/model-gateway-store.js";

// Local operator tool. Provider keys are submitted through the authenticated
// Human HTTP endpoint, never command-line arguments or this tool's output.
const [path, command, actor, file] = process.argv.slice(2);
if (!path || !["status", "configure", "reconcile"].includes(command ?? "") || !actor) {
  console.error("Usage: node --import tsx scripts/admin/model-gateway.ts /absolute/gateway.sqlite status ACTOR | configure ACTOR limits.json | reconcile REQUEST_ID receipt.json");
  process.exitCode = 2;
} else {
  const store = new ModelGatewayStore(path);
  try {
    if (command === "status") console.log(JSON.stringify({ ...store.summary(actor), requests: store.requests(actor) }, null, 2));
    else {
      if (!file) throw Error("A configuration/receipt file is required");
      const value = JSON.parse(await readFile(file, "utf8"));
      if (command === "configure") console.log(JSON.stringify(store.configure(actor, value, value.revision, "local-operator"), null, 2));
      else { store.reconcile(actor, value.actualTokens, "local-operator", value.reason); console.log(JSON.stringify({ reconciled: true })); }
    }
  } finally { store.close(); }
}
