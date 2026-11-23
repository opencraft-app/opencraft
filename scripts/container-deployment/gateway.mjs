import { runGatewayUtilityMode } from './runtime-plugin-tools.mjs';
// Explicit runtime plugin executor/admin modes never load or start the Gateway or other owners.
if (!(await runGatewayUtilityMode(process.argv.slice(2)))) {
  const { startContainerGateway } = await import('./gateway-application.mjs');
  await startContainerGateway();
}
