export function assertLocalServiceRuntime(manifest) {
  if(manifest.opencraftLocalService?.schemaVersion!==1)throw new Error('This package does not contain a supported complete local service');
  if(manifest.opencraftLocalService.updateChannel!==undefined&&!(typeof manifest.opencraftLocalService.updateChannel==='string'
    &&/^[a-z][a-z0-9-]{0,63}$/u.test(manifest.opencraftLocalService.updateChannel)))throw new Error('Invalid local service update channel');
  const target=manifest.opencraftExecution;
  if(!target||target.protocolVersion!==1||target.profile!=='daemon'||target.platform!==process.platform
    ||target.arch!==process.arch||String(target.nodeAbi)!==process.versions.modules)
    throw new Error('Use the complete package built for this operating system, architecture and Node version.');
}
