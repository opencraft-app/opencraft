import { IOA_ACCESS_PATH, type EmployeeAdmissionConfig, type EmployeeAdmissionDocument } from './admission-contract';

export class EmployeeAdmissionController {
  draft: EmployeeAdmissionConfig | null = null;
  constructor(readonly fetcher: typeof fetch) {}
  async request(body?: unknown): Promise<EmployeeAdmissionDocument & { allow?: boolean }> {
    const response = await this.fetcher(IOA_ACCESS_PATH, body === undefined ? {} : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const value = await response.json();
    if (!response.ok) throw Error(typeof value?.error === 'string' ? value.error : 'policy_failed');
    if (!value || typeof value !== 'object' || (body === undefined && (!value.server || typeof value.server.id !== 'string' || typeof value.canManage !== 'boolean'))) throw Error('policy_failed');
    return value;
  }
  dispose() { this.draft = null; }
}
