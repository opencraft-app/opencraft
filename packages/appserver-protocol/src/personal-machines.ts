import type { RuntimeMachineIdentity } from './machine';
export const PERSONAL_MACHINES_METHOD = 'opencraft/personal-machines';
export interface PersonalMachine {
  id: string;
  name: string;
  machine: RuntimeMachineIdentity | null;
  connected: boolean;
  phase: 'pending' | 'enrolled';
  expiresAt: number | null;
  version?: string | null;
  updateAvailable?: boolean | null;
  updateCommand?: string | null;
  updating?: boolean;
  updateError?: string | null;
}
export interface PersonalMachinesDirectory {
  hubId: string;
  ownerActorId: string;
  enrollmentOrigin: string | null;
  digest?: string;
  machines: PersonalMachine[];
}
export type PersonalMachineCommand = { action: 'list' } | { action: 'create' } | { action: 'revoke'; id: string } | { action: 'update'; id: string };
export interface PersonalMachinesMethodMap {
  'opencraft/personal-machines': { params: PersonalMachineCommand; result: PersonalMachinesDirectory & { command?: string; machineId?: string } };
}
