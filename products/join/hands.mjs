import { startContainerHands } from '../../scripts/container-deployment/hands-application.mjs';

// An execution environment is not the plugin lifecycle owner.
if(process.argv.length>2)throw Error('Hands only boots the environment; use the platform administration entrypoint');
if (process.getuid() === 0) {
  const { startRootHands } = await import('./root-hands.mjs');
  await startRootHands();
} else await startContainerHands();
