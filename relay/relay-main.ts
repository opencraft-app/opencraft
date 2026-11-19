#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { runRelayCli } from '../apps/relay-server/src/application.js';
import { readJoinRelayConfiguration } from './relay-composition.js';
import { installJoinCanonicalRedirect } from './relay-canonical-redirect.js';
import { installJoinShareThumbnail } from './share-thumbnail.js';
import { installMobilePreviewForward } from './mobile-preview-forward.js';
import { installJoinMobilePreview } from './mobile-preview.js';
import { installGraspProxy } from './grasp-proxy.js';

const [path, ...extra] = process.argv.slice(2);
if (!path || extra.length) throw new Error('Usage: join-relay /absolute/private-config.json');
const { configuration, composition, authenticateWebRequest } = await readJoinRelayConfiguration(path);
const thumbnail = await readFile(new URL('./assets/joinvela-mascot-share-512.jpg', import.meta.url));
const app = await runRelayCli({ ...composition, loadConfiguration: async () => configuration });
try {
  installGraspProxy(app.server, process.env.OPENCRAFT_GRASP_UPSTREAM, authenticateWebRequest, configuration.authentication?.origin ?? 'https://join.woa.com');
  if (process.env.JOIN_MOBILE_PREVIEW_UPSTREAM) installMobilePreviewForward(app.server, process.env.JOIN_MOBILE_PREVIEW_UPSTREAM);
  else installJoinMobilePreview(app.server);
  installJoinShareThumbnail(app.server, thumbnail);
  installJoinCanonicalRedirect(app.server);
} catch (error) {
  await app.close();
  throw error;
}
