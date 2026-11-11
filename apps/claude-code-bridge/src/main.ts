import { claudeSdkFactory } from "./native.js";
import { BridgeProtocolServer } from "./protocol-server.js";

const server = new BridgeProtocolServer({
  input: process.stdin,
  write: (data) => { process.stdout.write(data); },
  factory: claudeSdkFactory,
  diagnostics: (message) => { process.stderr.write(`${message}\n`); },
});

void server.run().then(
  () => process.exit(0),
  (error) => {
    process.stderr.write(`bridge stopped: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);

const stop = () => {
  void server.close().then(() => process.exit(0), () => process.exit(1));
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
