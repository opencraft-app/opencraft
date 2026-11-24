import { startProvisioner } from "./provisioner-application.mjs";

// Container entry of the Compose `provisioner` service (the only Docker socket holder).
try {
  const service = await startProvisioner();
  const stop = () => service.close().finally(() => process.exit(0));
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
