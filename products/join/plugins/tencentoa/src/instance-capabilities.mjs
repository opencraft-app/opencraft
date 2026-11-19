import { join } from 'node:path';
import { readPrivateJson } from '../../../../../packages/identity-core/src/node.ts';
import { EmployeeGitCredentialsService } from './git-credentials-server.ts';
import { GongfengExecutionCredentials, gongfengMcpProvider } from '../../../gongfeng-mcp.ts';
import { personalGitCapability } from '../../../personal-git-capability.ts';
import { createEmployeeCliAccess } from './employee-cli-access.mjs';

const disabled = Object.freeze({ employeeGit: false, gongfeng: false, employeeCli: false });
export function parseIoaCapabilities(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1
    || Object.keys(value).some(key => !['schemaVersion', ...Object.keys(disabled)].includes(key))
    || Object.keys(disabled).some(key => value[key] !== undefined && typeof value[key] !== 'boolean'))
    throw Error('Invalid IOA capabilities configuration');
  return Object.fromEntries(Object.keys(disabled).map(key => [key, value[key] ?? true]));
}

/** Compiled IOA capabilities; instance data selects features, not executable
 * modules or authorization grants. No NODE_OPTIONS/source rewriting required. */
export async function createIoaCapabilities(context, { vault, onDiagnostic = diagnostic => console.warn(JSON.stringify(diagnostic)) }) {
  let closed = false, configuration;
  const report = code => { try { onDiagnostic({ event: 'ioa_capability_unavailable', code }); } catch {} };
  try { configuration = parseIoaCapabilities(await readPrivateJson(join(context.dataDirectory, 'ioa-capabilities.json'))); }
  catch (error) {
    if (error?.code === 'ENOENT') configuration = parseIoaCapabilities({ schemaVersion: 1 });
    else { configuration = disabled; report('configuration_invalid'); }
  }
  const allowed = request => {
    if (closed) return false;
    const principal = context.resolveIdentity(request), access = context.getInstanceAccess();
    return principal?.provider === 'tencentoa' && principal.expiresAt > Date.now()
      && !!access && access.admissionStatus(request) === 204 && access.role(principal) !== null;
  };
  const capabilityProviders = [];
  let gitCredentials, cli, personalGit;
  if (configuration.employeeGit) try { gitCredentials = new EmployeeGitCredentialsService(vault, fetch, allowed); }
  catch { report('employee_git_unavailable'); }
  if (configuration.employeeGit && context.machineIdentity?.machineId) try {
    personalGit = personalGitCapability(context.dataDirectory, context.machineIdentity.machineId);
    if (personalGit) capabilityProviders.push(personalGit.provider);
  } catch { report('personal_git_unavailable'); }
  if (configuration.gongfeng) try {
    if (!context.actors || !context.machineIdentity?.machineId) throw Error('Missing authority');
    capabilityProviders.push(gongfengMcpProvider(new GongfengExecutionCredentials(context.dataDirectory, context.machineIdentity.machineId, vault, principal => {
      if (closed) return false;
      const actor = context.actors.findHuman(principal);
      return actor?.kind === 'human' && actor.enabled && context.getInstanceAccess()?.admitsActor(actor.id) === true;
    })));
  } catch { report('gongfeng_unavailable'); }
  if (context.sshIngressEnabled && configuration.employeeCli && context.actors) {
    cli = createEmployeeCliAccess({ path: join(context.dataDirectory, 'employee-ssh-credentials.sqlite'),
      actors: context.actors, getAccess: context.getInstanceAccess });
  }
  // Always supply a denying adapter when SSH ingress is enabled but optional
  // employee keys are disabled/unreadable. Employee authentication never
  // acquires a shared identity; separately configured static operator keys keep
  // their existing platform ingress policy.
  const sshAccess = context.sshIngressEnabled ? {
    publicKeys: username => closed ? [] : cli?.publicKeys(username) ?? [],
    authorize: (username, key) => closed ? null : cli?.authorize(username, key) ?? null,
  } : undefined;
  return { gitCredentials, capabilityProviders, sshAccess,
    close() { if (closed) return; closed = true; cli?.close(); void personalGit?.close().catch(() => {}); },
  };
}
