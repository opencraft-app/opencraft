import { runGatewayUtilityMode } from './runtime-plugin-tools.mjs';
import { CHECK_GATEWAY_COMPOSITION, checkGatewayComposition, loadGatewayComposition } from './gateway-composition.mjs';
import { loadGatewayWebRelease } from './gateway-web-release.mjs';

const args = process.argv.slice(2);
// Explicit runtime plugin executor/admin modes never load or start the Gateway or other owners.
if (args[0] === CHECK_GATEWAY_COMPOSITION) {
  if (args.length !== 1) throw Error('Usage: ' + CHECK_GATEWAY_COMPOSITION);
  const selected = await loadGatewayComposition();
  if (!selected) throw Error('No Gateway composition package selected');
  try {
    await checkGatewayComposition(selected.composition);
    await loadGatewayWebRelease();
  } finally {
    await selected.composition.close();
  }
  console.log(JSON.stringify({
    gatewayCompositionSha256: selected.sha256,
    ...(selected.workbenchAssetsPlugin ? { workbenchAssetsPluginSha256: selected.workbenchAssetsPlugin.sha256 } : {}),
  }));
} else if (!(await runGatewayUtilityMode(args))) {
  const selected = await loadGatewayComposition();
  try {
    const { startContainerGateway } = await import('./gateway-application.mjs');
    await startContainerGateway(selected?.composition, selected?.sha256, selected?.workbenchAssetsPlugin);
    if (selected) console.log(JSON.stringify({ gatewayCompositionSha256: selected.sha256 }));
  } catch (error) {
    await selected?.composition.close().catch(() => {});
    throw error;
  }
}
