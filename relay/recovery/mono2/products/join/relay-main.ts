#!/usr/bin/env node
import { runRelayCli } from '../../opencraft/apps/relay-server/src/application.js';
import { readJoinRelayConfiguration } from './relay-composition.js';
import { installJoinCanonicalRedirect } from './relay-canonical-redirect.js';
import { installJoinShareThumbnail } from './share-thumbnail.js';
import { installJoinMobilePreview } from './mobile-preview.js';
import { installGraspProxy } from './grasp-proxy.js';

const [path, ...extra] = process.argv.slice(2);
if (!path || extra.length) throw new Error('Usage: join-relay /absolute/private-config.json');
const { configuration, composition, authenticateWebRequest } = await readJoinRelayConfiguration(path);
const app = await runRelayCli({ ...composition, loadConfiguration: async () => configuration });
installGraspProxy(app.server, process.env.OPENCRAFT_GRASP_UPSTREAM ?? 'http://21.6.127.184:5173', authenticateWebRequest, configuration.authentication?.origin ?? 'https://join.woa.com');
installJoinMobilePreview(app.server);
installJoinShareThumbnail(app.server);
installJoinCanonicalRedirect(app.server);
