#!/usr/bin/env node
import { packageBrowserRuntime } from './package-browser-runtime.mjs';
import { optimizeWebImages } from './optimize-web-images.mjs';
import { packageWebResources, copyPdfLicenses } from './package-web-resources.mjs';
import { mkdir, readFile, writeFile, cp, rm, chmod } from 'node:fs/promises';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { assertExecutionNativePayload } from './server-deployment/native-preflight.mjs';
import { copyMcpAppRuntime, copyPiRuntime } from './package-mcp-app-runtime.mjs';
import { copySshRuntime } from './package-ssh-runtime.mjs';
import semver from 'semver';
import { assertHeadlessWebRelease } from './headless-web-release.mjs';
import { parseNpmPackResult } from './web-deployment/npm-pack-result.mjs';
import { PACKAGE_NAME, PUBLIC_PACKAGE_NAME, RESOURCE_PACKAGE, assertPackageName } from './web-deployment/package-identity.mjs';
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export async function packageWebServer({ version, webRoot = join(repositoryRoot, 'apps/workbench-web/dist'), output, execution = false, executionProfile = 'daemon', splitResources = process.env.OPENCRAFT_SPLIT_WEB_RESOURCES === '1', packageName = PACKAGE_NAME, resourcePackageName = RESOURCE_PACKAGE, registry = process.env.OPENCRAFT_NPM_REGISTRY, relayEntry = join(repositoryRoot, 'apps/relay-server/src/main.ts'), headlessGatewayEntry = join(repositoryRoot, 'scripts/server-deployment/headless-gateway.mjs') }) {
  assertPackageName(packageName); assertPackageName(resourcePackageName);
  if (packageName === resourcePackageName) throw new Error('Web and resource packages must have different names');
  if (!['daemon', 'headless'].includes(executionProfile) || (!execution && executionProfile !== 'daemon')) throw new Error('Invalid execution profile');
  if (executionProfile === 'headless') await assertHeadlessWebRelease(webRoot);
  if (!semver.valid(version)) throw new Error('Set OPENCRAFT_RELEASE_VERSION to an exact npm version');
  const directory = resolve(output);
  const packageRoot = join(directory, 'package');
  await mkdir(directory, { recursive: true });
  await rm(packageRoot, { recursive: true, force: true });
  await mkdir(join(packageRoot, 'runtime'), { recursive: true });
  const manifest = JSON.parse(await readFile(join(repositoryRoot, 'packaging/web-server/package.json'), 'utf8'));
  manifest.name = packageName;
  if (registry) {
    const url = new URL(registry);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid npm registry');
    manifest.publishConfig.registry = registry;
  }
  const web = JSON.parse(await readFile(join(webRoot, 'version.json'), 'utf8'));
  if (typeof web.buildId !== 'string') throw new Error('Build the Web release before packaging');
  await cp(webRoot, join(packageRoot, 'web'), { recursive: true, filter: source => !source.endsWith('.map') });
  for (const family of ['inter', 'jetbrains-mono']) {
    const target = join(packageRoot, 'web/licenses/fonts', family);
    await mkdir(target, { recursive: true });
    await cp(join(repositoryRoot, 'node_modules/@fontsource-variable', family, 'LICENSE'), join(target, 'LICENSE'));
  }
  const images = await optimizeWebImages(join(packageRoot, 'web/assets/skills'));
  const resources = splitResources ? await packageWebResources({ repositoryRoot, packageRoot, directory, version, buildId: web.buildId, packageName: resourcePackageName, registry }) : null;
  if (!resources) await copyPdfLicenses(repositoryRoot, packageRoot);
  await rm(join(packageRoot, 'web/optional-assets.json'), { force: true });
  const indexPath = join(packageRoot, 'web/index.html');
  const html = await readFile(indexPath, 'utf8');
  await writeFile(indexPath, html.replace('</head>', `<meta name="opencraft-web-updates" content="/__opencraft_updates">${resources ? `<meta name="opencraft-web-resources" content="${web.buildId}">` : ''}</head>`));
  manifest.version = version;
  manifest.opencraftWeb = { schemaVersion: 1, workerProtocol: 1, buildId: web.buildId, ...(resources ? { resources: { packageName: resources.packageName, version, buildId: web.buildId, integrity: resources.integrity } } : {}) };
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify(manifest, null, 2));
  await cp(join(repositoryRoot, 'docs/web-deployment.md'), join(packageRoot, 'README.md'));
  const unit = await readFile(join(repositoryRoot, 'packaging/web-server/opencraft-web.service'), 'utf8');
  await writeFile(join(packageRoot, 'opencraft-web.service'), unit.replace(`node_modules/${PUBLIC_PACKAGE_NAME}/`, `node_modules/${packageName}/`));
  for (const entry of ['cli', 'worker', 'controlled-registry', 'prefetch']) {
    await build({ entryPoints: [join(repositoryRoot, `scripts/web-deployment/${entry}.mjs`)], outfile: join(packageRoot, `runtime/${entry}.mjs`),
      bundle: true, platform: 'node', format: 'esm', target: 'node22',
      external: ['bufferutil', 'utf-8-validate', 'cpu-features', '*.node'],
      define: { 'process.env.OPENCRAFT_NPM_PACKAGE_NAME': JSON.stringify(packageName), 'process.env.OPENCRAFT_NPM_RESOURCE_PACKAGE_NAME': JSON.stringify(resourcePackageName) },
      banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" } });
  }
  // Independent relay/admin entry points travel with the same fixed-source artifact;
  // they remain inactive unless the operator configures a separate deployment.
  for (const [entry, name] of [[resolve(relayEntry), 'relay'], ...['access-admin', 'hub-admin', 'human-account'].map(name => [join(repositoryRoot, `scripts/${name}.ts`), name])]) {
    await build({ nodePaths: [join(repositoryRoot, "node_modules")], entryPoints: [entry], outfile: join(packageRoot, `runtime/${name}.mjs`), bundle: true,
      platform: 'node', format: 'esm', target: 'node24',
      define: { 'process.env.OPENCRAFT_RELAY_SOURCE_REVISION': JSON.stringify(web.sourceRevision ?? null), 'process.env.OPENCRAFT_RELAY_BUILD_ID': JSON.stringify(web.buildId) },
      banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" } });
  }
  for (const [entry, name] of [['apps/observability-service/service.mjs','observe-service'],['apps/observability-cli/main.mjs','observe-cli']]) {
    await build({entryPoints:[join(repositoryRoot,entry)],outfile:join(packageRoot,`runtime/${name}.mjs`),bundle:true,platform:'node',format:'esm',target:'node24',define:{'process.env.OPENCRAFT_OBSERVE_SOURCE_REVISION':JSON.stringify(web.sourceRevision??null),'process.env.OPENCRAFT_OBSERVE_BUILD_ID':JSON.stringify(web.buildId)}});
  }
  await cp(join(repositoryRoot,'runtime/skills/opencraft-observe'),join(packageRoot,'runtime/skills/opencraft-observe'),{recursive:true});
  await cp(join(repositoryRoot,'ops/observability'),join(packageRoot,'runtime/observability'),{recursive:true});
  manifest.bin['opencraft-observe']='runtime/observe-cli.mjs';
  await chmod(join(packageRoot,'runtime/observe-cli.mjs'),0o755);
  await writeFile(join(packageRoot,'package.json'),JSON.stringify(manifest,null,2));
  if (execution) {
    await mkdir(join(packageRoot, 'execution'));
    for (const [entry, target, format] of [
      [executionProfile === 'headless' ? headlessGatewayEntry : 'scripts/server-deployment/gateway.mjs', 'gateway.mjs', 'esm'],
      ['apps/opencraft-daemon/src/bin.ts', 'daemon.cjs', 'cjs'],
      ['apps/opencraft-daemon/src/token-usage-query-worker.ts', 'token-usage-query-worker.mjs', 'esm'],
      ['apps/local-agent-host/src/dsh-capability-plugin.mjs', 'dsh-capability-plugin.mjs', 'esm'],
      ['scripts/server-deployment/dsh-host.mjs', 'dsh-host.mjs', 'esm'],
    ]) {
      await build({ nodePaths: [join(repositoryRoot, 'node_modules')], entryPoints: [resolve(repositoryRoot, entry)], outfile: join(packageRoot, 'execution', target),
        bundle: true, platform: 'node', format, target: 'node22', define:{'process.env.OPENCRAFT_OBSERVE_SOURCE_REVISION':JSON.stringify(web.sourceRevision??null),'process.env.OPENCRAFT_OBSERVE_BUILD_ID':JSON.stringify(web.buildId)}, external: ['bufferutil', 'utf-8-validate', 'cpu-features', '*.node', '@earendil-works/pi-*', '@earendil-works/chord'],
        plugins: [{ name: 'execution-pty', setup(builder) { builder.onResolve({ filter: /^node-pty$/ }, () => ({ path: './native/node-pty/lib/index.js', external: true })); builder.onResolve({ filter: /^ssh2$/ }, () => ({ path: './native/node_modules/ssh2/lib/index.js', external: true })); } }],
        ...(format === 'esm' ? { banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" } } : {}) });
    }
    if (executionProfile === 'headless') {
      await packageBrowserRuntime(join(packageRoot, 'runtime/browser'));
      await copySshRuntime(join(packageRoot, 'execution/native/node_modules'));
      const appRuntime = { ...await copyMcpAppRuntime(join(packageRoot, 'node_modules')), ...await copyPiRuntime(join(packageRoot, 'node_modules')) };
      manifest.dependencies = { ...manifest.dependencies, ...appRuntime };
      manifest.bundleDependencies = [...(manifest.bundleDependencies || []), ...Object.keys(appRuntime)];
    }
    // Both standalone and daemon Hosts mount these persistence/projection patches.
    const desktop = JSON.parse(await readFile(join(repositoryRoot, 'apps/workbench-electron/package.json'), 'utf8'));
    for (const entry of desktop.build.extraResources.filter(entry => entry.to.startsWith('runtime/dsh/') && entry.from.startsWith('../local-agent-host/src/'))) {
      const destination = join(packageRoot, 'execution', relative('runtime/dsh', entry.to));
      await mkdir(dirname(destination), { recursive: true });
      await cp(resolve(repositoryRoot, 'apps/workbench-electron', entry.from), destination);
    }
    const ptyRoot = join(repositoryRoot, 'node_modules/node-pty');
    const prebuild = `prebuilds/${process.platform}-${process.arch}`;
    await cp(ptyRoot, join(packageRoot, 'execution/native/node-pty'), {
      recursive: true, dereference: true,
      filter: path => {
        const name = relative(ptyRoot, path).replaceAll('\\', '/');
        if (!name || ['package.json', 'LICENSE', 'lib', 'build', 'build/Release', 'prebuilds', prebuild].includes(name)) return true;
        if (name.startsWith('lib/')) return name.endsWith('.js') || name.endsWith('.d.ts');
        return (name.startsWith('build/Release/') || name.startsWith(`${prebuild}/`))
          && /(?:\.node|\.dll|\.exe|\/spawn-helper)$/.test(name);
      },
    });
    await assertExecutionNativePayload(packageRoot);
    const nodeMajor = Number(process.versions.node.split('.')[0]);
    manifest.engines.node = `>=${nodeMajor} <${nodeMajor + 1}`;
    manifest.os = [process.platform];
    manifest.cpu = [process.arch];
    manifest.opencraftExecution = { protocolVersion: 1, platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules, profile: executionProfile,
      ...(executionProfile === 'headless' ? { independentDshHost: 1 } : {}) };
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify(manifest, null, 2));
    await cp(join(repositoryRoot, 'packaging/web-server/opencraft-execution.service'), join(packageRoot, 'opencraft-execution.service'));
    await cp(join(repositoryRoot, 'packaging/web-server/opencraft-dsh-host.service'), join(packageRoot, 'opencraft-dsh-host.service'));
  }
  await chmod(join(packageRoot, 'runtime/cli.mjs'), 0o755);
  const { stdout } = await promisify(execFile)('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', directory], { cwd: packageRoot, maxBuffer: 16 * 1024 * 1024 });
  const result = parseNpmPackResult(JSON.parse(stdout));
  return { version, buildId: web.buildId, packageRoot, archive: join(directory, result.filename), integrity: result.integrity, sha: result.shasum, images, ...(resources ? { resources } : {}) };
}
export async function packageWebServerFromEnvironment(composition = {}) {
  return packageWebServer({ version: process.env.OPENCRAFT_RELEASE_VERSION,
    execution: process.env.OPENCRAFT_PACKAGE_EXECUTION === '1',
    executionProfile: process.env.OPENCRAFT_EXECUTION_PROFILE || 'daemon',
    output: process.env.OPENCRAFT_WEB_PACKAGE_OUTPUT || join(repositoryRoot, '.local/web-packages'), ...composition });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await packageWebServerFromEnvironment(), null, 2));
}
