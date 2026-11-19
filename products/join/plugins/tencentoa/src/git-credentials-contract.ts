export const GIT_CREDENTIALS_PATH = '/__opencraft_enterprise_identity/git-credentials';
export const GIT_HOSTS = ['git.woa.com', 'github.com'] as const;
export type EmployeeGitHost = typeof GIT_HOSTS[number];
export interface EmployeeGitStatus {
  revision: number; configured: boolean; tokenConfigured: boolean;
  identity: null | { username: string; name: string; email: string; accountId?: string };
  sshAuth: null | { generation: string; publicKey: string; fingerprint: string };
  signing: null | { generation: string; publicKey: string; fingerprint: string;
    registration: 'unregistered' | 'pending' | 'registered' | 'manual_required'; remoteKeyId?: number };
}
export interface EmployeeGitSnapshot { scope: string; gongfengMcp: { revision: number; configured: boolean }; hosts: Record<EmployeeGitHost, EmployeeGitStatus> }
export type EmployeeGitInput = { host: EmployeeGitHost; revision: number; action: 'save' | 'clear' | 'register' | 'save-mcp' | 'clear-mcp' | 'generate-ssh' | 'delete-ssh'; username?: string; name?: string; email?: string; token?: string };
