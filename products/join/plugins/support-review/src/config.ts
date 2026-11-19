import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

export interface ReviewConnection { socketPath: string; tokenFile: string }
export interface ReviewHandsConfiguration extends ReviewConnection { workerRoot: string; pythonExecutable: string; socketGid?: number }
async function privateFile(path: string, limit: number) {
  if (!isAbsolute(path)) throw Error('Invalid review private file');
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || info.mode & 0o077 || info.size > limit)
    throw Error('Review configuration must be private and owned by this service');
  return readFile(path, 'utf8');
}
export async function readReviewToken(path: string) {
  const value = (await privateFile(path, 4096)).trim();
  if (value.length < 32 || value.length > 512 || /\s/u.test(value)) throw Error('Invalid review token');
  return value;
}
export async function reviewConfiguration(role: 'gateway', env?: NodeJS.ProcessEnv): Promise<ReviewConnection | null>;
export async function reviewConfiguration(role: 'hands', env?: NodeJS.ProcessEnv): Promise<ReviewHandsConfiguration | null>;
export async function reviewConfiguration(role: 'gateway' | 'hands', env = process.env) {
  const path = env.OPENCRAFT_SUPPORT_REVIEW_CONFIG;
  if (!path) return null; // Opt-in product service; never fall back to Gateway execution.
  const value = JSON.parse(await privateFile(path, 16_384));
  const keys = role === 'hands' ? ['version', 'socketPath', 'tokenFile', 'workerRoot', 'pythonExecutable', 'socketGid'] : ['version', 'socketPath', 'tokenFile'];
  if (!value || Array.isArray(value) || value.version !== 1 || Object.keys(value).some(key => !keys.includes(key))
    || ![value.socketPath, value.tokenFile, ...(role === 'hands' ? [value.workerRoot, value.pythonExecutable] : [])]
      .every(path => typeof path === 'string' && isAbsolute(path) && path !== '/' && !path.includes('\0'))
    || (role === 'hands' && value.socketGid !== undefined && (!Number.isSafeInteger(value.socketGid) || value.socketGid < 0)))
    throw Error('Invalid support review configuration');
  return value as ReviewHandsConfiguration;
}
